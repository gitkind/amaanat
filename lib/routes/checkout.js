import crypto from "node:crypto";
import { HttpError } from "../http.js";
import { reasonMessage, validateCustomer } from "../order.js";
import { paymentsEnabled, razorpayMode, RazorpayError, verifyPaymentSignature, verifyWebhookSignature } from "../razorpay.js";
import {
  applyCapturedPayment,
  canAccessOrder,
  getSettings,
  orderView,
  reconcileWithRazorpay,
  recordPaymentState,
  rpc,
  sweepExpiredReservations,
} from "../services.js";
import { sha256 } from "../session.js";
import { loadCart } from "./store.js";

const KEY_RE = /^[A-Za-z0-9_-]{32,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RZP_ORDER_RE = /^order_[A-Za-z0-9]{6,40}$/;
const RZP_PAYMENT_RE = /^pay_[A-Za-z0-9]{6,40}$/;
const SIG_RE = /^[a-f0-9]{64}$/;

function requirePayments(ctx) {
  const { config, razorpay, db } = ctx.deps;
  if (!db) throw new HttpError(503, "database_not_configured", reasonMessage("database_not_configured"));
  if (!paymentsEnabled(config.razorpay) || !razorpay) {
    throw new HttpError(503, "payments_not_configured", reasonMessage("payments_not_configured"), { razorpayMode: razorpayMode(config.razorpay) });
  }
}

function razorpayPayload(ctx, order) {
  return {
    keyId: ctx.deps.config.razorpay.keyId,
    orderId: order.razorpay_order_id,
    amount: order.total_paise,
    currency: order.currency || "INR",
    name: ctx.deps.config.storeName,
    description: `Order ${order.public_ref}`,
    prefill: { name: order.full_name, email: order.email, contact: order.phone },
    mode: razorpayMode(ctx.deps.config.razorpay),
  };
}

async function loadAuthorisedOrder(ctx, orderId, key) {
  if (!UUID_RE.test(String(orderId || ""))) throw new HttpError(404, "not_found", "Order not found.");
  const order = await rpc(ctx.deps, "api_get_order", { p_order_id: orderId });
  const user = await ctx.user();
  // Same response for "missing" and "not yours" so order ids cannot be probed.
  if (!canAccessOrder(order, { key, user })) throw new HttpError(404, "not_found", "Order not found.");
  return order;
}

async function clearRequesterCart(ctx) {
  try {
    const { cartId } = await loadCart(ctx);
    if (cartId) await ctx.deps.db.rpc("api_cart_clear", { p_cart_id: cartId });
  } catch (error) {
    ctx.deps.log.warn(`[cart] clear failed: ${error.message}`);
  }
}

// POST /api/checkout
// Reserves stock atomically and prices on the server. For online payment it then opens a
// Razorpay order; for Cash on Delivery the order is placed directly (no gateway involved).
export async function createCheckout(ctx) {
  const body = await ctx.json();
  const method = body.paymentMethod === undefined ? "razorpay" : String(body.paymentMethod);
  if (!["razorpay", "cod"].includes(method)) throw new HttpError(400, "invalid_payment_method", reasonMessage("invalid_payment_method"));
  if (method === "razorpay") requirePayments(ctx);
  else {
    if (!ctx.deps.db) throw new HttpError(503, "database_not_configured", reasonMessage("database_not_configured"));
    // Fast, friendly refusal; the database re-checks this inside the checkout transaction.
    if ((await getSettings(ctx.deps))?.codEnabled !== true) throw new HttpError(409, "cod_unavailable", reasonMessage("cod_unavailable"));
  }
  const key = String(body.checkoutKey || "");
  if (!KEY_RE.test(key)) throw new HttpError(400, "missing_client_token", reasonMessage("missing_client_token"));

  const check = validateCustomer(body.customer || {});
  if (!check.ok) throw new HttpError(400, "invalid_customer", reasonMessage("invalid_customer"), { errors: check.errors });
  const c = check.customer;
  const user = await ctx.user();

  // Opportunistic cleanup so abandoned reservations do not block stock.
  await sweepExpiredReservations(ctx.deps, 5).catch((e) => ctx.deps.log.warn(`[reconcile] ${e.message}`));

  // An empty bag is rejected by the database *after* its duplicate-submit check, so a retried
  // checkout (whose bag was already cleared by a placed COD order) returns the same order.
  const { rows } = await loadCart(ctx);

  let order = await rpc(ctx.deps, "api_create_checkout_order", {
    payload: {
      clientTokenHash: sha256(key),
      userId: user?.id || null,
      fullName: c.fullName,
      email: c.email,
      phone: c.phone,
      notes: c.notes,
      address: { line: c.address, apartment: c.apartment, locality: c.locality, city: c.city, state: c.state, pin: c.pin },
      lines: rows.map((r) => ({ productId: r.product.id, variantId: r.variant?.id || null, quantity: r.quantity })),
      reservationMinutes: ctx.deps.config.reservationMinutes,
      paymentMethod: method,
    },
  });

  const saveAddress = async () => {
    if (body.saveAddress !== true || !user) return;
    await ctx.deps.db.rpc("api_address_save", {
      p_user_id: user.id, p_address_id: null,
      p: { fullName: c.fullName, phone: c.phone, line: c.address, apartment: c.apartment, locality: c.locality, city: c.city, state: c.state, pin: c.pin },
    }).catch((e) => ctx.deps.log.warn(`[account] address save skipped: ${e.message}`));
  };

  // Cash on Delivery: the order is placed now and paid in cash on arrival.
  // A replayed checkout key returns the same order, so double submits create one order.
  if (order.payment_method === "cod") {
    if (["cancelled", "expired", "failed"].includes(order.payment_status)) {
      throw new HttpError(409, "order_not_payable", "This checkout already ended. Start a new checkout.", { order: orderView(order) });
    }
    await clearRequesterCart(ctx);
    if (!order.replayed) await saveAddress();
    return ctx.send(200, { status: "placed", order: orderView(order, { full: true }) });
  }
  if (method === "cod") requirePayments(ctx); // key was first used for an online checkout

  if (order.payment_status === "paid") {
    return ctx.send(200, { status: "paid", order: orderView(order, { full: true }) });
  }
  if (order.payment_status !== "pending" && order.payment_status !== "authorized") {
    throw new HttpError(409, "order_not_payable", "This checkout already ended. Start a new checkout.", { order: orderView(order) });
  }

  if (!order.razorpay_order_id) {
    let rzpOrder;
    try {
      rzpOrder = await ctx.deps.razorpay.createOrder({
        amount: order.total_paise,
        receipt: order.public_ref,
        notes: { amaanat_order_id: order.id, amaanat_ref: order.public_ref },
      });
    } catch (error) {
      ctx.deps.log.error(`[checkout] Razorpay order failed for ${order.public_ref}: ${error.message}`);
      await ctx.deps.db.rpc("api_release_order", { p_order_id: order.id, p_status: "failed", p_reason: "razorpay order not created" }).catch(() => {});
      throw new HttpError(502, "payment_gateway_error", "Razorpay did not open the payment. Nothing was charged and the reserved stock was released.");
    }
    if (rzpOrder.amount !== order.total_paise || rzpOrder.currency !== "INR") {
      throw new HttpError(502, "payment_gateway_error", "Razorpay returned an unexpected amount.");
    }
    try {
      order = await ctx.deps.db.rpc("api_attach_razorpay_order", { p_order_id: order.id, p_razorpay_order_id: rzpOrder.id, p_amount: rzpOrder.amount });
    } catch (error) {
      if (error.code !== "razorpay_order_already_attached") throw error;
      order = await ctx.deps.db.rpc("api_get_order", { p_order_id: order.id });
    }
  }

  await saveAddress();

  return ctx.send(200, { status: "pending", order: orderView(order, { full: true }), razorpay: razorpayPayload(ctx, order) });
}

// POST /api/payments/verify — called by the browser after Razorpay Checkout success.
// Never trusts the browser: verifies the HMAC, binds to the stored Razorpay order,
// and confirms capture + amount with the Razorpay API before marking paid.
export async function verifyPayment(ctx) {
  requirePayments(ctx);
  const body = await ctx.json();
  const rzpOrderId = String(body.razorpay_order_id || "");
  const rzpPaymentId = String(body.razorpay_payment_id || "");
  const signature = String(body.razorpay_signature || "");
  if (!RZP_ORDER_RE.test(rzpOrderId) || !RZP_PAYMENT_RE.test(rzpPaymentId) || !SIG_RE.test(signature)) {
    throw new HttpError(400, "invalid_payment_response", "The payment response was incomplete.");
  }

  const order = await loadAuthorisedOrder(ctx, body.orderId, String(body.checkoutKey || ""));
  if (order.razorpay_order_id !== rzpOrderId) {
    throw new HttpError(400, "order_mismatch", "This payment does not belong to this order.");
  }

  const valid = verifyPaymentSignature({ orderId: rzpOrderId, paymentId: rzpPaymentId, signature, secret: ctx.deps.config.razorpay.keySecret });
  if (!valid) {
    await recordPaymentState(ctx.deps, { payment: { order_id: rzpOrderId, id: rzpPaymentId }, status: "signature_invalid", source: "client_verify" }).catch(() => {});
    throw new HttpError(400, "invalid_signature", "The payment could not be verified.");
  }

  let payment;
  try {
    payment = await ctx.deps.razorpay.fetchPayment(rzpPaymentId);
  } catch (error) {
    ctx.deps.log.warn(`[verify] could not fetch ${rzpPaymentId}: ${error.message}`);
    return ctx.send(202, { status: "pending_confirmation", message: "Payment received by Razorpay. Confirmation is in progress; this page will update.", order: orderView(order, { full: true }) });
  }
  if (payment.order_id !== rzpOrderId) throw new HttpError(400, "order_mismatch", "This payment does not belong to this order.");

  if (payment.status === "captured") {
    const result = await applyCapturedPayment(ctx.deps, { orderId: order.id, payment, source: "client_verify", signature });
    if (!result.ok) {
      ctx.deps.log.error(`[verify] ${result.code} for order ${order.public_ref}`);
      throw new HttpError(409, result.code, "The payment did not match this order. Our team will review it; contact us with your order reference.");
    }
    await clearRequesterCart(ctx);
    return ctx.send(200, { status: "paid", order: orderView(result.order, { full: true }), needsReview: result.order.needs_review === true });
  }
  if (payment.status === "authorized") {
    const updated = await recordPaymentState(ctx.deps, { payment, status: "authorized", source: "client_verify" });
    await clearRequesterCart(ctx);
    return ctx.send(202, { status: "authorized", message: "Payment authorised. Confirmation will follow shortly.", order: orderView(updated || order, { full: true }) });
  }
  await recordPaymentState(ctx.deps, { payment, status: payment.status || "unknown", source: "client_verify" }).catch(() => {});
  throw new HttpError(409, "payment_not_successful", "Razorpay reports this payment as not successful.");
}

// POST /api/checkout/cancel — customer closed the payment window.
export async function cancelCheckout(ctx) {
  if (!ctx.deps.db) throw new HttpError(503, "database_not_configured", reasonMessage("database_not_configured"));
  const body = await ctx.json();
  const order = await loadAuthorisedOrder(ctx, body.orderId, String(body.checkoutKey || ""));
  if (order.payment_method === "cod") {
    throw new HttpError(409, "cod_cancel_contact", "Cash on Delivery orders can't be cancelled online. Please contact us and we'll help.");
  }
  if (order.payment_status !== "pending") return ctx.send(200, { status: order.payment_status, order: orderView(order, { full: true }) });

  let r;
  try {
    r = await reconcileWithRazorpay(ctx.deps, order, "cancel_reconcile");
  } catch (error) {
    if (error instanceof RazorpayError) {
      throw new HttpError(503, "payment_status_unknown", "We could not confirm the payment status, so the order stays reserved for now.");
    }
    throw error;
  }
  if (r.state === "paid") return ctx.send(200, { status: "paid", order: orderView(r.order, { full: true }) });
  if (r.state !== "none") return ctx.send(409, { error: "payment_in_progress", message: "A payment is in progress for this order.", order: orderView(r.order, { full: true }) });

  const released = await ctx.deps.db.rpc("api_release_order", { p_order_id: order.id, p_status: "cancelled", p_reason: "customer closed checkout" });
  return ctx.send(200, { status: released.payment_status, order: orderView(released, { full: true }) });
}

// POST /api/webhooks/razorpay — raw body HMAC, event-id dedupe, idempotent processing.
export async function razorpayWebhook(ctx) {
  const { config, db } = ctx.deps;
  if (!config.razorpay.webhookSecret || !db) return ctx.send(503, { error: "webhook_not_configured" });

  const raw = await ctx.raw(1024 * 1024);
  const signature = ctx.req.headers["x-razorpay-signature"];
  if (!verifyWebhookSignature({ rawBody: raw, signature, secret: config.razorpay.webhookSecret })) {
    return ctx.send(400, { error: "invalid_signature" });
  }

  let event;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    return ctx.send(400, { error: "invalid_json" });
  }
  const eventId = String(ctx.req.headers["x-razorpay-event-id"] || "").slice(0, 100) || `body_${crypto.createHash("sha256").update(raw).digest("hex")}`;
  const state = await db.rpc("api_webhook_begin", { p_event_id: eventId, p_event: String(event.event || "unknown"), p_payload: event });
  if (state === "duplicate") return ctx.send(200, { received: true, duplicate: true });

  const payment = event.payload?.payment?.entity;
  const refund = event.payload?.refund?.entity;
  let result = "ignored";
  if (refund?.id && /^refund\.(processed|failed|created)$/.test(event.event) && RZP_PAYMENT_RE.test(String(refund.payment_id || ""))) {
    const status = event.event === "refund.processed" ? "processed" : event.event === "refund.failed" ? "failed" : "pending";
    result = await db.rpc("api_refund_webhook", { p_razorpay_refund_id: String(refund.id).slice(0, 60), p_razorpay_payment_id: refund.payment_id, p_amount: refund.amount, p_status: status });
    await db.rpc("api_webhook_finish", { p_event_id: eventId, p_result: result });
    return ctx.send(200, { received: true, result });
  }
  if (payment?.order_id && RZP_ORDER_RE.test(payment.order_id)) {
    if (event.event === "payment.captured" || event.event === "order.paid") {
      const r = await applyCapturedPayment(ctx.deps, { payment, source: `webhook:${event.event}` });
      result = r.ok ? (r.order.needs_review ? "paid_needs_review" : "paid") : `rejected:${r.code}`;
      if (!r.ok) ctx.deps.log.error(`[webhook] ${event.event} ${payment.id} rejected: ${r.code}`);
    } else if (event.event === "payment.authorized") {
      result = (await recordPaymentState(ctx.deps, { payment, status: "authorized", source: "webhook" })) ? "authorized" : "unknown_order";
    } else if (event.event === "payment.failed") {
      // Do not release stock: Razorpay allows retrying on the same order.
      const reason = payment.error_description || payment.error_code || null;
      result = (await recordPaymentState(ctx.deps, { payment, status: "failed", source: "webhook", detail: reason })) ? "failed_logged" : "unknown_order";
    }
  }
  await db.rpc("api_webhook_finish", { p_event_id: eventId, p_result: result });
  return ctx.send(200, { received: true, result });
}

// GET /api/orders/:id  (X-Order-Key header from this checkout, or signed-in owner)
export async function getOrder(ctx) {
  const order = await loadAuthorisedOrder(ctx, ctx.params.id, String(ctx.req.headers["x-order-key"] || ""));
  return ctx.send(200, { order: orderView(order, { full: true }) });
}

// POST /api/orders/lookup  { ref, email } — guest tracking. Rate limited; limited fields.
export async function lookupOrder(ctx) {
  if (!ctx.deps.db) throw new HttpError(503, "database_not_configured", reasonMessage("database_not_configured"));
  const body = await ctx.json();
  const ref = String(body.ref || "").trim().toUpperCase();
  const email = String(body.email || "").trim().toLowerCase();
  if (!/^AM-[A-F0-9]{8}$/.test(ref) || !email.includes("@")) {
    throw new HttpError(400, "missing_lookup", "Enter the order reference (like AM-1A2B3C4D) and the email used at checkout.");
  }
  const order = await ctx.deps.db.rpc("api_find_order", { p_public_ref: ref, p_email: email });
  if (!order) throw new HttpError(404, "not_found", "No order matched that reference and email.");
  return ctx.send(200, { order: orderView(order) });
}

export async function listMyOrders(ctx) {
  const user = await ctx.requireUser();
  const orders = await rpc(ctx.deps, "api_list_user_orders", { p_user_id: user.id });
  return ctx.send(200, { orders: (orders || []).map((o) => orderView(o)) });
}

// GET|POST /api/internal/reconcile — for a scheduler (Vercel Cron sends Bearer CRON_SECRET).
export async function reconcile(ctx) {
  const secret = ctx.deps.config.cronSecret;
  const given = String(ctx.req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const ok = secret && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) return ctx.send(401, { error: "unauthorized" });
  if (!ctx.deps.db) return ctx.send(503, { error: "database_not_configured" });
  return ctx.send(200, await sweepExpiredReservations(ctx.deps, 50));
}
