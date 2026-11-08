import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { parseCatalogueQuery, publicProduct, queryCatalogue, readCatalogueFile } from "../lib/catalogue.js";
import { availability, quoteOrder, validateCustomer } from "../lib/order.js";
import { paymentsEnabled, razorpayMode, verifyPaymentSignature, verifyWebhookSignature } from "../lib/razorpay.js";
import { createRateLimiter } from "../lib/ratelimit.js";
import { isSameOriginRequest } from "../lib/security.js";
import { CUSTOMER } from "./helpers.js";

test("payment signature: accepts Razorpay's HMAC, rejects tampering", () => {
  const secret = "s3cret";
  const sig = crypto.createHmac("sha256", secret).update("order_A|pay_B").digest("hex");
  assert.equal(verifyPaymentSignature({ orderId: "order_A", paymentId: "pay_B", signature: sig, secret }), true);
  assert.equal(verifyPaymentSignature({ orderId: "order_X", paymentId: "pay_B", signature: sig, secret }), false);
  assert.equal(verifyPaymentSignature({ orderId: "order_A", paymentId: "pay_B", signature: sig, secret: "other" }), false);
  assert.equal(verifyPaymentSignature({ orderId: "order_A", paymentId: "pay_B", signature: "short", secret }), false);
  assert.equal(verifyPaymentSignature({ orderId: "order_A", paymentId: "pay_B", signature: sig, secret: "" }), false);
});

test("webhook signature is over the exact raw bytes", () => {
  const secret = "whsec";
  const raw = Buffer.from('{"event":"payment.captured","a":1}');
  const sig = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  assert.equal(verifyWebhookSignature({ rawBody: raw, signature: sig, secret }), true);
  assert.equal(verifyWebhookSignature({ rawBody: Buffer.from('{"event":"payment.captured", "a":1}'), signature: sig, secret }), false);
  assert.equal(verifyWebhookSignature({ rawBody: raw, signature: undefined, secret }), false);
});

test("razorpay mode: test keys enabled, live keys refused unless explicitly allowed", () => {
  assert.equal(razorpayMode({ keyId: "rzp_test_x", keySecret: "y" }), "test");
  assert.equal(paymentsEnabled({ keyId: "rzp_test_x", keySecret: "y" }), true);
  assert.equal(paymentsEnabled({ keyId: "rzp_live_x", keySecret: "y" }), false);
  assert.equal(paymentsEnabled({ keyId: "rzp_live_x", keySecret: "y", allowLive: true }), true);
  assert.equal(paymentsEnabled({ keyId: "", keySecret: "" }), false);
});

test("existing catalogue: unconfirmed stock is never buyable", async () => {
  const products = await readCatalogueFile();
  assert.equal(products.length, 7);
  for (const p of products) {
    assert.equal(availability(p).canBuy, false);
    assert.equal(publicProduct(p).availability.code, "unconfirmed");
  }
});

test("catalogue search, filter and sort", async () => {
  const products = await readCatalogueFile();
  const q = (s) => queryCatalogue(products, parseCatalogueQuery(new URLSearchParams(s)));
  assert.deepEqual(q("q=clover").map((p) => p.id).sort(), ["p01", "p02"]);
  assert.deepEqual(q("category=anklets").map((p) => p.id), ["p07"]);
  assert.deepEqual(q("category=sets").map((p) => p.id), ["p04"]);
  const asc = q("sort=price_asc").map((p) => p.pricePaise);
  assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
  assert.equal(q("maxPrice=30000").length, 1);
  assert.equal(q("inStock=1").length, 0);
  assert.equal(q("sort=; DROP TABLE").length, 7);
});

test("customer validation", () => {
  assert.equal(validateCustomer(CUSTOMER).ok, true);
  const bad = validateCustomer({ ...CUSTOMER, phone: "12345", pin: "0123", email: "x" });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.phone && bad.errors.pin && bad.errors.email);
  assert.equal(validateCustomer({ ...CUSTOMER, phone: "+91 98765-43210" }).customer.phone, "9876543210");
});

test("quote refuses unconfirmed shipping and computes totals in paise", () => {
  const product = { id: "p1", name: "X", pricePaise: 19900, inventoryConfirmed: true, stockQuantity: 5, active: true };
  assert.equal(quoteOrder({ lines: [{ product, quantity: 2 }], settings: { shippingConfirmed: false } }).error, "shipping_unconfigured");
  const q = quoteOrder({ lines: [{ product, quantity: 2 }], settings: { shippingConfirmed: true, shippingPaise: 500, taxConfirmed: true, taxRateBps: 300 } });
  assert.equal(q.subtotalPaise, 39800);
  assert.equal(q.taxPaise, 1194);
  assert.equal(q.totalPaise, 39800 + 500 + 1194);
  assert.equal(quoteOrder({ lines: [{ product, quantity: 6 }], settings: { shippingConfirmed: true, shippingPaise: 0 } }).error, "insufficient_stock");
});

test("rate limiter", () => {
  let t = 0;
  const rl = createRateLimiter({ now: () => t });
  assert.equal(rl.hit("k", 2, 1000).ok, true);
  assert.equal(rl.hit("k", 2, 1000).ok, true);
  assert.equal(rl.hit("k", 2, 1000).ok, false);
  t = 1001;
  assert.equal(rl.hit("k", 2, 1000).ok, true);
});

test("same-origin check", () => {
  const req = (headers) => ({ headers: { host: "shop.test", ...headers }, socket: {} });
  assert.equal(isSameOriginRequest(req({ origin: "http://shop.test" }), { trustProxy: false }), true);
  assert.equal(isSameOriginRequest(req({ origin: "https://evil.test" }), { trustProxy: false }), false);
  assert.equal(isSameOriginRequest(req({ origin: "null" }), { trustProxy: false }), false);
  assert.equal(isSameOriginRequest(req({ "sec-fetch-site": "cross-site" }), { trustProxy: false }), false);
});
