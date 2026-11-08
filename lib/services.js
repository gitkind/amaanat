import crypto from "node:crypto";
import { fromRow, publicProduct, readCatalogueFile, readSettingsFile, toSettings } from "./catalogue.js";
import { HttpError } from "./http.js";
import { reasonMessage } from "./order.js";
import { sha256 } from "./session.js";

export function requireDb(deps) {
  if (!deps.db) throw new HttpError(503, "database_not_configured", reasonMessage("database_not_configured"));
  return deps.db;
}

export async function getProducts(deps) {
  if (!deps.db) return readCatalogueFile();
  return ((await deps.db.rpc("api_list_products", { p_include_inactive: false })) || []).map(fromRow);
}

export async function getSettings(deps) {
  if (!deps.db) return readSettingsFile();
  return toSettings(await deps.db.rpc("api_get_settings", {})) || readSettingsFile();
}

// Maps a database error raised by our SQL functions to an HTTP error.
const CONFLICT_CODES = new Set([
  "empty_cart", "unknown_product", "inactive_product", "invalid_quantity", "duplicate_lines",
  "too_many_lines", "inventory_unconfirmed", "insufficient_stock", "shipping_unconfigured",
  "tax_misconfigured", "order_not_payable", "order_too_large", "wishlist_full",
  "too_many_addresses", "address_not_found", "cart_missing", "missing_client_token",
]);

export function mapDbError(error) {
  if (error?.name === "DbError" && error.code && CONFLICT_CODES.has(error.code)) {
    const status = ["invalid_quantity", "missing_client_token", "duplicate_lines"].includes(error.code) ? 400
      : error.code === "address_not_found" ? 404 : 409;
    return new HttpError(status, error.code, reasonMessage(error.code, error.detail), error.detail ? { productName: error.detail } : {});
  }
  if (error?.name === "DbError" && error.status === 400 && /violates check constraint/.test(error.message)) {
    return new HttpError(400, "invalid_input", "Some details were not valid.");
  }
  return error;
}

export async function rpc(deps, name, args) {
  try {
    return await requireDb(deps).rpc(name, args);
  } catch (error) {
    throw mapDbError(error);
  }
}

export function tokenMatches(key, storedHash) {
  if (!key || !storedHash) return false;
  const a = Buffer.from(sha256(key));
  const b = Buffer.from(String(storedHash));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function canAccessOrder(order, { key, user }) {
  if (!order) return false;
  if (user?.id && order.user_id && order.user_id === user.id) return true;
  return tokenMatches(key, order.client_token);
}

const STATUS_LABEL = {
  pending: "Awaiting payment",
  authorized: "Payment authorised, confirming",
  paid: "Paid",
  failed: "Payment failed",
  cancelled: "Cancelled",
  expired: "Expired (not paid in time)",
  refunded: "Refunded",
};

export function orderView(o, { full = false } = {}) {
  if (!o) return null;
  const view = {
    id: o.id,
    publicRef: o.public_ref,
    paymentStatus: o.payment_status,
    paymentStatusLabel: STATUS_LABEL[o.payment_status] || o.payment_status,
    fulfilmentStatus: o.fulfilment_status,
    currency: o.currency || "INR",
    subtotalPaise: o.subtotal_paise,
    shippingPaise: o.shipping_paise,
    taxPaise: o.tax_paise,
    totalPaise: o.total_paise,
    createdAt: o.created_at,
    paidAt: o.paid_at || null,
    reservationExpiresAt: o.payment_status === "pending" ? o.reservation_expires_at : null,
    items: (o.items || []).map((i) => ({
      productId: i.product_id,
      slug: i.slug,
      name: i.name,
      quantity: i.quantity,
      unitPricePaise: i.unit_price_paise,
      lineTotalPaise: i.line_total_paise,
      image: i.image_path || null,
    })),
    tracking: o.tracking_number || o.courier_name || o.tracking_url
      ? { number: o.tracking_number, courier: o.courier_name, url: o.tracking_url, dispatchedAt: o.dispatched_at }
      : null,
  };
  if (full) {
    view.customer = { fullName: o.full_name, email: o.email, phone: o.phone };
    view.address = {
      line: o.address_line, apartment: o.address_apartment, locality: o.address_locality,
      city: o.address_city, state: o.address_state, pin: o.address_pin,
    };
    view.notes = o.notes;
  }
  return view;
}

// ---------------------------------------------------------------
// Payments
// ---------------------------------------------------------------

const PAYMENT_FINAL_ERRORS = new Set(["amount_mismatch", "order_mismatch", "order_not_found", "order_refunded"]);

export async function applyCapturedPayment(deps, { orderId = null, payment, source, signature = null }) {
  try {
    const order = await deps.db.rpc("api_finalize_payment", {
      p_order_id: orderId,
      p_razorpay_order_id: payment.order_id,
      p_razorpay_payment_id: payment.id,
      p_amount: payment.amount,
      p_currency: payment.currency,
      p_source: source,
      p_signature: signature,
    });
    if (order?.error) return { ok: false, code: order.error };
    return { ok: true, order };
  } catch (error) {
    if (error?.name === "DbError" && PAYMENT_FINAL_ERRORS.has(error.code)) return { ok: false, code: error.code };
    throw error;
  }
}

export async function recordPaymentState(deps, { payment, status, source, detail }) {
  return deps.db.rpc("api_record_payment_state", {
    p_razorpay_order_id: payment.order_id,
    p_razorpay_payment_id: payment.id || null,
    p_status: status,
    p_amount: Number.isInteger(payment.amount) ? payment.amount : null,
    p_currency: payment.currency || null,
    p_source: source,
    p_detail: detail || null,
  });
}

// Asks Razorpay what actually happened on an order's payments.
// Returns { state: 'paid' | 'authorized' | 'none', order }.
// Throws RazorpayError if Razorpay cannot be reached (callers must not release then).
export async function reconcileWithRazorpay(deps, order, source) {
  if (!order.razorpay_order_id) return { state: "none", order };
  if (!deps.razorpay) throw new HttpError(503, "payments_not_configured", reasonMessage("payments_not_configured"));
  const payments = await deps.razorpay.fetchOrderPayments(order.razorpay_order_id);
  const captured = payments.find((p) => p.status === "captured" && p.order_id === order.razorpay_order_id);
  if (captured) {
    const result = await applyCapturedPayment(deps, { orderId: order.id, payment: captured, source });
    if (result.ok) return { state: "paid", order: result.order };
    return { state: "review", order, code: result.code };
  }
  const authorized = payments.find((p) => p.status === "authorized");
  if (authorized) {
    const updated = await recordPaymentState(deps, { payment: authorized, status: "authorized", source });
    return { state: "authorized", order: updated || order };
  }
  return { state: "none", order };
}

// Releases reservations whose payment window passed, after checking Razorpay.
export async function sweepExpiredReservations(deps, limit = 20) {
  const expired = (await deps.db.rpc("api_list_expired_pending", { p_limit: limit })) || [];
  const summary = { checked: expired.length, released: 0, paid: 0, skipped: 0 };
  for (const row of expired) {
    try {
      const order = await deps.db.rpc("api_get_order", { p_order_id: row.id });
      const r = await reconcileWithRazorpay(deps, order, "reconcile_expiry");
      if (r.state === "none") {
        await deps.db.rpc("api_release_order", { p_order_id: row.id, p_status: "expired", p_reason: "payment window passed" });
        summary.released += 1;
      } else if (r.state === "paid") {
        summary.paid += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (error) {
      deps.log?.warn?.(`[reconcile] skipped ${row.id}: ${error.message}`);
      summary.skipped += 1;
    }
  }
  return summary;
}

export function cartView(rows, settings) {
  const threshold = settings?.lowStockThreshold ?? 2;
  const items = (rows || []).map((row) => {
    const product = fromRow(row.product);
    const pub = publicProduct(product, { lowStockThreshold: threshold });
    let issue = null;
    if (!pub.availability.canBuy) issue = pub.availability.code;
    else if (row.quantity > product.stockQuantity) issue = "insufficient_stock";
    return { product: pub, quantity: row.quantity, lineTotalPaise: product.pricePaise * row.quantity, issue, _product: product };
  });
  return items;
}
