import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { CUSTOMER, TEST_CRON_SECRET, createClient, newKey, sign, signWebhook, startTestServer } from "./helpers.js";

let t;
before(async () => {
  t = await startTestServer();
});
after(() => t.close());
beforeEach(() => t.app.deps.limiter.reset());

async function checkout(client, opts = {}) {
  const key = opts.key || newKey();
  const r = await client.post("/api/checkout", { checkoutKey: key, customer: opts.customer || CUSTOMER, saveAddress: opts.saveAddress });
  return { ...r, key };
}

async function payAndVerify(client, co, { status = "captured" } = {}) {
  const rzpOrderId = co.body.razorpay.orderId;
  const payment = t.razorpay.pay(rzpOrderId, { status });
  return client.post("/api/payments/verify", {
    orderId: co.body.order.id,
    checkoutKey: co.key,
    razorpay_order_id: rzpOrderId,
    razorpay_payment_id: payment.id,
    razorpay_signature: sign(rzpOrderId, payment.id),
  });
}

async function webhook(event, entity, { id = `evt_${Math.random().toString(36).slice(2)}`, secret } = {}) {
  const body = JSON.stringify({ entity: "event", event, payload: { payment: { entity } } });
  const res = await fetch(`${t.base}/api/webhooks/razorpay`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Razorpay-Signature": signWebhook(body, secret), "X-Razorpay-Event-Id": id },
    body,
  });
  return { status: res.status, body: await res.json() };
}

describe("static files and catalogue", () => {
  test("only public/ is served; secrets and source are not", async () => {
    const c = t.client();
    assert.equal((await c.get("/")).status, 200);
    assert.equal((await c.get("/shop")).status, 200);
    const legacy = await c.get("/shop.html");
    assert.equal(legacy.status, 301);
    assert.equal(legacy.headers.get("location"), "/shop");
    assert.equal((await c.get("/assets/products/marquise-clover-pendant.jpg")).status, 200);
    for (const p of ["/.env", "/.env.example", "/package.json", "/lib/app.js", "/database/migrations/001_base.sql", "/.git/config", "/..%2Fpackage.json", "/%2e%2e/package.json"]) {
      assert.equal((await c.get(p)).status, 404, p);
    }
    const res = await c.get("/");
    assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  test("lists, searches, filters and shows product detail from the database", async () => {
    const c = t.client();
    const all = await c.get("/api/products");
    assert.equal(all.status, 200);
    assert.equal(all.body.total, 7);
    assert.deepEqual(all.body.collections.map((x) => x.slug), ["anklets", "necklaces", "sets"]);
    assert.ok(all.body.products.every((p) => !("stockQuantity" in p)), "exact stock not exposed");
    assert.equal((await c.get("/api/products?q=clover")).body.total, 2);
    assert.equal((await c.get("/api/products?category=necklaces&sort=price_desc")).body.products[0].id, "p06");
    const detail = await c.get("/api/products/daisy-bloom-set");
    assert.equal(detail.body.product.id, "p04");
    assert.equal(detail.body.product.availability.canBuy, false);
    assert.equal((await c.get("/api/products/does-not-exist")).status, 404);
    assert.equal((await c.get("/api/products/%3Cscript%3E")).status, 404);
  });

  test("settings report checkout blockers honestly", async () => {
    const s = await t.client().get("/api/settings");
    assert.equal(s.body.checkout.enabled, false);
    assert.ok(s.body.checkout.blockers.some((b) => b.code === "shipping_unconfigured"));
    assert.equal(s.body.settings.shippingPaise, null);
  });
});

describe("cart", () => {
  test("unconfirmed stock cannot be added to the bag", async () => {
    const r = await t.client().post("/api/cart/items", { productId: "p05", quantity: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "inventory_unconfirmed");
  });

  test("persistent guest cart, server-side prices, quantity limits", async () => {
    await t.setStock("p02", 3);
    const c = t.client();
    const add = await c.post("/api/cart/items", { productId: "p02", quantity: 2 });
    assert.equal(add.status, 200);
    assert.ok(c.jar.has("am_cart"), "guest cart cookie set");
    assert.equal(add.body.subtotalPaise, 2 * 37900);
    assert.equal((await c.post("/api/cart/items", { productId: "p02", quantity: 2 })).body.error, "insufficient_stock");
    assert.equal((await c.post("/api/cart/items", { productId: "p02", quantity: -1 })).status, 400);
    assert.equal((await c.post("/api/cart/items", { productId: "p02", quantity: 1.5 })).status, 400);
    const again = await c.get("/api/cart");
    assert.equal(again.body.count, 2);
    assert.equal((await c.put("/api/cart/items/p02", { quantity: 1 })).body.count, 1);
    assert.equal((await c.del("/api/cart/items/p02")).body.count, 0);
    // Another browser does not see this cart.
    assert.equal((await t.client().get("/api/cart")).body.count, 0);
  });

  test("cross-site and non-JSON writes are rejected", async () => {
    const c = t.client();
    const evil = await c.post("/api/cart/items", { productId: "p02", quantity: 1 }, { headers: { Origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
    const res = await fetch(`${t.base}/api/cart/items`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: '{"productId":"p02","quantity":1}' });
    assert.equal(res.status, 415);
  });
});

describe("checkout and payment", () => {
  test("checkout is blocked while shipping is unconfirmed", async () => {
    await t.setStock("p03", 5);
    const c = t.client();
    await c.post("/api/cart/items", { productId: "p03", quantity: 1 });
    const co = await checkout(c);
    assert.equal(co.status, 409);
    assert.equal(co.body.error, "shipping_unconfigured");
    assert.equal(await t.stockOf("p03"), 5, "nothing reserved");
  });

  test("full happy path: browse → bag → checkout → verified test payment → confirmation", async () => {
    await t.setShipping(5000); // test fixture value, not a business policy
    await t.setStock("p01", 3);
    const c = t.client();
    await c.post("/api/cart/items", { productId: "p01", quantity: 2 });

    const bad = await c.post("/api/checkout", { checkoutKey: newKey(), customer: { ...CUSTOMER, phone: "123" } });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.errors.phone);

    const co = await checkout(c);
    assert.equal(co.status, 200, JSON.stringify(co.body));
    assert.equal(co.body.order.totalPaise, 2 * 19900 + 5000);
    assert.equal(co.body.razorpay.amount, co.body.order.totalPaise);
    assert.equal(co.body.razorpay.keyId, "rzp_test_fixture000");
    assert.ok(!JSON.stringify(co.body).includes("test_key_secret_fixture"), "secret never sent");
    assert.equal(await t.stockOf("p01"), 1, "stock reserved atomically");
    assert.equal(t.razorpay.order(co.body.razorpay.orderId).amount, co.body.order.totalPaise);

    // Forged signature is rejected and nothing is marked paid.
    const forged = await c.post("/api/payments/verify", {
      orderId: co.body.order.id, checkoutKey: co.key, razorpay_order_id: co.body.razorpay.orderId,
      razorpay_payment_id: "pay_forged123456", razorpay_signature: "a".repeat(64),
    });
    assert.equal(forged.status, 400);
    assert.equal((await t.orderRow(co.body.order.id)).payment_status, "pending");

    const ok = await payAndVerify(c, co);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, "paid");
    assert.equal(ok.body.order.paymentStatus, "paid");
    assert.equal(ok.body.order.fulfilmentStatus, "confirmed");
    assert.equal(await t.stockOf("p01"), 1, "stock stays deducted");
    assert.equal((await c.get("/api/cart")).body.count, 0, "bag cleared after payment");

    // Confirmation needs the checkout key; others get 404.
    const view = await c.get(`/api/orders/${co.body.order.id}`, { headers: { "X-Order-Key": co.key } });
    assert.equal(view.body.order.publicRef, co.body.order.publicRef);
    assert.equal(view.body.order.address.pin, CUSTOMER.pin);
    assert.equal((await t.client().get(`/api/orders/${co.body.order.id}`)).status, 404);
    assert.equal((await t.client().get(`/api/orders/${co.body.order.id}`, { headers: { "X-Order-Key": newKey() } })).status, 404);

    // Guest tracking by reference + email shows status but not the address.
    const look = await t.client().post("/api/orders/lookup", { ref: co.body.order.publicRef, email: CUSTOMER.email.toUpperCase() });
    assert.equal(look.status, 200);
    assert.equal(look.body.order.paymentStatus, "paid");
    assert.equal(look.body.order.address, undefined);
    assert.equal((await t.client().post("/api/orders/lookup", { ref: co.body.order.publicRef, email: "other@example.test" })).status, 404);

    // Verifying twice is idempotent.
    const payments = await t.db.pg.query("SELECT count(*)::int n FROM payment_transactions WHERE order_id = $1 AND status = 'paid'", [co.body.order.id]);
    assert.equal(payments.rows[0].n, 1);
  });

  test("same checkout key is idempotent: one order, one reservation, one Razorpay order", async () => {
    await t.setStock("p06", 4);
    const c = t.client();
    await c.post("/api/cart/items", { productId: "p06", quantity: 1 });
    const key = newKey();
    const before = t.razorpay.calls.length;
    const [a, b] = await Promise.all([checkout(c, { key }), checkout(c, { key })]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.order.id, b.body.order.id);
    assert.equal(a.body.razorpay.orderId, b.body.razorpay.orderId);
    assert.equal(await t.stockOf("p06"), 3);
    assert.ok(t.razorpay.calls.length - before <= 2);
  });

  test("no overselling: concurrent checkouts for the last piece", async () => {
    await t.setStock("p07", 1);
    const buyers = [t.client(), t.client(), t.client()];
    for (const b of buyers) assert.equal((await b.post("/api/cart/items", { productId: "p07", quantity: 1 })).status, 200);
    const results = await Promise.all(buyers.map((b) => checkout(b)));
    const ok = results.filter((r) => r.status === 200);
    const sold = results.filter((r) => r.body?.error === "insufficient_stock");
    assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.body?.error || r.status)));
    assert.equal(sold.length, 2);
    assert.equal(await t.stockOf("p07"), 0);
  });

  test("a payment for one order cannot finalize another order", async () => {
    await t.setStock("p02", 5);
    const alice = t.client();
    const mallory = t.client();
    await alice.post("/api/cart/items", { productId: "p02", quantity: 3 });
    await mallory.post("/api/cart/items", { productId: "p02", quantity: 1 });
    const big = await checkout(alice);
    const small = await checkout(mallory);
    const p = t.razorpay.pay(small.body.razorpay.orderId);
    // Mallory replays her valid small payment against Alice's order id + her own key.
    const attack = await mallory.post("/api/payments/verify", {
      orderId: big.body.order.id, checkoutKey: small.key,
      razorpay_order_id: small.body.razorpay.orderId, razorpay_payment_id: p.id,
      razorpay_signature: sign(small.body.razorpay.orderId, p.id),
    });
    assert.equal(attack.status, 404);
    // Even with Alice's key, the Razorpay order id must match the stored one.
    const attack2 = await mallory.post("/api/payments/verify", {
      orderId: big.body.order.id, checkoutKey: big.key,
      razorpay_order_id: small.body.razorpay.orderId, razorpay_payment_id: p.id,
      razorpay_signature: sign(small.body.razorpay.orderId, p.id),
    });
    assert.equal(attack2.status, 400);
    assert.equal(attack2.body.error, "order_mismatch");
    assert.equal((await t.orderRow(big.body.order.id)).payment_status, "pending");
    // Underpayment on the right order is rejected by the amount check.
    const under = t.razorpay.pay(big.body.razorpay.orderId, { amount: 100 });
    const r = await alice.post("/api/payments/verify", {
      orderId: big.body.order.id, checkoutKey: big.key, razorpay_order_id: big.body.razorpay.orderId,
      razorpay_payment_id: under.id, razorpay_signature: sign(big.body.razorpay.orderId, under.id),
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "amount_mismatch");
    const row = await t.orderRow(big.body.order.id);
    assert.equal(row.payment_status, "pending");
    assert.equal(row.needs_review, true);
  });

  test("authorized (not yet captured) payment is not reported as paid", async () => {
    await t.setStock("p04", 2);
    const c = t.client();
    await c.post("/api/cart/items", { productId: "p04", quantity: 1 });
    const co = await checkout(c);
    const r = await payAndVerify(c, co, { status: "authorized" });
    assert.equal(r.status, 202);
    assert.equal(r.body.status, "authorized");
    assert.equal((await t.orderRow(co.body.order.id)).payment_status, "authorized");
  });

  test("gateway outage releases the reservation and charges nothing", async () => {
    await t.setStock("p05", 2);
    const c = t.client();
    await c.post("/api/cart/items", { productId: "p05", quantity: 2 });
    t.razorpay.failCreate = true;
    try {
      const co = await checkout(c);
      assert.equal(co.status, 502);
      assert.equal(await t.stockOf("p05"), 2);
    } finally {
      t.razorpay.failCreate = false;
    }
  });
});

describe("webhooks, cancel and reconciliation", () => {
  test("webhook: signature required, captured → paid, duplicates ignored, failure keeps reservation", async () => {
    await t.setStock("p03", 10);
    const c = t.client();
    await c.post("/api/cart/items", { productId: "p03", quantity: 2 });
    const co = await checkout(c);
    const stockAfterReserve = await t.stockOf("p03");

    const failed = { id: "pay_failedattempt01", order_id: co.body.razorpay.orderId, amount: co.body.order.totalPaise, currency: "INR", status: "failed", error_description: "Card declined" };
    assert.equal((await webhook("payment.failed", failed, { secret: "wrong" })).status, 400);
    const f = await webhook("payment.failed", failed);
    assert.equal(f.body.result, "failed_logged");
    assert.equal(await t.stockOf("p03"), stockAfterReserve, "failed attempt does not release stock");
    assert.equal((await t.orderRow(co.body.order.id)).payment_status, "pending");

    const p = t.razorpay.pay(co.body.razorpay.orderId);
    const w = await webhook("payment.captured", p, { id: "evt_capture_1" });
    assert.equal(w.status, 200);
    assert.equal(w.body.result, "paid");
    assert.equal((await t.orderRow(co.body.order.id)).payment_status, "paid");
    const dup = await webhook("payment.captured", p, { id: "evt_capture_1" });
    assert.equal(dup.body.duplicate, true);
    // Client verify after webhook is idempotent.
    const v = await c.post("/api/payments/verify", {
      orderId: co.body.order.id, checkoutKey: co.key, razorpay_order_id: p.order_id,
      razorpay_payment_id: p.id, razorpay_signature: sign(p.order_id, p.id),
    });
    assert.equal(v.body.status, "paid");
    assert.equal(await t.stockOf("p03"), stockAfterReserve);
  });

  test("webhook with wrong amount is rejected and flagged", async () => {
    await t.setStock("p03", 10);
    const c = t.client();
    await c.post("/api/cart/items", { productId: "p03", quantity: 1 });
    const co = await checkout(c);
    const w = await webhook("payment.captured", { id: "pay_wrongamount001", order_id: co.body.razorpay.orderId, amount: 1, currency: "INR", status: "captured" });
    assert.equal(w.body.result, "rejected:amount_mismatch");
    const row = await t.orderRow(co.body.order.id);
    assert.equal(row.payment_status, "pending");
    assert.equal(row.needs_review, true);
  });

  test("cancel releases stock, but not if Razorpay already captured", async () => {
    await t.setStock("p06", 5);
    const c = t.client();
    await c.post("/api/cart/items", { productId: "p06", quantity: 2 });
    const co = await checkout(c);
    assert.equal(await t.stockOf("p06"), 3);
    assert.equal((await t.client().post("/api/checkout/cancel", { orderId: co.body.order.id, checkoutKey: newKey() })).status, 404);
    const r = await c.post("/api/checkout/cancel", { orderId: co.body.order.id, checkoutKey: co.key });
    assert.equal(r.body.status, "cancelled");
    assert.equal(await t.stockOf("p06"), 5);

    // The bag survives a cancelled checkout; buy just one this time.
    assert.equal((await c.put("/api/cart/items/p06", { quantity: 1 })).body.count, 1);
    const co2 = await checkout(c);
    t.razorpay.pay(co2.body.razorpay.orderId); // paid, but browser callback never arrived
    const r2 = await c.post("/api/checkout/cancel", { orderId: co2.body.order.id, checkoutKey: co2.key });
    assert.equal(r2.body.status, "paid");
    assert.equal(await t.stockOf("p06"), 4);
  });

  test("expired reservations are released by the scheduler; late payment re-reserves or goes on hold", async () => {
    await t.setStock("p01", 1);
    const c = t.client();
    await c.post("/api/cart/items", { productId: "p01", quantity: 1 });
    const co = await checkout(c);
    assert.equal(co.status, 200, JSON.stringify(co.body));
    assert.equal(await t.stockOf("p01"), 0);
    await t.db.pg.query("UPDATE orders SET reservation_expires_at = now() - interval '1 minute' WHERE id = $1", [co.body.order.id]);

    assert.equal((await t.client().post("/api/internal/reconcile", {})).status, 401);
    const res = await fetch(`${t.base}/api/internal/reconcile`, { headers: { Authorization: `Bearer ${TEST_CRON_SECRET}` } });
    const summary = await res.json();
    assert.ok(summary.released >= 1, JSON.stringify(summary));
    assert.equal((await t.orderRow(co.body.order.id)).payment_status, "expired");
    assert.equal(await t.stockOf("p01"), 1);

    // Someone else buys the last piece, then the expired order's payment lands.
    const other = t.client();
    await other.post("/api/cart/items", { productId: "p01", quantity: 1 });
    assert.equal((await checkout(other)).status, 200);
    const late = t.razorpay.pay(co.body.razorpay.orderId);
    const w = await webhook("payment.captured", late);
    assert.equal(w.body.result, "paid_needs_review");
    const row = await t.orderRow(co.body.order.id);
    assert.equal(row.payment_status, "paid");
    assert.equal(row.fulfilment_status, "on_hold");
    assert.equal(await t.stockOf("p01"), 0, "never oversold");
  });

  test("scheduler does not release when Razorpay cannot be reached", async () => {
    await t.setStock("p02", 9);
    const c = t.client();
    await c.post("/api/cart/items", { productId: "p02", quantity: 1 });
    const co = await checkout(c);
    await t.db.pg.query("UPDATE orders SET reservation_expires_at = now() - interval '1 minute' WHERE id = $1", [co.body.order.id]);
    t.razorpay.failFetch = true;
    try {
      await fetch(`${t.base}/api/internal/reconcile`, { method: "POST", headers: { Authorization: `Bearer ${TEST_CRON_SECRET}` } });
      assert.equal((await t.orderRow(co.body.order.id)).payment_status, "pending");
    } finally {
      t.razorpay.failFetch = false;
    }
  });
});

describe("accounts", () => {
  test("register, session cookie, profile, addresses, wishlist, cart merge, order history", async () => {
    const c = t.client();
    assert.equal((await c.get("/api/account")).status, 401);
    assert.equal((await c.post("/api/auth/register", { email: "short@example.test", password: "123" })).status, 400);

    // Guest adds to bag before signing up.
    await t.setStock("p04", 6);
    await c.post("/api/cart/items", { productId: "p04", quantity: 1 });

    const reg = await c.post("/api/auth/register", { email: "Asha@Example.test", password: "correct horse battery", fullName: "Asha Test" });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const cookie = reg.headers.getSetCookie().find((x) => x.startsWith("am_at="));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.equal((await c.get("/api/auth/me")).body.user.email, "asha@example.test");
    assert.equal((await c.get("/api/cart")).body.count, 1, "guest bag merged");
    // Registering an existing email doesn't reveal that it exists and never signs anyone in.
    const dup = await createClient(t.base).post("/api/auth/register", { email: "asha@example.test", password: "another password" });
    assert.equal(dup.status, 201);
    assert.equal(dup.body.user, null);
    assert.equal(dup.body.needsConfirmation, true);
    assert.ok(!dup.headers.getSetCookie().some((x) => x.startsWith("am_at=")), "no session for a duplicate sign-up");

    assert.equal((await c.put("/api/account/profile", { fullName: "Asha T", phone: "98765 43210" })).body.profile.phone, "9876543210");
    const addr = await c.post("/api/account/addresses", { fullName: "Asha T", phone: "9876543210", line: "1 Lane", locality: "Area", city: "Pune", state: "Maharashtra", pin: "411001" });
    assert.equal(addr.status, 201);
    assert.equal(addr.body.addresses[0].isDefault, true);
    assert.equal((await c.post("/api/account/addresses", { fullName: "A", phone: "1", line: "", locality: "", city: "", state: "", pin: "x" })).status, 400);
    const id = addr.body.addresses[0].id;
    assert.equal((await c.put(`/api/account/addresses/${id}`, { ...addr.body.addresses[0], city: "Mumbai" })).body.addresses[0].city, "Mumbai");

    // Another user cannot touch this address.
    const eve = t.client();
    await eve.post("/api/auth/register", { email: "eve@example.test", password: "eve password 1" });
    assert.equal((await eve.put(`/api/account/addresses/${id}`, { ...addr.body.addresses[0], city: "X" })).status, 404);
    assert.equal((await eve.del(`/api/account/addresses/${id}`)).body.addresses.length, 0);
    assert.equal((await c.get("/api/account")).body.addresses.length, 1);

    assert.equal((await c.put("/api/wishlist/p05")).body.products.length, 1);
    assert.equal((await c.put("/api/wishlist/nope")).status, 409);
    assert.equal((await c.del("/api/wishlist/p05")).body.products.length, 0);

    const co = await checkout(c, { customer: { ...CUSTOMER, email: "asha@example.test" } });
    assert.equal(co.status, 200, JSON.stringify(co.body));
    await payAndVerify(c, co);
    const mine = await c.get("/api/account/orders");
    assert.equal(mine.body.orders.length, 1);
    assert.equal(mine.body.orders[0].paymentStatus, "paid");
    // Signed-in owner can open the order without the checkout key.
    assert.equal((await c.get(`/api/orders/${co.body.order.id}`)).status, 200);
    assert.equal((await eve.get(`/api/orders/${co.body.order.id}`)).status, 404);
    assert.equal((await eve.get("/api/account/orders")).body.orders.length, 0);

    await c.post("/api/auth/logout", {});
    assert.equal((await c.get("/api/auth/me")).body.user, null);
    const bad = await c.post("/api/auth/login", { email: "asha@example.test", password: "wrong password" });
    assert.equal(bad.status, 401);
    assert.equal((await c.post("/api/auth/login", { email: "asha@example.test", password: "correct horse battery" })).status, 200);
  });
});

describe("rate limiting", () => {
  test("order lookup is rate limited", async () => {
    const c = t.client();
    let last;
    for (let i = 0; i < 11; i++) last = await c.post("/api/orders/lookup", { ref: "AM-00000000", email: "x@example.test" });
    assert.equal(last.status, 429);
    assert.ok(last.headers.get("retry-after"));
  });
});

describe("without payment credentials", () => {
  let u;
  before(async () => {
    u = await startTestServer({ payments: false, webhook: false });
  });
  after(() => u.close());

  test("checkout refuses to start and nothing is reserved; webhook refuses", async () => {
    await u.setShipping(0);
    await u.setStock("p01", 2);
    const c = u.client();
    await c.post("/api/cart/items", { productId: "p01", quantity: 1 });
    const r = await c.post("/api/checkout", { checkoutKey: newKey(), customer: CUSTOMER });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "payments_not_configured");
    assert.equal(await u.stockOf("p01"), 2);
    const w = await fetch(`${u.base}/api/webhooks/razorpay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(w.status, 503);
  });
});
