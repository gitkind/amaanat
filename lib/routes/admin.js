// Admin API. Every handler calls requireAdmin() itself — hiding buttons in the UI is
// never the access control. Admins are Supabase Auth users listed in admin_users
// with role 'owner' (everything) or 'manager' (catalogue, stock, fulfilment).
// Sessions use the same HttpOnly cookies as customers; CSRF same-origin checks apply.
import { fromRow, variantFromRow } from "../catalogue.js";
import { HttpError } from "../http.js";
import { reasonMessage } from "../order.js";
import { RazorpayError } from "../razorpay.js";
import { getSettings, orderView, reconcileWithRazorpay } from "../services.js";
import { MAX_IMAGE_BYTES, newObjectPath, newSiteAssetPath, sniffImage } from "../storage.js";
import { AuthError } from "../auth/supabase.js";
import { DOC_KEYS, cleanDocument, defaultDocument, schema as cmsSchemaDef } from "../cms.js";
import { DEFAULT_COPY, PROMISE } from "../site/pages.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAGE_SLUGS = ["about", "faq", "privacy", "terms", "shipping", "returns"];
const PAYMENT_STATUSES = ["pending", "authorized", "paid", "partially_refunded", "failed", "cancelled", "expired", "refunded"];
const FULFILMENT_STATUSES = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled", "refunded", "on_hold"];

const ADMIN_ERRORS = {
  slug_taken: [409, "Another product already uses that URL slug."],
  product_has_orders: [409, "This product has orders, so it can only be archived, not deleted."],
  unknown_product: [404, "Product not found."],
  unknown_variant: [404, "Option not found."],
  variant_name_taken: [409, "This product already has an option with that name."],
  invalid_images: [400, "The image list did not match the product's images."],
  too_many_images: [409, "A product can have up to 10 images."],
  image_not_found: [404, "That image is not on this product."],
  invalid_quantity: [400, "Enter a whole number of pieces (stock can't go below zero)."],
  reason_required: [400, "Enter a short reason (at least 3 characters)."],
  set_count_first: [409, "Set the counted stock first, then use adjustments."],
  order_not_found: [404, "Order not found."],
  order_not_paid: [409, "Only paid orders can be fulfilled."],
  invalid_transition: [409, "That status change isn't allowed."],
  stock_not_reserved: [409, "This order has no stock reserved (late payment). Restock or refund it first."],
  order_not_refundable: [409, "Only paid orders with a Razorpay payment can be refunded."],
  refund_in_progress: [409, "A refund for this order is still being created. Wait for Razorpay to confirm it."],
  refund_amount_invalid: [400, "The refund amount must be between ₹0.01 and the amount not yet refunded."],
  restock_not_allowed: [409, "Restocking is only possible for a full refund of an order that hasn't shipped."],
  invalid_status: [400, "Unknown status."],
  cod_already_shipped: [409, "This Cash on Delivery order has already shipped, so it can't be cancelled here. Handle it as a return."],
  not_cod_order: [409, "This isn't a Cash on Delivery order."],
  cod_not_pending: [409, "Cash for this order is already recorded."],
  cod_not_delivered: [409, "Mark the order delivered before recording the cash."],
};

async function call(ctx, name, args) {
  if (!ctx.deps.db) throw new HttpError(503, "database_not_configured", reasonMessage("database_not_configured"));
  try {
    return await ctx.deps.db.rpc(name, args);
  } catch (error) {
    const known = error?.name === "DbError" && ADMIN_ERRORS[error.code];
    if (known) {
      const msg = error.code === "invalid_transition" && error.detail ? `${known[1]} (${error.detail})` : known[1];
      throw new HttpError(known[0], error.code, msg);
    }
    if (error?.name === "DbError" && /violates check constraint|invalid input syntax/.test(error.message)) {
      throw new HttpError(400, "invalid_input", "Some values were not valid.");
    }
    throw error;
  }
}

// Verifies session + role on every request. Returns the actor recorded in the audit log.
export async function requireAdmin(ctx, roles = ["owner", "manager"]) {
  if (!ctx.deps.db || !ctx.deps.auth) throw new HttpError(503, "admin_not_configured", "Admin is not configured on this server.");
  const user = await ctx.user();
  if (!user?.id || !UUID_RE.test(user.id)) throw new HttpError(401, "admin_required", "Sign in as an admin.");
  const role = await ctx.deps.db.rpc("api_admin_role", { p_user_id: user.id });
  if (!role) throw new HttpError(403, "admin_required", "This account does not have admin access.");
  if (!roles.includes(role)) throw new HttpError(403, "owner_required", "Only the store owner can do this.");
  return { id: user.id, email: user.email, role, ip: ctx.ip };
}

const ownerOnly = (ctx) => requireAdmin(ctx, ["owner"]);

function str(v, { min = 0, max = 200, field }) {
  const s = String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (s.length < min || s.length > max) throw new HttpError(400, "invalid_input", `${field} must be ${min ? `${min}–` : "up to "}${max} characters.`, { field });
  return s;
}

function int(v, { min = 0, max = 10_000_000, field, nullable = false }) {
  if (nullable && (v === null || v === "" || v === undefined)) return null;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, "invalid_input", `${field} must be a whole number between ${min} and ${max}.`, { field });
  return n;
}

function httpsUrl(v, field, { allowPath = false } = {}) {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  if (s.length > 500) throw new HttpError(400, "invalid_input", `${field} is too long.`, { field });
  if (allowPath && /^\/(?!\/)[A-Za-z0-9/_\-.?=&#%]*$/.test(s)) return s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new HttpError(400, "invalid_input", `${field} must be a full https:// link.`, { field });
  }
  if (u.protocol !== "https:") throw new HttpError(400, "invalid_input", `${field} must use https://.`, { field });
  return u.toString();
}

function requireUuid(id, what = "Order") {
  if (!UUID_RE.test(String(id || ""))) throw new HttpError(404, "not_found", `${what} not found.`);
  return id;
}

function requireProductId(id) {
  if (!PRODUCT_ID_RE.test(String(id || ""))) throw new HttpError(404, "unknown_product", "Product not found.");
  return id;
}

function adminProduct(row) {
  return {
    ...fromRow(row),
    variants: (row.variants || []).map(variantFromRow),
    unitsSold: Number(row.units_sold || 0),
    hasOrders: row.has_orders === true,
  };
}

// ---------------- Session ----------------

export async function adminLogin(ctx) {
  if (!ctx.deps.db || !ctx.deps.auth) throw new HttpError(503, "admin_not_configured", "Admin is not configured on this server.");
  const body = await ctx.json();
  const email = String(body.email || "").trim().toLowerCase().slice(0, 254);
  const password = String(body.password || "");
  if (!EMAIL_RE.test(email) || !password) throw new HttpError(400, "invalid_credentials", "Enter your email and password.");
  const limit = ctx.deps.limiter.hit(`admin-login:${email}`, 5, 15 * 60 * 1000);
  if (!limit.ok) throw new HttpError(429, "rate_limited", "Too many attempts. Try again later.", { retryAfter: limit.retryAfter });

  let session;
  try {
    session = await ctx.deps.auth.signIn(email, password);
  } catch (error) {
    await ctx.deps.db.rpc("api_admin_audit_write", { p_actor: { email, ip: ctx.ip }, p_action: "admin.login_failed", p_entity_type: "admin", p_entity_id: null, p_details: {} }).catch(() => {});
    if (error instanceof AuthError) throw new HttpError(401, "invalid_credentials", "Email or password is incorrect.");
    throw error;
  }
  const role = await ctx.deps.db.rpc("api_admin_role", { p_user_id: session.user.id });
  if (!role) {
    await ctx.deps.db.rpc("api_admin_audit_write", { p_actor: { id: session.user.id, email, ip: ctx.ip }, p_action: "admin.login_denied", p_entity_type: "admin", p_entity_id: session.user.id, p_details: {} }).catch(() => {});
    throw new HttpError(403, "admin_required", "This account does not have admin access.");
  }
  ctx.deps.sessions.setSession(ctx.res, session);
  await ctx.deps.db.rpc("api_admin_audit_write", { p_actor: { id: session.user.id, email, role, ip: ctx.ip }, p_action: "admin.login", p_entity_type: "admin", p_entity_id: session.user.id, p_details: {} });
  return ctx.send(200, { admin: { email, role } });
}

export async function adminMe(ctx) {
  const actor = await requireAdmin(ctx);
  return ctx.send(200, { admin: { email: actor.email, role: actor.role } });
}

// ---------------- Overview ----------------

export async function overview(ctx) {
  await requireAdmin(ctx);
  const [o, inventory, settings] = await Promise.all([
    call(ctx, "api_admin_overview", {}),
    call(ctx, "api_admin_inventory", {}),
    getSettings(ctx.deps),
  ]);
  const threshold = Number.isInteger(o.low_stock_threshold) ? o.low_stock_threshold : null;
  return ctx.send(200, {
    orders: { total: o.orders_total, paid: o.orders_paid, awaitingPayment: o.awaiting_payment, toFulfil: o.to_fulfil, needsReview: o.needs_review, codToCollect: Number(o.cod_to_collect || 0) },
    revenue: { grossPaidPaise: Number(o.gross_paid_paise), refundedPaise: Number(o.refunded_paise), netPaise: Number(o.gross_paid_paise) - Number(o.refunded_paise) },
    products: { active: o.products_active, archived: o.products_archived, stockUnconfirmed: o.stock_unconfirmed },
    lowStockThreshold: threshold,
    lowStock: threshold === null ? [] : inventory.filter((u) => u.active && u.inventory_confirmed && u.stock_quantity <= threshold)
      .map((u) => ({ productId: u.product_id, variantId: u.variant_id, name: u.variant_name ? `${u.product_name} — ${u.variant_name}` : u.product_name, stock: u.stock_quantity })),
    recentOrders: o.recent_orders.map((r) => ({ id: r.id, publicRef: r.public_ref, createdAt: r.created_at, customer: r.full_name, totalPaise: r.total_paise, paymentStatus: r.payment_status, paymentMethod: r.payment_method || "razorpay", fulfilmentStatus: r.fulfilment_status })),
    setup: {
      shippingConfirmed: settings?.shippingConfirmed === true,
      payments: Boolean(ctx.deps.razorpay),
      codEnabled: settings?.codEnabled === true,
      storage: ctx.deps.storage ? ctx.deps.storage.kind : null,
    },
  });
}

// ---------------- Products ----------------

function productInput(body) {
  return {
    name: str(body.name, { min: 2, max: 120, field: "Name" }),
    slug: (() => {
      const s = str(body.slug, { min: 1, max: 120, field: "URL slug" }).toLowerCase();
      if (!SLUG_RE.test(s)) throw new HttpError(400, "invalid_input", "URL slug may use a–z, 0–9 and single hyphens.", { field: "slug" });
      return s;
    })(),
    description: str(body.description, { min: 1, max: 2000, field: "Description" }),
    category: str(body.category, { min: 1, max: 60, field: "Category" }),
    pricePaise: int(body.pricePaise, { min: 0, max: 10_000_000, field: "Price" }),
    alt: str(body.alt, { max: 300, field: "Image description" }),
    featured: body.featured === true,
  };
}

export async function listProducts(ctx) {
  await requireAdmin(ctx);
  const rows = await call(ctx, "api_admin_products", {});
  return ctx.send(200, { products: rows.map(adminProduct) });
}

export async function getProduct(ctx) {
  await requireAdmin(ctx);
  const id = requireProductId(ctx.params.id);
  const row = (await call(ctx, "api_admin_products", {})).find((p) => p.id === id);
  if (!row) throw new HttpError(404, "unknown_product", "Product not found.");
  return ctx.send(200, { product: adminProduct(row) });
}

export async function createProduct(ctx) {
  const actor = await requireAdmin(ctx);
  const input = productInput(await ctx.json());
  const row = await call(ctx, "api_admin_product_save", { p_id: null, p: input, p_actor: actor });
  return ctx.send(201, { product: fromRow(row) });
}

export async function updateProduct(ctx) {
  const actor = await requireAdmin(ctx);
  const id = requireProductId(ctx.params.id);
  const input = productInput(await ctx.json());
  const row = await call(ctx, "api_admin_product_save", { p_id: id, p: input, p_actor: actor });
  return ctx.send(200, { product: fromRow(row) });
}

export async function archiveProduct(ctx) {
  const actor = await requireAdmin(ctx);
  const row = await call(ctx, "api_admin_product_set_active", { p_id: requireProductId(ctx.params.id), p_active: false, p_actor: actor });
  return ctx.send(200, { product: fromRow(row) });
}

export async function restoreProduct(ctx) {
  const actor = await requireAdmin(ctx);
  const row = await call(ctx, "api_admin_product_set_active", { p_id: requireProductId(ctx.params.id), p_active: true, p_actor: actor });
  return ctx.send(200, { product: fromRow(row) });
}

export async function deleteProduct(ctx) {
  const actor = await ownerOnly(ctx);
  const result = await call(ctx, "api_admin_product_delete", { p_id: requireProductId(ctx.params.id), p_actor: actor });
  for (const url of result.images || []) {
    if (ctx.deps.storage?.owns(url)) await ctx.deps.storage.remove(url).catch(() => {});
  }
  return ctx.send(200, { deleted: true });
}

// ---------------- Images ----------------

async function readImage(ctx) {
  if (!ctx.deps.storage) throw new HttpError(503, "storage_not_configured", "Image storage is not configured.");
  const raw = await ctx.raw(MAX_IMAGE_BYTES + 1);
  if (raw.length > MAX_IMAGE_BYTES) throw new HttpError(413, "image_too_large", "Images must be 4 MB or smaller.");
  const kind = sniffImage(raw);
  if (!kind) throw new HttpError(415, "unsupported_image", "Upload a JPEG, PNG or WebP image.");
  return { raw, kind };
}

export async function uploadImage(ctx) {
  const actor = await requireAdmin(ctx);
  const id = requireProductId(ctx.params.id);
  const { raw, kind } = await readImage(ctx);
  const products = await call(ctx, "api_admin_products", {});
  const product = products.find((p) => p.id === id);
  if (!product) throw new HttpError(404, "unknown_product", "Product not found.");
  if ((product.images || []).length >= 10) throw new HttpError(409, "too_many_images", ADMIN_ERRORS.too_many_images[1]);

  const url = await ctx.deps.storage.put(newObjectPath(id, kind.ext), raw, kind.type);
  try {
    const row = await call(ctx, "api_admin_product_image_add", { p_id: id, p_url: url, p_actor: actor });
    return ctx.send(201, { product: fromRow(row), url });
  } catch (error) {
    await ctx.deps.storage.remove(url).catch(() => {}); // don't leave orphans
    throw error;
  }
}

export async function reorderImages(ctx) {
  const actor = await requireAdmin(ctx);
  const body = await ctx.json();
  if (!Array.isArray(body.images)) throw new HttpError(400, "invalid_images", ADMIN_ERRORS.invalid_images[1]);
  const row = await call(ctx, "api_admin_product_images", { p_id: requireProductId(ctx.params.id), p_images: body.images.map(String), p_actor: actor });
  return ctx.send(200, { product: fromRow(row) });
}

export async function removeImage(ctx) {
  const actor = await requireAdmin(ctx);
  const url = String(ctx.url.searchParams.get("url") || "");
  const row = await call(ctx, "api_admin_product_image_remove", { p_id: requireProductId(ctx.params.id), p_url: url, p_actor: actor });
  // Only files we uploaded are deleted from storage; repository assets are just unlinked.
  if (ctx.deps.storage?.owns(url)) await ctx.deps.storage.remove(url).catch(() => {});
  return ctx.send(200, { product: fromRow(row) });
}

// ---------------- Variants ----------------

function variantInput(body) {
  const sku = body.sku ? str(body.sku, { max: 60, field: "SKU" }) : null;
  if (sku && !/^[A-Za-z0-9._-]+$/.test(sku)) throw new HttpError(400, "invalid_input", "SKU may use letters, numbers, dot, dash and underscore.", { field: "sku" });
  return {
    name: str(body.name, { min: 1, max: 80, field: "Option name" }),
    sku,
    pricePaise: int(body.pricePaise, { min: 0, max: 10_000_000, field: "Option price", nullable: true }),
    active: body.active !== false,
    position: int(body.position ?? 0, { min: 0, max: 999, field: "Position" }),
  };
}

export async function saveVariant(ctx) {
  const actor = await requireAdmin(ctx);
  const productId = requireProductId(ctx.params.id);
  const variantId = ctx.params.variantId ? requireUuid(ctx.params.variantId, "Option") : null;
  const row = await call(ctx, "api_admin_variant_save", { p_product_id: productId, p_variant_id: variantId, p: variantInput(await ctx.json()), p_actor: actor });
  return ctx.send(variantId ? 200 : 201, { variant: variantFromRow(row) });
}

export async function deleteVariant(ctx) {
  const actor = await requireAdmin(ctx);
  requireProductId(ctx.params.id);
  return ctx.send(200, await call(ctx, "api_admin_variant_delete", { p_variant_id: requireUuid(ctx.params.variantId, "Option"), p_actor: actor }));
}

// ---------------- Inventory ----------------

export async function inventory(ctx) {
  await requireAdmin(ctx);
  const [rows, settings] = await Promise.all([call(ctx, "api_admin_inventory", {}), getSettings(ctx.deps)]);
  const threshold = Number.isInteger(settings?.lowStockThreshold) ? settings.lowStockThreshold : null;
  return ctx.send(200, {
    lowStockThreshold: threshold,
    units: rows.map((u) => ({
      productId: u.product_id, variantId: u.variant_id, productName: u.product_name, variantName: u.variant_name,
      active: u.active, stock: u.stock_quantity, confirmed: u.inventory_confirmed, reserved: Number(u.reserved),
      low: threshold !== null && u.inventory_confirmed && u.stock_quantity !== null && u.stock_quantity <= threshold,
    })),
  });
}

export async function adjustStock(ctx) {
  const actor = await requireAdmin(ctx);
  const body = await ctx.json();
  const mode = body.mode === "delta" ? "delta" : body.mode === "set" ? "set" : null;
  if (!mode) throw new HttpError(400, "invalid_input", "Choose “set count” or “adjust”.");
  const result = await call(ctx, "api_admin_stock_adjust", {
    p_product_id: requireProductId(body.productId),
    p_variant_id: body.variantId ? requireUuid(body.variantId, "Option") : null,
    p_mode: mode,
    p_quantity: int(body.quantity, { min: mode === "set" ? 0 : -100000, max: 100000, field: "Quantity" }),
    p_reason: str(body.reason, { min: 3, max: 200, field: "Reason" }),
    p_actor: actor,
  });
  return ctx.send(200, { result });
}

export async function movements(ctx) {
  await requireAdmin(ctx);
  const productId = ctx.url.searchParams.get("productId");
  const rows = await call(ctx, "api_admin_movements", { p_product_id: productId ? requireProductId(productId) : null, p_limit: 200 });
  return ctx.send(200, { movements: rows });
}

// ---------------- Orders ----------------

function adminOrderView(o) {
  return {
    ...orderView(o, { full: true }),
    needsReview: o.needs_review === true,
    reviewReason: o.review_reason || null,
    refundedPaise: Number(o.refunded_paise || 0),
    razorpayOrderId: o.razorpay_order_id || null,
    razorpayPaymentId: o.razorpay_payment_id || null,
    stockReleased: o.stock_released === true,
    payments: (o.payments || []).map((t) => ({ status: t.status, amountPaise: t.amount_paise, source: t.source, paymentId: t.razorpay_payment_id, detail: t.detail, createdAt: t.created_at })),
    refunds: (o.refunds || []).map((r) => ({ id: r.id, amountPaise: r.amount_paise, status: r.status, reason: r.reason, restock: r.restock, razorpayRefundId: r.razorpay_refund_id, error: r.error, by: r.created_by_email, createdAt: r.created_at })),
    history: (o.history || []).map((h) => ({ action: h.action, by: h.actor_email, details: h.details, at: h.created_at })),
  };
}

async function loadAdminOrder(ctx, id) {
  const o = await call(ctx, "api_admin_order_get", { p_order_id: requireUuid(id) });
  if (!o) throw new HttpError(404, "not_found", "Order not found.");
  return o;
}

export async function listOrders(ctx) {
  await requireAdmin(ctx);
  const sp = ctx.url.searchParams;
  const payment = sp.get("payment") || "";
  const fulfilment = sp.get("fulfilment") || "";
  const method = sp.get("method") || "";
  if (method && !["razorpay", "cod"].includes(method)) throw new HttpError(400, "invalid_status", "Unknown payment method.");
  if (payment && !PAYMENT_STATUSES.includes(payment)) throw new HttpError(400, "invalid_status", "Unknown payment status.");
  if (fulfilment && !FULFILMENT_STATUSES.includes(fulfilment)) throw new HttpError(400, "invalid_status", "Unknown fulfilment status.");
  const r = await call(ctx, "api_admin_orders", {
    p: {
      q: (sp.get("q") || "").trim().replace(/[%_\\]/g, "").slice(0, 80),
      payment, fulfilment, method,
      review: sp.get("review") === "1",
      limit: int(sp.get("limit") || 25, { min: 1, max: 100, field: "limit" }),
      offset: int(sp.get("offset") || 0, { min: 0, max: 1_000_000, field: "offset" }),
    },
  });
  return ctx.send(200, {
    total: Number(r.total),
    orders: r.orders.map((o) => ({ id: o.id, publicRef: o.public_ref, createdAt: o.created_at, customer: o.full_name, email: o.email, totalPaise: o.total_paise, paymentStatus: o.payment_status, paymentMethod: o.payment_method || "razorpay", fulfilmentStatus: o.fulfilment_status, needsReview: o.needs_review, itemCount: Number(o.item_count) })),
  });
}

export async function getOrder(ctx) {
  await requireAdmin(ctx);
  return ctx.send(200, { order: adminOrderView(await loadAdminOrder(ctx, ctx.params.id)) });
}

export async function setFulfilment(ctx) {
  const actor = await requireAdmin(ctx);
  const body = await ctx.json();
  const status = String(body.status || "");
  if (!["confirmed", "processing", "shipped", "delivered", "on_hold"].includes(status)) throw new HttpError(400, "invalid_status", "Unknown fulfilment status.");
  const tracking = {};
  if ("trackingNumber" in body) tracking.number = str(body.trackingNumber, { max: 80, field: "Tracking number" });
  if ("courier" in body) tracking.courier = str(body.courier, { max: 80, field: "Courier" });
  if ("trackingUrl" in body) tracking.url = httpsUrl(body.trackingUrl, "Tracking link") || "";
  if (body.note) tracking.note = str(body.note, { max: 300, field: "Note" });
  const o = await call(ctx, "api_admin_set_fulfilment", { p_order_id: requireUuid(ctx.params.id), p_status: status, p_tracking: tracking, p_actor: actor });
  return ctx.send(200, { order: adminOrderView(o) });
}

export async function resolveReview(ctx) {
  const actor = await requireAdmin(ctx);
  const body = await ctx.json();
  const o = await call(ctx, "api_admin_resolve_review", { p_order_id: requireUuid(ctx.params.id), p_note: str(body.note, { min: 3, max: 300, field: "Note" }), p_actor: actor });
  return ctx.send(200, { order: adminOrderView(o) });
}

// Asks Razorpay for the truth. The only way an admin can move payment status forward.
export async function reconcileOrder(ctx) {
  const actor = await requireAdmin(ctx);
  const order = await loadAdminOrder(ctx, ctx.params.id);
  let state = order.payment_status;
  if (["pending", "authorized"].includes(order.payment_status)) {
    try {
      state = (await reconcileWithRazorpay(ctx.deps, order, "admin_reconcile")).state;
    } catch (error) {
      if (error instanceof RazorpayError) throw new HttpError(502, "payment_gateway_error", "Razorpay could not be reached. Try again shortly.");
      throw error;
    }
  }
  await call(ctx, "api_admin_audit_write", { p_actor: actor, p_action: "order.reconciled", p_entity_type: "order", p_entity_id: order.id, p_details: { result: state } });
  return ctx.send(200, { result: state, order: adminOrderView(await loadAdminOrder(ctx, order.id)) });
}

// Cancels an UNPAID order (releases its reservation) after confirming with Razorpay
// that no payment was captured. Paid orders must go through a refund.
export async function cancelUnpaid(ctx) {
  const actor = await requireAdmin(ctx);
  const order = await loadAdminOrder(ctx, ctx.params.id);
  if (order.payment_status !== "pending") {
    throw new HttpError(409, "use_refund", ["paid", "partially_refunded"].includes(order.payment_status)
      ? "This order is paid. Use “Refund” to cancel it." : "Only orders awaiting payment can be cancelled here.");
  }
  if (order.payment_method === "cod") {
    await call(ctx, "api_release_order", { p_order_id: order.id, p_status: "cancelled", p_reason: `COD order cancelled by ${actor.email}` });
    await call(ctx, "api_admin_audit_write", { p_actor: actor, p_action: "order.cod_cancelled", p_entity_type: "order", p_entity_id: order.id, p_details: {} });
    return ctx.send(200, { order: adminOrderView(await loadAdminOrder(ctx, order.id)) });
  }
  let r;
  try {
    r = await reconcileWithRazorpay(ctx.deps, order, "admin_cancel_reconcile");
  } catch (error) {
    if (error instanceof RazorpayError || error instanceof HttpError) throw new HttpError(502, "payment_gateway_error", "Couldn't confirm the payment status with Razorpay, so the order was not cancelled.");
    throw error;
  }
  if (r.state !== "none") {
    return ctx.send(409, { error: "payment_found", message: `Razorpay reports a payment (${r.state}). The order was not cancelled.`, order: adminOrderView(await loadAdminOrder(ctx, order.id)) });
  }
  await ctx.deps.db.rpc("api_release_order", { p_order_id: order.id, p_status: "cancelled", p_reason: `cancelled by ${actor.email}` });
  await call(ctx, "api_admin_audit_write", { p_actor: actor, p_action: "order.cancelled_unpaid", p_entity_type: "order", p_entity_id: order.id, p_details: {} });
  return ctx.send(200, { order: adminOrderView(await loadAdminOrder(ctx, order.id)) });
}

export async function refundOrder(ctx) {
  const actor = await ownerOnly(ctx);
  if (!ctx.deps.razorpay) throw new HttpError(503, "payments_not_configured", reasonMessage("payments_not_configured"));
  const body = await ctx.json();
  const id = requireUuid(ctx.params.id);
  const begin = await call(ctx, "api_admin_refund_begin", {
    p_order_id: id,
    p_amount: int(body.amountPaise, { min: 1, max: 2_000_000_000, field: "Refund amount" }),
    p_reason: str(body.reason, { min: 3, max: 300, field: "Reason" }),
    p_restock: body.restock === true,
    p_actor: actor,
  });

  let rzp;
  try {
    rzp = await ctx.deps.razorpay.createRefund(begin.razorpay_payment_id, {
      amount: begin.amount_paise,
      notes: { amaanat_refund_id: begin.refund_id, amaanat_ref: begin.public_ref },
    });
  } catch (error) {
    if (error instanceof RazorpayError && error.status === 0) {
      // Unknown outcome (timeout). Leave it 'creating'; the refund webhook will attach and settle it.
      return ctx.send(202, { status: "unknown", message: "Razorpay didn't answer in time. The refund will update when Razorpay confirms it — don't retry yet.", order: adminOrderView(await loadAdminOrder(ctx, id)) });
    }
    await call(ctx, "api_admin_refund_result", { p_refund_id: begin.refund_id, p_razorpay_refund_id: null, p_status: "failed", p_error: String(error.message).slice(0, 300), p_actor: actor });
    throw new HttpError(502, "refund_failed", `Razorpay refused the refund: ${error.message}`);
  }
  const status = rzp.status === "processed" ? "processed" : rzp.status === "failed" ? "failed" : "pending";
  const o = await call(ctx, "api_admin_refund_result", { p_refund_id: begin.refund_id, p_razorpay_refund_id: rzp.id, p_status: status, p_error: null, p_actor: actor });
  return ctx.send(200, { status, order: adminOrderView(await loadAdminOrder(ctx, o.id)) });
}

// Records the cash for a delivered Cash on Delivery order (owner only, audited).
export async function codCollected(ctx) {
  const actor = await ownerOnly(ctx);
  const body = await ctx.json();
  const o = await call(ctx, "api_admin_cod_collected", {
    p_order_id: requireUuid(ctx.params.id),
    p_note: str(body.note, { min: 3, max: 300, field: "Note" }),
    p_actor: actor,
  });
  return ctx.send(200, { order: adminOrderView(o) });
}

// ---------------- Customers (privacy-limited) ----------------

function maskEmail(e) {
  const [u, d] = String(e).split("@");
  return `${u.slice(0, 1)}${"•".repeat(Math.max(2, u.length - 1))}@${d}`;
}
const maskPhone = (p) => (p ? `••••••${String(p).slice(-4)}` : null);

export async function listCustomers(ctx) {
  const actor = await requireAdmin(ctx);
  const sp = ctx.url.searchParams;
  const r = await call(ctx, "api_admin_customers", {
    p: {
      q: (sp.get("q") || "").trim().replace(/[%_\\]/g, "").slice(0, 80),
      limit: int(sp.get("limit") || 25, { min: 1, max: 100, field: "limit" }),
      offset: int(sp.get("offset") || 0, { min: 0, max: 1_000_000, field: "offset" }),
    },
  });
  const full = actor.role === "owner";
  return ctx.send(200, {
    total: Number(r.total),
    masked: !full,
    customers: r.customers.map((c) => ({
      email: full ? c.email : maskEmail(c.email),
      key: full ? c.email : null,
      fullName: c.full_name,
      phone: full ? c.phone : maskPhone(c.phone),
      orders: Number(c.orders), paidOrders: Number(c.paid_orders), paidPaise: Number(c.paid_paise),
      lastOrderAt: c.last_order_at, hasAccount: c.has_account,
    })),
  });
}

export async function getCustomer(ctx) {
  const actor = await ownerOnly(ctx);
  const email = String(ctx.url.searchParams.get("email") || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "invalid_input", "Customer email required.");
  const c = await call(ctx, "api_admin_customer", { p_email: email });
  if (!c.orders.length) throw new HttpError(404, "not_found", "No orders for that customer.");
  await call(ctx, "api_admin_audit_write", { p_actor: actor, p_action: "customer.viewed", p_entity_type: "customer", p_entity_id: email, p_details: {} });
  return ctx.send(200, {
    email: c.email,
    account: c.account ? { fullName: c.account.full_name, phone: c.account.phone, savedAddresses: Number(c.account.addresses) } : null,
    orders: c.orders.map((o) => ({ id: o.id, publicRef: o.public_ref, createdAt: o.created_at, fullName: o.full_name, phone: o.phone, city: o.address_city, pin: o.address_pin, totalPaise: o.total_paise, paymentStatus: o.payment_status, fulfilmentStatus: o.fulfilment_status })),
  });
}

// ---------------- Settings + pages ----------------

const SETTING_FIELDS = {
  storeName: ["store_name", (v) => str(v, { max: 80, field: "Store name" }) || null],
  contactEmail: ["contact_email", (v) => { if (!v) return null; const s = str(v, { max: 254, field: "Contact email" }).toLowerCase(); if (!EMAIL_RE.test(s)) throw new HttpError(400, "invalid_input", "Enter a valid contact email.", { field: "contactEmail" }); return s; }],
  contactPhone: ["contact_phone", (v) => { if (!v) return null; const s = str(v, { max: 20, field: "Phone" }); if (!/^[+0-9 ()-]{6,20}$/.test(s)) throw new HttpError(400, "invalid_input", "Enter a valid phone number.", { field: "contactPhone" }); return s; }],
  whatsappE164: ["whatsapp_e164", (v) => { if (!v) return null; const s = String(v).replace(/[\s-]/g, ""); if (!/^\+[1-9]\d{7,14}$/.test(s)) throw new HttpError(400, "invalid_input", "WhatsApp number must be in international format, e.g. +919876543210.", { field: "whatsappE164" }); return s; }],
  businessAddress: ["business_address", (v) => str(v, { max: 300, field: "Address" }) || null],
  instagramUrl: ["instagram_url", (v) => httpsUrl(v, "Instagram link")],
  facebookUrl: ["facebook_url", (v) => httpsUrl(v, "Facebook link")],
  youtubeUrl: ["youtube_url", (v) => httpsUrl(v, "YouTube link")],
  pinterestUrl: ["pinterest_url", (v) => httpsUrl(v, "Pinterest link")],
  logoUrl: ["logo_url", (v) => httpsUrl(v, "Logo", { allowPath: true })],
  announcementText: ["announcement_text", (v) => str(v, { max: 160, field: "Announcement" }) || null],
  announcementLink: ["announcement_link", (v) => httpsUrl(v, "Announcement link", { allowPath: true })],
  announcementEnabled: ["announcement_enabled", (v) => v === true],
  shippingPaise: ["shipping_paise", (v) => int(v, { min: 0, max: 1_000_000, field: "Shipping charge", nullable: true })],
  shippingConfirmed: ["shipping_confirmed", (v) => v === true],
  codEnabled: ["cod_enabled", (v) => v === true],
  taxConfirmed: ["tax_confirmed", (v) => v === true],
  taxRateBps: ["tax_rate_bps", (v) => int(v, { min: 0, max: 10000, field: "Tax rate", nullable: true })],
  lowStockThreshold: ["low_stock_threshold", (v) => int(v, { min: 0, max: 1000, field: "Low-stock threshold", nullable: true })],
  homepage: ["homepage", (v) => {
    const keys = ["heroEyebrow", "heroTitle", "heroSubtitle", "heroText", "heroImage", "storyTitle", "storyText"];
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "invalid_input", "Homepage content is invalid.");
    const out = {};
    for (const k of keys) {
      if (v[k] == null || v[k] === "") continue;
      out[k] = k === "heroImage" ? httpsUrl(v[k], "Hero image", { allowPath: true }) : str(v[k], { max: 1000, field: k });
    }
    return out;
  }],
};

function settingsView(row) {
  const out = {};
  for (const [key, [col]] of Object.entries(SETTING_FIELDS)) out[key] = row?.[col] ?? (key === "homepage" ? {} : null);
  return out;
}

export async function getSettingsAdmin(ctx) {
  await requireAdmin(ctx);
  return ctx.send(200, { settings: settingsView(await call(ctx, "api_get_settings", {})) });
}

export async function updateSettings(ctx) {
  const actor = await ownerOnly(ctx);
  const body = await ctx.json();
  const patch = {};
  for (const [key, [col, parse]] of Object.entries(SETTING_FIELDS)) if (key in body) patch[col] = parse(body[key]);
  if (!Object.keys(patch).length) throw new HttpError(400, "invalid_input", "Nothing to update.");
  // Shipping/tax can only be marked confirmed with a value present.
  const current = await call(ctx, "api_get_settings", {});
  const merged = { ...current, ...patch };
  if (merged.shipping_confirmed && !Number.isInteger(merged.shipping_paise)) throw new HttpError(400, "invalid_input", "Enter the shipping charge (0 for free shipping) before confirming it.", { field: "shippingPaise" });
  if (merged.tax_confirmed && !Number.isInteger(merged.tax_rate_bps)) throw new HttpError(400, "invalid_input", "Enter the tax rate before enabling tax.", { field: "taxRateBps" });
  const row = await call(ctx, "api_admin_settings_update", { p: patch, p_actor: actor });
  return ctx.send(200, { settings: settingsView(row) });
}

export async function uploadLogo(ctx) {
  const actor = await ownerOnly(ctx);
  const { raw, kind } = await readImage(ctx);
  const url = await ctx.deps.storage.put(newSiteAssetPath(kind.ext), raw, kind.type);
  const before = (await call(ctx, "api_get_settings", {}))?.logo_url;
  const row = await call(ctx, "api_admin_settings_update", { p: { logo_url: url }, p_actor: actor });
  if (before && ctx.deps.storage.owns(before)) await ctx.deps.storage.remove(before).catch(() => {});
  return ctx.send(201, { settings: settingsView(row), url });
}

export async function listPages(ctx) {
  await requireAdmin(ctx);
  const rows = await call(ctx, "api_admin_pages", {});
  const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r]));
  return ctx.send(200, {
    pages: PAGE_SLUGS.map((slug) => ({
      slug, title: bySlug[slug]?.title || "", body: bySlug[slug]?.body || "",
      published: bySlug[slug]?.published === true, updatedAt: bySlug[slug]?.updated_at || null, updatedBy: bySlug[slug]?.updated_by || null,
    })),
  });
}

export async function savePage(ctx) {
  const actor = await ownerOnly(ctx);
  const slug = String(ctx.params.slug || "");
  if (!PAGE_SLUGS.includes(slug)) throw new HttpError(404, "not_found", "Unknown page.");
  const body = await ctx.json();
  const published = body.published === true;
  const text = str(body.body, { min: published ? 20 : 0, max: 50000, field: "Page text" });
  const row = await call(ctx, "api_admin_page_save", { p_slug: slug, p_title: str(body.title, { min: 1, max: 120, field: "Title" }), p_body: text, p_published: published, p_actor: actor });
  return ctx.send(200, { page: { slug: row.slug, title: row.title, body: row.body, published: row.published, updatedAt: row.updated_at } });
}

// ---------------- Audit ----------------

export async function auditLog(ctx) {
  await ownerOnly(ctx);
  const sp = ctx.url.searchParams;
  const rows = await call(ctx, "api_admin_audit", {
    p: {
      entity_type: ["product", "order", "settings", "page", "admin", "customer"].includes(sp.get("entity")) ? sp.get("entity") : "",
      action: (sp.get("action") || "").replace(/[^a-z_.]/g, "").slice(0, 40),
      limit: 100,
      offset: int(sp.get("offset") || 0, { min: 0, max: 1_000_000, field: "offset" }),
    },
  });
  return ctx.send(200, { entries: rows.map((a) => ({ id: a.id, at: a.created_at, actor: a.actor_email, role: a.actor_role, action: a.action, entityType: a.entity_type, entityId: a.entity_id, details: a.details, ip: a.ip })) });
}

export async function newsletterList(ctx) {
  await ownerOnly(ctx);
  const sp = ctx.url.searchParams;
  const r = await call(ctx, "api_admin_newsletter", { p_limit: 500, p_offset: int(sp.get("offset") || 0, { min: 0, max: 1_000_000, field: "offset" }) });
  return ctx.send(200, { total: Number(r.total), subscribers: r.rows.map((x) => ({ email: x.email, consentAt: x.consent_at, source: x.source })) });
}

// ---------------------------------------------------------------
// Website content (CMS). Owners edit drafts, preview, publish and
// restore earlier versions. Everything is validated by lib/cms.js.
// ---------------------------------------------------------------
const CMS_BODY_LIMIT = 512 * 1024;
const CMS_ERRORS = {
  nothing_to_publish: [409, "Save a draft before publishing."],
  version_not_found: [404, "That version no longer exists."],
};

async function cmsCall(ctx, name, args) {
  try {
    return await call(ctx, name, args);
  } catch (error) {
    const known = error?.name === "DbError" && CMS_ERRORS[error.code];
    if (known) throw new HttpError(known[0], error.code, known[1]);
    if (error?.name === "DbError" && /cms_|does not exist/.test(error.message)) {
      throw new HttpError(503, "cms_not_installed", "Website editing needs database migration 007_cms.sql. Run it in the Supabase SQL editor.");
    }
    throw error;
  }
}

function cmsKey(ctx) {
  const key = String(ctx.params.key || "");
  if (!DOC_KEYS.includes(key)) throw new HttpError(404, "not_found", "Unknown content.");
  return key;
}

async function cmsDefaults(ctx, key) {
  const content = await call(ctx, "api_public_content", {}).catch(() => null);
  const homepage = { ...DEFAULT_COPY, ...Object.fromEntries(Object.entries(content?.homepage || {}).filter(([, v]) => v)) };
  return defaultDocument(key, { homepage, promise: PROMISE });
}

async function cmsView(ctx, key, state) {
  const hasDraft = state?.draft && Object.keys(state.draft).length > 0;
  return {
    key,
    content: hasDraft ? state.draft : await cmsDefaults(ctx, key),
    isDefault: !hasDraft,
    hasUnpublishedChanges: Boolean(state?.hasUnpublishedChanges),
    published: Boolean(state?.published),
    publishedVersion: state?.publishedVersion || 0,
    publishedAt: state?.publishedAt || null,
    publishedBy: state?.publishedBy || null,
    draftUpdatedAt: hasDraft ? state.draftUpdatedAt : null,
    draftUpdatedBy: hasDraft ? state.draftUpdatedBy : null,
    versions: state?.versions || [],
  };
}

export async function cmsSchema(ctx) {
  await requireAdmin(ctx);
  return ctx.send(200, cmsSchemaDef());
}

export async function cmsGet(ctx) {
  await requireAdmin(ctx);
  const key = cmsKey(ctx);
  return ctx.send(200, await cmsView(ctx, key, await cmsCall(ctx, "api_admin_cms_get", { p_key: key })));
}

export async function cmsSaveDraft(ctx) {
  const actor = await ownerOnly(ctx);
  const key = cmsKey(ctx);
  const body = await ctx.json(CMS_BODY_LIMIT);
  const content = cleanDocument(key, body.content);
  const state = await cmsCall(ctx, "api_admin_cms_save_draft", { p_key: key, p_content: content, p_actor: actor });
  return ctx.send(200, await cmsView(ctx, key, state));
}

// Optional body.content: saves it as the draft first, then publishes.
export async function cmsPublish(ctx) {
  const actor = await ownerOnly(ctx);
  const key = cmsKey(ctx);
  const body = await ctx.json(CMS_BODY_LIMIT);
  if (body?.content) await cmsCall(ctx, "api_admin_cms_save_draft", { p_key: key, p_content: cleanDocument(key, body.content), p_actor: actor });
  const state = await cmsCall(ctx, "api_admin_cms_publish", { p_key: key, p_actor: actor });
  return ctx.send(200, await cmsView(ctx, key, state));
}

export async function cmsRestore(ctx) {
  const actor = await ownerOnly(ctx);
  const key = cmsKey(ctx);
  const version = int((await ctx.json()).version, { min: 1, max: 1_000_000, field: "Version" });
  const state = await cmsCall(ctx, "api_admin_cms_restore", { p_key: key, p_version: version, p_actor: actor });
  return ctx.send(200, await cmsView(ctx, key, state));
}

export async function cmsDiscard(ctx) {
  const actor = await ownerOnly(ctx);
  const key = cmsKey(ctx);
  const state = await cmsCall(ctx, "api_admin_cms_discard", { p_key: key, p_actor: actor });
  return ctx.send(200, await cmsView(ctx, key, state));
}

// Images for website sections. Old images are kept in storage because earlier
// published versions may still use them.
export async function cmsUploadImage(ctx) {
  const actor = await ownerOnly(ctx);
  const { raw, kind } = await readImage(ctx);
  const url = await ctx.deps.storage.put(newSiteAssetPath(kind.ext), raw, kind.type);
  await call(ctx, "api_admin_audit_write", { p_actor: actor, p_action: "cms.image_uploaded", p_entity_type: "cms", p_entity_id: null, p_details: { url } }).catch(() => {});
  return ctx.send(201, { url });
}

// ---------------------------------------------------------------
// Team (owner only): add, re-role and remove admins. The database
// also refuses removing/demoting yourself and losing the last owner.
// ---------------------------------------------------------------
const TEAM_ERRORS = {
  account_not_found: [404, "No account uses this email yet. Ask them to create one at /account first, then add them here."],
  already_admin: [409, "This person already has admin access. Change their role in the list instead."],
  not_admin: [404, "This person no longer has admin access."],
  last_owner: [409, "The store must always have at least one owner."],
  cannot_change_self: [409, "You can't change your own role. Ask another owner to do it."],
  cannot_remove_self: [409, "You can't remove yourself. Ask another owner to do it."],
  invalid_role: [400, "Choose Owner or Manager."],
};
const TEAM_ROLES = ["owner", "manager"];

async function teamCall(ctx, name, args) {
  try {
    return await call(ctx, name, args);
  } catch (error) {
    const known = error?.name === "DbError" && TEAM_ERRORS[error.code];
    if (known) throw new HttpError(known[0], error.code, known[1]);
    if (error?.name === "DbError" && /api_admin_team|does not exist/.test(error.message)) {
      throw new HttpError(503, "team_not_installed", "Team management needs database migration 008_team.sql. Run it in the Supabase SQL editor.");
    }
    throw error;
  }
}

const teamView = (rows, actor) => ({
  members: (rows || []).map((r) => ({ userId: r.user_id, email: r.email, role: r.role, addedAt: r.created_at, isYou: r.user_id === actor.id })),
});

function teamRole(v) {
  const role = String(v || "");
  if (!TEAM_ROLES.includes(role)) throw new HttpError(400, "invalid_role", TEAM_ERRORS.invalid_role[1], { field: "role" });
  return role;
}

export async function teamList(ctx) {
  const actor = await ownerOnly(ctx);
  return ctx.send(200, teamView(await teamCall(ctx, "api_admin_team_list", {}), actor));
}

export async function teamAdd(ctx) {
  const actor = await ownerOnly(ctx);
  const body = await ctx.json();
  const email = String(body.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, "invalid_input", "Enter a valid email address.", { field: "email" });
  const rows = await teamCall(ctx, "api_admin_team_add", { p_email: email, p_role: teamRole(body.role), p_actor: actor });
  return ctx.send(201, teamView(rows, actor));
}

export async function teamSetRole(ctx) {
  const actor = await ownerOnly(ctx);
  const rows = await teamCall(ctx, "api_admin_team_set_role", { p_user_id: requireUuid(ctx.params.userId, "Team member"), p_role: teamRole((await ctx.json()).role), p_actor: actor });
  return ctx.send(200, teamView(rows, actor));
}

export async function teamRemove(ctx) {
  const actor = await ownerOnly(ctx);
  const rows = await teamCall(ctx, "api_admin_team_remove", { p_user_id: requireUuid(ctx.params.userId, "Team member"), p_actor: actor });
  return ctx.send(200, teamView(rows, actor));
}
