import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { CUSTOMER, PNG_1PX, newKey, sign, signWebhook, startTestServer } from "./helpers.js";

let t, owner, manager;
before(async () => {
  t = await startTestServer();
  owner = await t.adminClient("owner@example.test", "owner");
  manager = await t.adminClient("manager@example.test", "manager");
});
after(() => t.close());
beforeEach(() => t.app.deps.limiter.reset());

async function paidOrder({ productId = "p02", qty = 1 } = {}) {
  await t.setShipping(5000);
  const stock = await t.stockOf(productId);
  if (!Number.isInteger(stock) || stock < qty) await t.setStock(productId, (stock || 0) + qty + 2);
  const c = t.client();
  await c.post("/api/cart/items", { productId, quantity: qty });
  const key = newKey();
  const co = await c.post("/api/checkout", { checkoutKey: key, customer: CUSTOMER });
  assert.equal(co.status, 200, JSON.stringify(co.body));
  const p = t.razorpay.pay(co.body.razorpay.orderId);
  const v = await c.post("/api/payments/verify", {
    orderId: co.body.order.id, checkoutKey: key, razorpay_order_id: p.order_id,
    razorpay_payment_id: p.id, razorpay_signature: sign(p.order_id, p.id),
  });
  assert.equal(v.body.status, "paid");
  return { order: v.body.order, payment: p, client: c, key };
}

describe("admin authorization", () => {
  const endpoints = [
    ["get", "/api/admin/overview"], ["get", "/api/admin/products"], ["get", "/api/admin/orders"],
    ["get", "/api/admin/inventory"], ["get", "/api/admin/customers"], ["get", "/api/admin/settings"],
    ["get", "/api/admin/audit"], ["post", "/api/admin/products"], ["post", "/api/admin/inventory/adjust"],
    ["put", "/api/admin/settings"],
  ];

  test("anonymous visitors are rejected by every admin endpoint", async () => {
    const anon = t.client();
    for (const [m, p] of endpoints) {
      const r = await anon[m](p, m === "get" ? undefined : {});
      assert.equal(r.status, 401, `${m} ${p} → ${r.status}`);
    }
  });

  test("signed-in customers without a role are rejected (403), even with the admin UI hidden", async () => {
    const shopper = t.client();
    await shopper.post("/api/auth/register", { email: "shopper@example.test", password: "shopper password" });
    for (const [m, p] of endpoints) {
      const r = await shopper[m](p, m === "get" ? undefined : {});
      assert.equal(r.status, 403, `${m} ${p} → ${r.status}`);
    }
    const login = await t.client().post("/api/admin/login", { email: "shopper@example.test", password: "shopper password" });
    assert.equal(login.status, 403);
  });

  test("managers cannot use owner-only actions", async () => {
    assert.equal((await manager.put("/api/admin/settings", { storeName: "X" })).status, 403);
    assert.equal((await manager.get("/api/admin/audit")).status, 403);
    assert.equal((await manager.get("/api/admin/customer?email=a@b.test")).status, 403);
    assert.equal((await manager.post(`/api/admin/orders/${crypto.randomUUID()}/refund`, { amountPaise: 1, reason: "test" })).status, 403);
    assert.equal((await manager.del("/api/admin/products/p01")).status, 403);
    assert.equal((await manager.get("/api/admin/overview")).status, 200);
  });

  test("login, me, logout; bad password and cross-site requests refused", async () => {
    const c = t.client();
    assert.equal((await c.post("/api/admin/login", { email: "owner@example.test", password: "wrong password" })).status, 401);
    const ok = await c.post("/api/admin/login", { email: "owner@example.test", password: "admin test password" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.admin.role, "owner");
    assert.equal((await c.get("/api/admin/me")).body.admin.email, "owner@example.test");
    const evil = await c.post("/api/admin/products", { name: "x" }, { headers: { Origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
    await c.post("/api/auth/logout", {});
    assert.equal((await c.get("/api/admin/me")).status, 401);
    const audit = await owner.get("/api/admin/audit?entity=admin");
    assert.ok(audit.body.entries.some((e) => e.action === "admin.login_failed"));
    assert.ok(audit.body.entries.some((e) => e.action === "admin.login"));
  });

  test("admin pages are served with noindex", async () => {
    const r = await t.client().get("/admin/");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("x-robots-tag"), /noindex/);
  });
});

describe("products, variants and images", () => {
  test("create, validate, edit, archive, restore, delete", async () => {
    const bad = await owner.post("/api/admin/products", { name: "X", slug: "Bad Slug!", description: "", category: "", pricePaise: -5 });
    assert.equal(bad.status, 400);

    const created = await owner.post("/api/admin/products", { name: "Test Ring", slug: "test-ring", description: "A test product.", category: "Rings", pricePaise: 29900, featured: true });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.product.id;
    assert.equal(created.body.product.inventoryConfirmed, false, "new products start with unconfirmed stock");
    assert.equal((await owner.post("/api/admin/products", { name: "Dup", slug: "test-ring", description: "d", category: "Rings", pricePaise: 1 })).status, 409);

    const xss = '<img src=x onerror=alert(1)>';
    const upd = await manager.put(`/api/admin/products/${id}`, { name: "Test Ring II", slug: "test-ring", description: xss, category: "Rings", pricePaise: 31900 });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.product.pricePaise, 31900);

    // Visible in the public catalogue (stock unconfirmed → not buyable).
    const pub = await t.client().get("/api/products/test-ring");
    assert.equal(pub.body.product.availability.canBuy, false);
    assert.equal(pub.body.product.description, xss, "stored as text; storefront escapes on render");

    assert.equal((await manager.post(`/api/admin/products/${id}/archive`, {})).body.product.active, false);
    assert.equal((await t.client().get("/api/products/test-ring")).status, 404);
    assert.equal((await manager.post(`/api/admin/products/${id}/restore`, {})).body.product.active, true);

    assert.equal((await owner.del(`/api/admin/products/${id}`)).status, 200);
    assert.equal((await owner.get(`/api/admin/products/${id}`)).status, 404);
  });

  test("products with orders can be archived but not deleted (history kept)", async () => {
    const { order } = await paidOrder({ productId: "p03" });
    const r = await owner.del("/api/admin/products/p03");
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "product_has_orders");
    const view = await owner.get(`/api/admin/orders/${order.id}`);
    assert.equal(view.body.order.items[0].productId, "p03");
  });

  test("image upload validates type and size, supports reorder, replace and delete", async () => {
    const c = await owner.post("/api/admin/products", { name: "Image Test", slug: "image-test", description: "d", category: "Rings", pricePaise: 100 });
    const id = c.body.product.id;
    const fake = await owner.upload(`/api/admin/products/${id}/images`, Buffer.from("<svg onload=alert(1)></svg>".padEnd(64, " ")), "image/png");
    assert.equal(fake.status, 415, "content is sniffed, not trusted");
    const big = await owner.upload(`/api/admin/products/${id}/images`, Buffer.concat([PNG_1PX, Buffer.alloc(4 * 1024 * 1024)]));
    assert.equal(big.status, 413);
    assert.equal((await t.client().upload(`/api/admin/products/${id}/images`, PNG_1PX)).status, 401);

    const a = await manager.upload(`/api/admin/products/${id}/images`, PNG_1PX);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const b = await manager.upload(`/api/admin/products/${id}/images`, PNG_1PX);
    const [u1, u2] = b.body.product.images;
    assert.match(u1, /^\/uploads\/products\/.+\.png$/);
    const file1 = path.join(t.uploadDir, u1.replace("/uploads/", ""));
    assert.ok(existsSync(file1));

    assert.equal((await manager.put(`/api/admin/products/${id}/images`, { images: [u2, u1] })).body.product.image, u2);
    const inject = await manager.put(`/api/admin/products/${id}/images`, { images: [u2, "https://evil.example/x.png"] });
    assert.equal(inject.status, 400, "reorder cannot inject URLs");

    const del = await manager.del(`/api/admin/products/${id}/images?url=${encodeURIComponent(u1)}`);
    assert.deepEqual(del.body.product.images, [u2]);
    assert.ok(!existsSync(file1), "deleted from storage");

    // Repository assets are only unlinked, never deleted from disk.
    const p01 = (await owner.get("/api/admin/products/p01")).body.product;
    assert.ok(p01.images[0].startsWith("assets/"));
  });

  test("variants: per-option stock and price flow through cart and checkout", async () => {
    const c = await owner.post("/api/admin/products", { name: "Variant Chain", slug: "variant-chain", description: "d", category: "Necklaces", pricePaise: 20000 });
    const id = c.body.product.id;
    const v16 = (await owner.post(`/api/admin/products/${id}/variants`, { name: "16 inch", pricePaise: null })).body.variant;
    const v18 = (await owner.post(`/api/admin/products/${id}/variants`, { name: "18 inch", pricePaise: 22000, position: 1 })).body.variant;
    assert.equal((await owner.post(`/api/admin/products/${id}/variants`, { name: "16 inch" })).status, 409);
    await owner.post("/api/admin/inventory/adjust", { productId: id, variantId: v18.id, mode: "set", quantity: 1, reason: "test count" });

    const pub = (await t.client().get("/api/products/variant-chain")).body.product;
    assert.equal(pub.variants.length, 2);
    assert.equal(pub.availability.canBuy, true);
    assert.equal(pub.variants.find((v) => v.id === v16.id).availability.code, "unconfirmed");

    const shopper = t.client();
    assert.equal((await shopper.post("/api/cart/items", { productId: id, quantity: 1 })).body.error, "variant_required");
    assert.equal((await shopper.post("/api/cart/items", { productId: id, variantId: v16.id, quantity: 1 })).body.error, "inventory_unconfirmed");
    const cart = await shopper.post("/api/cart/items", { productId: id, variantId: v18.id, quantity: 1 });
    assert.equal(cart.status, 200);
    assert.equal(cart.body.items[0].variant.name, "18 inch");
    assert.equal(cart.body.subtotalPaise, 22000, "variant price used");

    await t.setShipping(0);
    const co = await shopper.post("/api/checkout", { checkoutKey: newKey(), customer: CUSTOMER });
    assert.equal(co.status, 200, JSON.stringify(co.body));
    assert.equal(co.body.order.items[0].name, "Variant Chain — 18 inch");
    assert.equal(co.body.order.totalPaise, 22000);
    const inv = (await owner.get("/api/admin/inventory")).body.units.find((u) => u.variantId === v18.id);
    assert.equal(inv.stock, 0);
    assert.equal(inv.reserved, 1);

    // Ordered variant is archived, not deleted.
    assert.equal((await owner.del(`/api/admin/products/${id}/variants/${v18.id}`)).body.archived, true);
    assert.equal((await owner.del(`/api/admin/products/${id}/variants/${v16.id}`)).body.deleted, true);
  });
});

describe("inventory", () => {
  test("set count, adjust with reason, never below zero, history + audit recorded", async () => {
    const noReason = await manager.post("/api/admin/inventory/adjust", { productId: "p05", mode: "set", quantity: 4, reason: "" });
    assert.equal(noReason.status, 400);
    assert.equal((await manager.post("/api/admin/inventory/adjust", { productId: "p05", mode: "delta", quantity: 2, reason: "restock" })).body.error, "set_count_first");
    const set = await manager.post("/api/admin/inventory/adjust", { productId: "p05", mode: "set", quantity: 4, reason: "Physical count" });
    assert.equal(set.body.result.stock_quantity, 4);
    assert.equal((await manager.post("/api/admin/inventory/adjust", { productId: "p05", mode: "delta", quantity: -5, reason: "damaged" })).status, 400);
    assert.equal((await manager.post("/api/admin/inventory/adjust", { productId: "p05", mode: "delta", quantity: -1, reason: "damaged" })).body.result.stock_quantity, 3);
    assert.equal((await manager.post("/api/admin/inventory/adjust", { productId: "p05", mode: "set", quantity: 1.5, reason: "x y z" })).status, 400);

    const mv = await manager.get("/api/admin/inventory/movements?productId=p05");
    assert.equal(mv.body.movements[0].reason, "damaged");
    assert.equal(mv.body.movements[0].actor_email, "manager@example.test");
    const units = (await manager.get("/api/admin/inventory")).body;
    const p05 = units.units.find((u) => u.productId === "p05");
    assert.equal(p05.confirmed, true);
    assert.equal(p05.low, false);
    await manager.post("/api/admin/inventory/adjust", { productId: "p05", mode: "set", quantity: 2, reason: "count" });
    assert.equal((await manager.get("/api/admin/inventory")).body.units.find((u) => u.productId === "p05").low, true);
    const audit = await owner.get("/api/admin/audit?action=stock");
    assert.ok(audit.body.entries.some((e) => e.actor === "manager@example.test" && e.details.reason === "Physical count"));
  });

  test("concurrent adjustments are atomic", async () => {
    await owner.post("/api/admin/inventory/adjust", { productId: "p06", mode: "set", quantity: 10, reason: "count" });
    await Promise.all(Array.from({ length: 8 }, () => manager.post("/api/admin/inventory/adjust", { productId: "p06", mode: "delta", quantity: -1, reason: "sold offline" })));
    assert.equal(await t.stockOf("p06"), 2);
  });
});

describe("orders, payments and refunds", () => {
  test("search/filter, detail, fulfilment transitions with tracking, audit trail", async () => {
    const { order } = await paidOrder();
    const list = await manager.get(`/api/admin/orders?q=${order.publicRef}`);
    assert.equal(list.body.total, 1);
    assert.equal((await manager.get("/api/admin/orders?payment=paid")).body.orders.every((o) => o.paymentStatus === "paid"), true);
    assert.equal((await manager.get("/api/admin/orders?payment=bogus")).status, 400);

    const detail = await manager.get(`/api/admin/orders/${order.id}`);
    assert.equal(detail.body.order.payments.at(-1).status, "paid");
    assert.equal(detail.body.order.address.pin, CUSTOMER.pin, "fulfilment needs the address");

    assert.equal((await manager.post(`/api/admin/orders/${order.id}/fulfilment`, { status: "delivered" })).status, 409, "can't skip shipping");
    assert.equal((await manager.post(`/api/admin/orders/${order.id}/fulfilment`, { status: "shipped", trackingUrl: "javascript:alert(1)" })).status, 400);
    const shipped = await manager.post(`/api/admin/orders/${order.id}/fulfilment`, { status: "shipped", trackingNumber: "TRK123", courier: "Test Courier", trackingUrl: "https://track.example/TRK123" });
    assert.equal(shipped.status, 200, JSON.stringify(shipped.body));
    assert.equal(shipped.body.order.fulfilmentStatus, "shipped");
    assert.equal(shipped.body.order.tracking.number, "TRK123");
    assert.equal((await manager.post(`/api/admin/orders/${order.id}/fulfilment`, { status: "delivered" })).body.order.fulfilmentStatus, "delivered");
    assert.ok((await manager.get(`/api/admin/orders/${order.id}`)).body.order.history.some((h) => h.action === "order.fulfilment"));

    // Customer sees the tracking info.
    const look = await t.client().post("/api/orders/lookup", { ref: order.publicRef, email: CUSTOMER.email });
    assert.equal(look.body.order.tracking.courier, "Test Courier");
  });

  test("admins cannot mark payments successful; unpaid orders can't be fulfilled", async () => {
    await t.setStock("p07", 3);
    const c = t.client();
    await c.post("/api/cart/items", { productId: "p07", quantity: 1 });
    const co = await c.post("/api/checkout", { checkoutKey: newKey(), customer: CUSTOMER });
    const id = co.body.order.id;
    assert.equal((await owner.post(`/api/admin/orders/${id}/fulfilment`, { status: "confirmed" })).body.error, "order_not_paid");
    assert.equal((await owner.post(`/api/admin/orders/${id}/fulfilment`, { status: "paid" })).status, 400);
    // There is no endpoint that sets payment status; reconcile asks Razorpay.
    const rec = await owner.post(`/api/admin/orders/${id}/reconcile`, {});
    assert.equal(rec.body.result, "none");
    assert.equal(rec.body.order.paymentStatus, "pending");
    t.razorpay.pay(co.body.razorpay.orderId);
    const rec2 = await owner.post(`/api/admin/orders/${id}/reconcile`, {});
    assert.equal(rec2.body.result, "paid", "only verified Razorpay evidence marks it paid");
  });

  test("cancel unpaid order releases stock after checking Razorpay; paid orders must be refunded", async () => {
    await t.setStock("p04", 3);
    const c = t.client();
    await c.post("/api/cart/items", { productId: "p04", quantity: 2 });
    const co = await c.post("/api/checkout", { checkoutKey: newKey(), customer: CUSTOMER });
    assert.equal(await t.stockOf("p04"), 1);
    const r = await manager.post(`/api/admin/orders/${co.body.order.id}/cancel`, {});
    assert.equal(r.status, 200);
    assert.equal(r.body.order.paymentStatus, "cancelled");
    assert.equal(await t.stockOf("p04"), 3);
    const { order } = await paidOrder({ productId: "p04" });
    assert.equal((await manager.post(`/api/admin/orders/${order.id}/cancel`, {})).body.error, "use_refund");
  });

  test("full refund with restock (owner only), validated amounts, Razorpay-confirmed", async () => {
    const { order } = await paidOrder({ productId: "p01", qty: 2 });
    const before = await t.stockOf("p01");
    assert.equal((await owner.post(`/api/admin/orders/${order.id}/refund`, { amountPaise: order.totalPaise + 1, reason: "too much" })).body.error, "refund_amount_invalid");
    assert.equal((await owner.post(`/api/admin/orders/${order.id}/refund`, { amountPaise: 100, reason: "x" })).status, 400);
    assert.equal((await owner.post(`/api/admin/orders/${order.id}/refund`, { amountPaise: 100, reason: "partial", restock: true })).body.error, "restock_not_allowed");

    const r = await owner.post(`/api/admin/orders/${order.id}/refund`, { amountPaise: order.totalPaise, reason: "Customer cancelled", restock: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.order.paymentStatus, "refunded");
    assert.equal(r.body.order.fulfilmentStatus, "cancelled");
    assert.equal(r.body.order.refundedPaise, order.totalPaise);
    assert.equal(await t.stockOf("p01"), before + 2, "restocked once");
    assert.equal((await owner.post(`/api/admin/orders/${order.id}/refund`, { amountPaise: 1, reason: "again" })).body.error, "order_not_refundable");
  });

  test("partial refunds, Razorpay errors, timeouts and refund webhooks reconcile correctly", async () => {
    const { order, payment } = await paidOrder({ productId: "p02" });
    const p1 = await owner.post(`/api/admin/orders/${order.id}/refund`, { amountPaise: 1000, reason: "Goodwill partial" });
    assert.equal(p1.body.order.paymentStatus, "partially_refunded");

    t.razorpay.refundMode = "error";
    const failed = await owner.post(`/api/admin/orders/${order.id}/refund`, { amountPaise: 500, reason: "second partial" });
    assert.equal(failed.status, 502);
    assert.equal((await owner.get(`/api/admin/orders/${order.id}`)).body.order.refunds.at(-1).status, "failed");

    t.razorpay.refundMode = "timeout";
    const unknown = await owner.post(`/api/admin/orders/${order.id}/refund`, { amountPaise: 500, reason: "third partial" });
    assert.equal(unknown.status, 202);
    assert.equal((await owner.post(`/api/admin/orders/${order.id}/refund`, { amountPaise: 1, reason: "fourth" })).body.error, "refund_in_progress");
    t.razorpay.refundMode = "processed";

    // Razorpay's webhook confirms the timed-out refund; it attaches instead of duplicating.
    const body = JSON.stringify({ event: "refund.processed", payload: { refund: { entity: { id: "rfnd_timedout0001", payment_id: payment.id, amount: 500, status: "processed" } } } });
    const res = await fetch(`${t.base}/api/webhooks/razorpay`, { method: "POST", headers: { "Content-Type": "application/json", "X-Razorpay-Signature": signWebhook(body), "X-Razorpay-Event-Id": "evt_refund_1" }, body });
    assert.equal((await res.json()).result, "refund_processed");
    const view = (await owner.get(`/api/admin/orders/${order.id}`)).body.order;
    assert.equal(view.refundedPaise, 1500);
    assert.equal(view.refunds.filter((r) => r.status === "processed").length, 2);

    // A refund made in the Razorpay dashboard is captured too.
    const body2 = JSON.stringify({ event: "refund.processed", payload: { refund: { entity: { id: "rfnd_dashboard001", payment_id: payment.id, amount: order.totalPaise - 1500, status: "processed" } } } });
    await fetch(`${t.base}/api/webhooks/razorpay`, { method: "POST", headers: { "Content-Type": "application/json", "X-Razorpay-Signature": signWebhook(body2), "X-Razorpay-Event-Id": "evt_refund_2" }, body: body2 });
    assert.equal((await owner.get(`/api/admin/orders/${order.id}`)).body.order.paymentStatus, "refunded");
  });
});

describe("customers and privacy", () => {
  test("managers see masked contact details; owners see full details and the view is audited", async () => {
    await paidOrder();
    const m = await manager.get("/api/admin/customers");
    assert.equal(m.body.masked, true);
    const row = m.body.customers.find((c) => c.fullName === CUSTOMER.fullName);
    assert.ok(!row.email.includes(CUSTOMER.email), "masked email");
    assert.match(row.phone, /^••••••\d{4}$/);
    assert.equal(row.key, null);

    const o = await owner.get("/api/admin/customers");
    const full = o.body.customers.find((c) => c.email === CUSTOMER.email);
    assert.ok(full.paidOrders >= 1);
    const one = await owner.get(`/api/admin/customer?email=${encodeURIComponent(CUSTOMER.email)}`);
    assert.ok(one.body.orders.length >= 1);
    assert.ok(!JSON.stringify(one.body).includes("password"));
    assert.ok((await owner.get("/api/admin/audit?entity=customer")).body.entries.some((e) => e.action === "customer.viewed"));
  });
});

describe("settings, pages and overview", () => {
  test("owner updates settings with validation; storefront reflects them", async () => {
    assert.equal((await owner.put("/api/admin/settings", { instagramUrl: "javascript:alert(1)" })).status, 400);
    assert.equal((await owner.put("/api/admin/settings", { whatsappE164: "98765" })).status, 400);
    assert.equal((await owner.put("/api/admin/settings", { shippingPaise: null, shippingConfirmed: true })).status, 400);
    const ok = await owner.put("/api/admin/settings", {
      contactEmail: "Hello@Example.test", whatsappE164: "+91 98765 43210", instagramUrl: "https://www.instagram.com/amanaat.ind/",
      announcementText: "Test announcement", announcementEnabled: true, announcementLink: "/shop.html",
      homepage: { heroTitle: "Test hero", heroImage: "/assets/post.jpg" }, lowStockThreshold: 3,
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.settings.whatsappE164, "+919876543210");
    const pub = (await t.client().get("/api/content")).body.content;
    assert.equal(pub.contactEmail, "hello@example.test");
    assert.equal(pub.announcement.text, "Test announcement");
    assert.equal(pub.homepage.heroTitle, "Test hero");
    const audit = await owner.get("/api/admin/audit?entity=settings");
    assert.equal(audit.body.entries[0].details.before.contact_email, null);
  });

  test("logo upload (owner only)", async () => {
    assert.equal((await manager.upload("/api/admin/settings/logo", PNG_1PX)).status, 403);
    const r = await owner.upload("/api/admin/settings/logo", PNG_1PX);
    assert.equal(r.status, 201);
    assert.match(r.body.settings.logoUrl, /^\/uploads\/site\//);
  });

  test("policy pages: drafts are private, published pages are public", async () => {
    assert.equal((await owner.put("/api/admin/pages/hack", { title: "x", body: "y" })).status, 404);
    await owner.put("/api/admin/pages/returns", { title: "Returns", body: "Draft text only", published: false });
    assert.equal((await t.client().get("/api/pages/returns")).status, 404);
    assert.equal((await owner.put("/api/admin/pages/returns", { title: "Returns", body: "short", published: true })).status, 400);
    await owner.put("/api/admin/pages/returns", { title: "Returns", body: "Test returns policy text for the test suite.", published: true });
    assert.equal((await t.client().get("/api/pages/returns")).body.page.title, "Returns");
    assert.ok((await t.client().get("/api/content")).body.content.pages.some((p) => p.slug === "returns"));
  });

  test("overview numbers come from the database", async () => {
    const o = (await owner.get("/api/admin/overview")).body;
    const { rows } = await t.db.pg.query("SELECT count(*)::int AS n, COALESCE(sum(total_paise) FILTER (WHERE payment_status IN ('paid','partially_refunded','refunded')),0)::int AS gross FROM orders");
    assert.equal(o.orders.total, rows[0].n);
    assert.equal(o.revenue.grossPaidPaise, rows[0].gross);
    assert.ok(o.recentOrders.length > 0);
    assert.equal(o.lowStockThreshold, 3);
  });

  test("the audit log is append-only", async () => {
    await assert.rejects(t.db.pg.query("DELETE FROM admin_audit_log"), /append_only/);
  });
});
