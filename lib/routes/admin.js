// Admin API (ported from the original lib/server.js with input hardening).
// Requires the Supabase (PostgREST) driver. Admins are Supabase Auth users
// listed in public.admin_users. Admin UI is out of scope for Part 1.
import { fromRow, toSettings } from "../catalogue.js";
import { HttpError } from "../http.js";
import { getSettings, orderView } from "../services.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FULFILMENT = new Set(["pending", "confirmed", "processing", "shipped", "delivered", "cancelled", "on_hold"]);
const enc = encodeURIComponent;

function rest(ctx) {
  if (!ctx.deps.db?.rest) throw new HttpError(503, "admin_requires_supabase", "Admin endpoints need the Supabase database driver.");
  return ctx.deps.db.rest;
}

async function requireAdmin(ctx) {
  const db = rest(ctx);
  const token = String(ctx.req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token || !ctx.deps.auth) throw new HttpError(401, "admin_required", "Sign in as an admin.");
  const user = await ctx.deps.auth.getUser(token);
  if (!user?.id || !UUID_RE.test(user.id)) throw new HttpError(401, "admin_required", "Sign in as an admin.");
  const rows = await db(`admin_users?user_id=eq.${enc(user.id)}&select=user_id`);
  if (!rows?.length) throw new HttpError(403, "admin_required", "This account is not an Amaanat admin.");
  return { db, user };
}

function requireUuid(id) {
  if (!UUID_RE.test(String(id || ""))) throw new HttpError(400, "invalid_id", "Invalid id.");
  return id;
}

export async function adminLogin(ctx) {
  rest(ctx);
  const body = await ctx.json();
  const email = String(body.email || "").trim().toLowerCase();
  const limit = ctx.deps.limiter.hit(`admin-login:${email}`, 5, 15 * 60 * 1000);
  if (!limit.ok) throw new HttpError(429, "rate_limited", "Too many attempts. Try again later.");
  const session = await ctx.deps.auth.signIn(email, String(body.password || "")).catch(() => null);
  if (!session?.accessToken) throw new HttpError(401, "admin_required", "Those details are not an admin login.");
  const rows = await ctx.deps.db.rest(`admin_users?user_id=eq.${enc(session.user.id)}&select=user_id`);
  if (!rows?.length) throw new HttpError(403, "admin_required", "This account is not an Amaanat admin.");
  return ctx.send(200, { accessToken: session.accessToken, expiresIn: session.expiresIn });
}

export async function adminOverview(ctx) {
  const { db } = await requireAdmin(ctx);
  const [orders, products, site] = await Promise.all([
    db("orders?select=payment_status,fulfilment_status,total_paise,needs_review"),
    db("products?select=id,name,active,inventory_confirmed,stock_quantity"),
    getSettings(ctx.deps),
  ]);
  const threshold = site?.lowStockThreshold ?? 2;
  return ctx.send(200, {
    totalOrders: orders.length,
    revenuePaise: orders.filter((o) => o.payment_status === "paid").reduce((s, o) => s + o.total_paise, 0),
    pendingOrders: orders.filter((o) => o.payment_status === "pending").length,
    needsReview: orders.filter((o) => o.needs_review).length,
    completedOrders: orders.filter((o) => o.fulfilment_status === "delivered").length,
    activeProducts: products.filter((p) => p.active).length,
    unconfirmedStock: products.filter((p) => p.active && !p.inventory_confirmed).map((p) => p.id),
    lowStock: products.filter((p) => p.inventory_confirmed && p.stock_quantity != null && p.stock_quantity <= threshold),
  });
}

export async function adminProducts(ctx) {
  const { db } = await requireAdmin(ctx);
  if (ctx.req.method === "GET") {
    return ctx.send(200, { products: (await db("products?select=*&order=created_at.asc")).map(fromRow) });
  }
  const body = await ctx.json();
  const pricePaise = Number(body.pricePaise);
  if (!body.name || !/^[a-z0-9-]{1,120}$/.test(String(body.slug || "")) || !body.description || !body.category || !Number.isInteger(pricePaise) || pricePaise < 0) {
    throw new HttpError(400, "invalid_product", "Name, slug (a-z, 0-9, -), description, category and a whole-paise price are required.");
  }
  const id = body.id && PRODUCT_ID_RE.test(body.id) ? body.id : `p${Date.now()}`;
  const image = String(body.image || "");
  const inserted = await db("products", {
    method: "POST",
    body: {
      id, slug: body.slug, name: String(body.name).slice(0, 120), description: String(body.description).slice(0, 2000),
      category: String(body.category).slice(0, 60), price_paise: pricePaise, image_path: image,
      images: image ? [image] : [], alt_text: body.alt || `Catalogue photograph of ${body.name}.`,
      stock_quantity: null, inventory_confirmed: false, active: body.active !== false, featured: body.featured === true,
    },
  });
  return ctx.send(201, { product: fromRow(inserted[0]) });
}

export async function adminProduct(ctx) {
  const { db } = await requireAdmin(ctx);
  const id = ctx.url.searchParams.get("id");
  if (!PRODUCT_ID_RE.test(String(id || ""))) throw new HttpError(400, "missing_id", "Product id required.");
  if (ctx.req.method === "PATCH") {
    const body = await ctx.json();
    const patch = {};
    if (body.name != null) patch.name = String(body.name).slice(0, 120);
    if (body.description != null) patch.description = String(body.description).slice(0, 2000);
    if (body.category != null) patch.category = String(body.category).slice(0, 60);
    if (body.pricePaise != null) {
      if (!Number.isInteger(body.pricePaise) || body.pricePaise < 0) throw new HttpError(400, "invalid_price", "Price must be whole paise.");
      patch.price_paise = body.pricePaise;
    }
    if (body.image != null) patch.image_path = String(body.image);
    if (Array.isArray(body.images)) patch.images = body.images.map(String).slice(0, 10);
    if (body.alt != null) patch.alt_text = String(body.alt).slice(0, 300);
    if (body.active != null) patch.active = body.active === true;
    if (body.featured != null) patch.featured = body.featured === true;
    const rows = await db(`products?id=eq.${enc(id)}`, { method: "PATCH", body: patch });
    if (!rows?.length) throw new HttpError(404, "not_found", "Product not found.");
    return ctx.send(200, { product: fromRow(rows[0]) });
  }
  // DELETE = deactivate (keeps order history intact)
  const rows = await db(`products?id=eq.${enc(id)}`, { method: "PATCH", body: { active: false } });
  if (!rows?.length) throw new HttpError(404, "not_found", "Product not found.");
  return ctx.send(200, { product: fromRow(rows[0]) });
}

export async function adminStock(ctx) {
  await requireAdmin(ctx);
  const body = await ctx.json();
  if (!PRODUCT_ID_RE.test(String(body.productId || ""))) throw new HttpError(400, "invalid_product", "Product id required.");
  if (!Number.isInteger(body.stockQuantity) || body.stockQuantity < 0) {
    throw new HttpError(400, "invalid_quantity", "Enter a whole number of pieces on hand.");
  }
  const product = await ctx.deps.db.rpc("set_product_stock", {
    p_product_id: body.productId,
    p_quantity: body.stockQuantity,
    p_note: String(body.note || "Stock updated from admin").slice(0, 200),
  });
  return ctx.send(200, { product: fromRow(product) });
}

export async function adminMovements(ctx) {
  const { db } = await requireAdmin(ctx);
  const productId = ctx.url.searchParams.get("productId");
  const filter = productId && PRODUCT_ID_RE.test(productId) ? `product_id=eq.${enc(productId)}&` : "";
  return ctx.send(200, { movements: await db(`inventory_movements?${filter}select=*&order=created_at.desc&limit=100`) });
}

export async function adminOrders(ctx) {
  const { db } = await requireAdmin(ctx);
  const status = ctx.url.searchParams.get("status");
  const q = (ctx.url.searchParams.get("q") || "").trim().replace(/[^A-Za-z0-9@._+-]/g, "").slice(0, 80);
  let path = "orders?select=*&order=created_at.desc&limit=100";
  if (status && FULFILMENT.has(status)) path += `&fulfilment_status=eq.${enc(status)}`;
  if (q) path += `&or=(public_ref.ilike.*${enc(q)}*,email.ilike.*${enc(q)}*)`;
  return ctx.send(200, { orders: await db(path) });
}

export async function adminOrder(ctx) {
  const { db } = await requireAdmin(ctx);
  const id = requireUuid(ctx.url.searchParams.get("id"));
  if (ctx.req.method === "GET") {
    const order = await ctx.deps.db.rpc("api_get_order", { p_order_id: id });
    const payments = await db(`payment_transactions?order_id=eq.${enc(id)}&select=*&order=created_at.asc`);
    return ctx.send(200, { order: order ? { ...orderView(order, { full: true }), needsReview: order.needs_review, reviewReason: order.review_reason } : null, payments });
  }
  const body = await ctx.json();
  const patch = {};
  if (body.fulfilmentStatus != null) {
    if (!FULFILMENT.has(body.fulfilmentStatus)) throw new HttpError(400, "invalid_status", "Unknown fulfilment status.");
    patch.fulfilment_status = body.fulfilmentStatus;
  }
  if (body.trackingNumber != null) patch.tracking_number = String(body.trackingNumber).slice(0, 80);
  if (body.courierName != null) patch.courier_name = String(body.courierName).slice(0, 80);
  if (body.trackingUrl != null) {
    if (body.trackingUrl && !/^https:\/\//.test(body.trackingUrl)) throw new HttpError(400, "invalid_url", "Tracking URL must be https.");
    patch.tracking_url = String(body.trackingUrl).slice(0, 500);
  }
  if (body.fulfilmentStatus === "shipped") patch.dispatched_at = body.dispatchedAt || new Date().toISOString();
  if (body.fulfilmentStatus === "cancelled") {
    // Unpaid orders: release reservation. Paid orders need a refund first (Part 2).
    await ctx.deps.db.rpc("api_release_order", { p_order_id: id, p_status: "cancelled", p_reason: "cancelled by admin" });
  }
  const rows = await db(`orders?id=eq.${enc(id)}`, { method: "PATCH", body: patch });
  return ctx.send(200, { order: rows?.[0] ? orderView(rows[0], { full: true }) : null });
}

export async function adminSettings(ctx) {
  const { db } = await requireAdmin(ctx);
  if (ctx.req.method === "GET") return ctx.send(200, { settings: await getSettings(ctx.deps) });
  const body = await ctx.json();
  const patch = {};
  const intOrNull = (v, k) => {
    if (v === null) return null;
    if (!Number.isInteger(v) || v < 0) throw new HttpError(400, "invalid_setting", `${k} must be a whole number.`);
    return v;
  };
  if ("shippingPaise" in body) patch.shipping_paise = intOrNull(body.shippingPaise, "shippingPaise");
  if ("shippingConfirmed" in body) patch.shipping_confirmed = body.shippingConfirmed === true;
  if ("taxConfirmed" in body) patch.tax_confirmed = body.taxConfirmed === true;
  if ("taxRateBps" in body) patch.tax_rate_bps = intOrNull(body.taxRateBps, "taxRateBps");
  if ("whatsappE164" in body) patch.whatsapp_e164 = body.whatsappE164 || null;
  if ("contactEmail" in body) patch.contact_email = body.contactEmail || null;
  if ("lowStockThreshold" in body) patch.low_stock_threshold = intOrNull(body.lowStockThreshold, "lowStockThreshold");
  const rows = await db("site_settings?id=eq.1", { method: "PATCH", body: patch });
  return ctx.send(200, { settings: toSettings(rows[0]) });
}
