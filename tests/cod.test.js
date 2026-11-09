import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { CUSTOMER, TEST_CRON_SECRET, newKey, startTestServer } from "./helpers.js";

// A store with NO Razorpay credentials: COD must work on its own.
let t, owner, manager;
before(async () => {
  t = await startTestServer({ payments: false, webhook: false });
  owner = await t.adminClient("cod-owner@example.test", "owner");
  manager = await t.adminClient("cod-manager@example.test", "manager");
});
after(() => t.close());
beforeEach(() => t.app.deps.limiter.reset());

const enableCod = (on = true) => owner.put("/api/admin/settings", { codEnabled: on });
async function codCheckout(client, { key = newKey(), customer = CUSTOMER, paymentMethod = "cod" } = {}) {
  const r = await client.post("/api/checkout", { checkoutKey: key, customer, paymentMethod });
  return { ...r, key };
}
async function bagWith(productId, quantity) {
  const c = t.client();
  const r = await c.post("/api/cart/items", { productId, quantity });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}
const row = async (id) => (await t.db.pg.query("SELECT payment_method, payment_status, fulfilment_status, reservation_expires_at, total_paise, stock_released FROM orders WHERE id = $1", [id])).rows[0];

describe("checkout stays blocked until the business is set up", () => {
  test("no payment method, no shipping → blocked and nothing reserved", async () => {
    const s = (await t.client().get("/api/settings")).body.checkout;
    assert.equal(s.enabled, false);
    assert.deepEqual(s.methods, { razorpay: false, cod: false });
    assert.ok(s.blockers.some((b) => b.code === "no_payment_method"));
    assert.ok(s.blockers.some((b) => b.code === "shipping_unconfigured"));

    await t.setStock("p02", 4);
    const c = await bagWith("p02", 1);
    const r = await codCheckout(c);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "cod_unavailable");
    assert.equal(await t.stockOf("p02"), 4, "nothing reserved");
  });

  test("COD switched on but shipping unconfirmed → still blocked", async () => {
    assert.equal((await manager.put("/api/admin/settings", { codEnabled: true })).status, 403, "only the owner can enable COD");
    assert.equal((await enableCod()).body.settings.codEnabled, true);
    const s = (await t.client().get("/api/settings")).body.checkout;
    assert.deepEqual(s.methods, { razorpay: false, cod: true });
    assert.ok(!s.blockers.some((b) => b.code === "no_payment_method"));
    assert.ok(s.blockers.some((b) => b.code === "shipping_unconfigured"));
    const c = await bagWith("p02", 1);
    const r = await codCheckout(c);
    assert.equal(r.body.error, "shipping_unconfigured");
    assert.equal(await t.stockOf("p02"), 4);
  });

  test("unconfirmed inventory can't be bought by COD", async () => {
    await t.setShipping(5000); // test fixture value
    const r = await t.client().post("/api/cart/items", { productId: "p05", quantity: 1 });
    assert.equal(r.body.error, "inventory_unconfirmed");
    assert.equal((await t.client().get("/api/settings")).body.checkout.enabled, true, "set up now: COD + shipping");
  });

  test("online payment stays unavailable without Razorpay keys", async () => {
    const c = await bagWith("p02", 1);
    const r = await codCheckout(c, { paymentMethod: "razorpay" });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "payments_not_configured");
    assert.equal((await codCheckout(c, { paymentMethod: "cash" })).status, 400, "unknown method rejected");
  });
});

describe("placing COD orders", () => {
  test("success: server-side price, shipping and total; stock committed; bag cleared; COD/Pending saved", async () => {
    await enableCod();
    await t.setShipping(5000);
    await t.setStock("p01", 3);
    const c = await bagWith("p01", 2);
    // Client-supplied prices are ignored; the server prices from the database.
    const r = await codCheckout(c, { customer: { ...CUSTOMER, totalPaise: 1, pricePaise: 1 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "placed");
    const o = r.body.order;
    assert.equal(o.paymentMethod, "cod");
    assert.equal(o.paymentStatus, "pending");
    assert.equal(o.paymentStatusLabel, "Cash on delivery — pay when it arrives");
    assert.equal(o.fulfilmentStatus, "pending");
    assert.equal(o.subtotalPaise, 2 * 19900);
    assert.equal(o.shippingPaise, 5000);
    assert.equal(o.totalPaise, 2 * 19900 + 5000);
    assert.equal(o.reservationExpiresAt, null);
    assert.equal(await t.stockOf("p01"), 1);
    const db = await row(o.id);
    assert.equal(db.payment_method, "cod");
    assert.equal(db.reservation_expires_at, null, "COD orders never expire");
    assert.equal((await c.get("/api/cart")).body.count, 0, "bag cleared");

    // Customer views: confirmation (with key) and guest tracking.
    const view = await c.get(`/api/orders/${o.id}`, { headers: { "X-Order-Key": r.key } });
    assert.equal(view.body.order.paymentMethod, "cod");
    const look = await t.client().post("/api/orders/lookup", { ref: o.publicRef, email: CUSTOMER.email });
    assert.equal(look.body.order.paymentStatusLabel, "Cash on delivery — pay when it arrives");
    assert.ok((await t.db.pg.query("SELECT 1 FROM inventory_movements WHERE order_id = $1 AND reason LIKE 'Sold (COD)%'", [o.id])).rows.length);
  });

  test("validation failures reserve nothing", async () => {
    await t.setStock("p03", 2);
    const c = await bagWith("p03", 1);
    const bad = await codCheckout(c, { customer: { ...CUSTOMER, phone: "12345", pin: "0000" } });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.errors.phone && bad.body.errors.pin);
    assert.equal((await codCheckout(c, { key: "short" })).status, 400);
    assert.equal(await t.stockOf("p03"), 2);
    assert.equal((await codCheckout(t.client())).body.error, "empty_cart");
  });

  test("duplicate submits create exactly one order and take stock once", async () => {
    await t.setStock("p04", 5);
    const c = await bagWith("p04", 2);
    const key = newKey();
    const [a, b] = await Promise.all([codCheckout(c, { key }), codCheckout(c, { key })]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.order.id, b.body.order.id);
    assert.equal(await t.stockOf("p04"), 3);
    const again = await codCheckout(c, { key });
    assert.equal(again.body.order.id, a.body.order.id);
    assert.equal((await t.db.pg.query("SELECT count(*)::int n FROM orders WHERE client_token IS NOT NULL AND id = $1", [a.body.order.id])).rows[0].n, 1);
  });

  test("insufficient stock: last piece, concurrent COD buyers → one order, never oversold", async () => {
    await t.setStock("p07", 1);
    const buyers = [await bagWith("p07", 1), await bagWith("p07", 1), await bagWith("p07", 1)];
    const results = await Promise.all(buyers.map((b) => codCheckout(b)));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.body.error === "insufficient_stock").length, 2);
    assert.equal(await t.stockOf("p07"), 0);
    assert.equal((await t.client().post("/api/cart/items", { productId: "p07", quantity: 1 })).body.error, "insufficient_stock");
  });

  test("COD orders are not released by the reservation sweep", async () => {
    await t.setStock("p06", 2);
    const c = await bagWith("p06", 1);
    const r = await codCheckout(c);
    const res = await fetch(`${t.base}/api/internal/reconcile`, { headers: { Authorization: `Bearer ${TEST_CRON_SECRET}` } });
    assert.equal(res.status, 200);
    assert.equal((await row(r.body.order.id)).payment_status, "pending");
    assert.equal(await t.stockOf("p06"), 1);
  });

  test("customers can't self-cancel a COD order", async () => {
    await t.setStock("p06", 2);
    const c = await bagWith("p06", 1);
    const r = await codCheckout(c);
    const cancel = await c.post("/api/checkout/cancel", { orderId: r.body.order.id, checkoutKey: r.key });
    assert.equal(cancel.status, 409);
    assert.equal(cancel.body.error, "cod_cancel_contact");
    assert.equal((await row(r.body.order.id)).payment_status, "pending");
  });

  test("COD can be switched off again", async () => {
    await enableCod(false);
    await t.setStock("p02", 4);
    const c = await bagWith("p02", 1);
    assert.equal((await codCheckout(c)).body.error, "cod_unavailable");
    await enableCod(true);
  });
});

describe("admin order management for COD", () => {
  test("listed with method, confirmed → processing → shipped → delivered, then cash recorded by the owner", async () => {
    await enableCod();
    await t.setStock("p01", 5);
    const c = await bagWith("p01", 1);
    const { body } = await codCheckout(c);
    const id = body.order.id;

    const list = await manager.get("/api/admin/orders?method=cod");
    assert.ok(list.body.orders.every((o) => o.paymentMethod === "cod"));
    assert.ok(list.body.orders.some((o) => o.id === id));
    const before = (await owner.get("/api/admin/overview")).body.orders;
    assert.ok(before.codToCollect >= 1);
    assert.ok(before.toFulfil >= 1);

    for (const status of ["confirmed", "processing"]) {
      const r = await manager.post(`/api/admin/orders/${id}/fulfilment`, { status });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.order.paymentStatus, "pending", "status change never marks COD paid");
    }
    const shipped = await manager.post(`/api/admin/orders/${id}/fulfilment`, { status: "shipped", courier: "Test Courier", trackingNumber: "COD123" });
    assert.equal(shipped.body.order.fulfilmentStatus, "shipped");
    assert.equal((await owner.post(`/api/admin/orders/${id}/cancel`, {})).body.error, "cod_already_shipped");
    assert.equal((await owner.post(`/api/admin/orders/${id}/cod-collected`, { note: "too early" })).body.error, "cod_not_delivered");
    assert.equal((await manager.post(`/api/admin/orders/${id}/fulfilment`, { status: "delivered" })).body.order.fulfilmentStatus, "delivered");

    assert.equal((await manager.post(`/api/admin/orders/${id}/cod-collected`, { note: "cash" })).status, 403, "owner only");
    assert.equal((await owner.post(`/api/admin/orders/${id}/cod-collected`, { note: "" })).status, 400);
    const paid = await owner.post(`/api/admin/orders/${id}/cod-collected`, { note: "Courier remittance REF-1" });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.order.paymentStatus, "paid");
    assert.equal(paid.body.order.paymentStatusLabel, "Paid (cash on delivery)");
    assert.ok(paid.body.order.payments.some((p) => p.source === "cod_collected" && p.amountPaise === body.order.totalPaise));
    assert.ok(paid.body.order.history.some((h) => h.action === "order.cod_collected"));
    assert.equal((await owner.post(`/api/admin/orders/${id}/cod-collected`, { note: "again" })).body.error, "cod_not_pending");
    assert.equal((await owner.get("/api/admin/overview")).body.orders.codToCollect, before.codToCollect - 1);
  });

  test("cancel before shipping returns stock; online-only actions refuse COD orders", async () => {
    await t.setStock("p03", 4);
    const c = await bagWith("p03", 2);
    const { body } = await codCheckout(c);
    const id = body.order.id;
    assert.equal(await t.stockOf("p03"), 2);
    await manager.post(`/api/admin/orders/${id}/fulfilment`, { status: "confirmed" });
    assert.equal((await owner.post(`/api/admin/orders/${id}/refund`, { amountPaise: 100, reason: "test" })).status, 503, "no gateway refund for COD");
    const cancelled = await manager.post(`/api/admin/orders/${id}/cancel`, {});
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.order.paymentStatus, "cancelled");
    assert.equal(cancelled.body.order.fulfilmentStatus, "cancelled");
    assert.equal(await t.stockOf("p03"), 4, "stock returned once");
    assert.equal((await manager.post(`/api/admin/orders/${id}/fulfilment`, { status: "processing" })).body.error, "order_not_paid");
  });
});

describe("COD alongside Razorpay (test mode)", () => {
  let u;
  before(async () => { u = await startTestServer(); });
  after(() => u.close());

  test("both methods offered; online checkout unchanged; COD orders can't be 'paid' via Razorpay verify", async () => {
    const own = await u.adminClient("both-owner@example.test", "owner");
    await own.put("/api/admin/settings", { codEnabled: true });
    await u.setShipping(0);
    await u.setStock("p01", 5);
    assert.deepEqual((await u.client().get("/api/settings")).body.checkout.methods, { razorpay: true, cod: true });

    const online = u.client();
    await online.post("/api/cart/items", { productId: "p01", quantity: 1 });
    const r1 = await online.post("/api/checkout", { checkoutKey: newKey(), customer: CUSTOMER }); // no method → Razorpay (unchanged)
    assert.equal(r1.body.status, "pending");
    assert.ok(r1.body.razorpay.orderId.startsWith("order_"));
    assert.equal(r1.body.order.paymentMethod, "razorpay");

    const codBuyer = u.client();
    await codBuyer.post("/api/cart/items", { productId: "p01", quantity: 1 });
    const key = newKey();
    const r2 = await codBuyer.post("/api/checkout", { checkoutKey: key, customer: CUSTOMER, paymentMethod: "cod" });
    assert.equal(r2.body.status, "placed");
    assert.equal(r2.body.razorpay, undefined, "no gateway order for COD");
    assert.equal(u.razorpay.calls.filter((c) => c[0] === "createOrder").length, 1, "only the online order hit Razorpay");
    const v = await codBuyer.post("/api/payments/verify", {
      orderId: r2.body.order.id, checkoutKey: key, razorpay_order_id: r1.body.razorpay.orderId,
      razorpay_payment_id: "pay_fakefakefake01", razorpay_signature: "a".repeat(64),
    });
    assert.equal(v.status, 400);
    assert.equal(v.body.error, "order_mismatch");
    assert.equal((await u.db.pg.query("SELECT payment_status FROM orders WHERE id = $1", [r2.body.order.id])).rows[0].payment_status, "pending");
  });
});
