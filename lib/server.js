import { readCatalogueFile, readSettingsFile, fromRow, toSettings } from "./catalogue.js";
import { send, readJson, readRaw } from "./http.js";
import { publicSettings, quoteOrder, reasonMessage, validateCustomer } from "./order.js";
import {
  createRazorpayOrder,
  paymentsConfigured,
  razorpayMode,
  verifyPaymentSignature,
  verifyWebhookSignature,
} from "./razorpay.js";
import { databaseConfigured, requireAdmin, sb, signInAdmin } from "./supabase.js";

async function catalogue() {
  if (!databaseConfigured()) return readCatalogueFile();
  try {
    const rows = await sb.rest("products?select=*&order=created_at.asc");
    if (!rows?.length) return readCatalogueFile();
    return rows.map(fromRow);
  } catch {
    return readCatalogueFile();
  }
}

async function settings() {
  if (!databaseConfigured()) return readSettingsFile();
  try {
    const rows = await sb.rest("site_settings?id=eq.1&select=*");
    return toSettings(rows?.[0]) || readSettingsFile();
  } catch {
    return readSettingsFile();
  }
}

function method(req, allowed) {
  return allowed.includes(req.method);
}

export async function handleHealth(_req, res) {
  send(res, 200, {
    ok: true,
    database: databaseConfigured(),
    payments: paymentsConfigured(),
    razorpayMode: razorpayMode(),
  });
}

export async function handleProducts(req, res) {
  if (!method(req, ["GET"])) return send(res, 405, { error: "method_not_allowed" });
  const products = (await catalogue()).filter((product) => product.active !== false);
  send(res, 200, { products });
}

export async function handleSettings(req, res) {
  if (!method(req, ["GET"])) return send(res, 405, { error: "method_not_allowed" });
  send(res, 200, { settings: publicSettings(await settings()) });
}

export async function handleCheckout(req, res) {
  if (!method(req, ["POST"])) return send(res, 405, { error: "method_not_allowed" });
  const body = await readJson(req);
  const customerCheck = validateCustomer(body.customer || {});
  if (!customerCheck.ok) {
    return send(res, 400, { error: "invalid_customer", errors: customerCheck.errors, message: reasonMessage("invalid_customer") });
  }
  if (!body.clientToken || typeof body.clientToken !== "string") {
    return send(res, 400, { error: "missing_client_token", message: "The checkout session was missing. Refresh and try again." });
  }

  const currentSettings = await settings();
  const quote = quoteOrder({
    catalogue: await catalogue(),
    items: body.items,
    settings: currentSettings,
  });
  if (!quote.ok) {
    return send(res, 409, { error: quote.error, message: reasonMessage(quote.error, quote.productName) });
  }
  if (!databaseConfigured()) {
    return send(res, 503, { error: "database_not_configured", message: reasonMessage("database_not_configured") });
  }
  if (!paymentsConfigured()) {
    return send(res, 503, { error: "payments_not_configured", message: reasonMessage("payments_not_configured"), razorpayMode: razorpayMode() });
  }

  const customer = customerCheck.customer;
  let created;
  try {
    created = await sb.rpc("create_checkout_order", {
      payload: {
        clientToken: body.clientToken,
        fullName: customer.fullName,
        email: customer.email,
        phone: customer.phone,
        notes: customer.notes,
        address: {
          line: customer.address,
          apartment: customer.apartment,
          locality: customer.locality,
          city: customer.city,
          state: customer.state,
          pin: customer.pin,
        },
        lines: quote.lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
      },
    });
  } catch (error) {
    const code = String(error.message || "");
    const known = ["inventory_unconfirmed", "insufficient_stock", "inactive_product", "shipping_unconfigured", "unknown_product", "invalid_quantity", "tax_misconfigured"];
    const match = known.find((item) => code.includes(item));
    if (match) return send(res, 409, { error: match, message: reasonMessage(match) });
    return send(res, 500, { error: "order_failed", message: "The order could not be reserved." });
  }

  if (created.razorpay_order_id) {
    return send(res, 200, checkoutPayload(created));
  }

  try {
    const razorpayOrder = await createRazorpayOrder({
      amountPaise: created.total_paise,
      receipt: created.public_ref,
    });
    await sb.rest(`orders?id=eq.${created.order_id}`, {
      method: "PATCH",
      body: { razorpay_order_id: razorpayOrder.id },
    });
    created.razorpay_order_id = razorpayOrder.id;
    return send(res, 200, checkoutPayload(created));
  } catch {
    await sb.rpc("release_checkout_order", { p_order_id: created.order_id, p_payment_status: "failed" }).catch(() => {});
    return send(res, 502, { error: "payments_not_configured", message: "Razorpay did not open the payment. Nothing was charged. The reserved stock was released." });
  }
}

function checkoutPayload(created) {
  return {
    orderId: created.order_id,
    publicRef: created.public_ref,
    razorpayOrderId: created.razorpay_order_id,
    amountPaise: created.total_paise,
    keyId: process.env.RAZORPAY_KEY_ID,
    razorpayMode: razorpayMode(),
    currency: "INR",
  };
}

export async function handleVerify(req, res) {
  if (!method(req, ["POST"])) return send(res, 405, { error: "method_not_allowed" });
  if (!databaseConfigured() || !paymentsConfigured()) {
    return send(res, 503, { error: "payments_not_configured", message: reasonMessage("payments_not_configured") });
  }
  const body = await readJson(req);
  const valid = verifyPaymentSignature({
    orderId: body.razorpayOrderId,
    paymentId: body.razorpayPaymentId,
    signature: body.razorpaySignature,
    secret: process.env.RAZORPAY_KEY_SECRET,
  });
  if (!valid) return send(res, 400, { error: "invalid_signature", message: "The payment could not be verified." });

  try {
    const order = await sb.rpc("finalize_paid_order", {
      p_order_id: body.orderId,
      p_razorpay_order_id: body.razorpayOrderId,
      p_razorpay_payment_id: body.razorpayPaymentId,
      p_signature: body.razorpaySignature,
    });
    return send(res, 200, {
      publicRef: order.public_ref,
      email: order.email,
      paymentStatus: order.payment_status,
      fulfilmentStatus: order.fulfilment_status,
    });
  } catch (error) {
    return send(res, 409, { error: "verify_failed", message: error.message || "The payment was not applied to the order." });
  }
}

export async function handleCancel(req, res) {
  if (!method(req, ["POST"])) return send(res, 405, { error: "method_not_allowed" });
  if (!databaseConfigured()) return send(res, 503, { error: "database_not_configured" });
  const body = await readJson(req);
  try {
    const order = await sb.rpc("release_checkout_order", {
      p_order_id: body.orderId,
      p_payment_status: "cancelled",
    });
    send(res, 200, { publicRef: order.public_ref, paymentStatus: order.payment_status });
  } catch (error) {
    send(res, 409, { error: "cancel_failed", message: error.message || "The unpaid order could not be released." });
  }
}

export async function handleOrderStatus(req, res) {
  if (!method(req, ["GET"])) return send(res, 405, { error: "method_not_allowed" });
  if (!databaseConfigured()) return send(res, 503, { error: "database_not_configured", message: reasonMessage("database_not_configured") });
  const url = new URL(req.url, "http://local");
  const ref = (url.searchParams.get("ref") || "").trim();
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  if (!ref || !email) return send(res, 400, { error: "missing_lookup", message: "Enter the order reference and the email used at checkout." });
  const rows = await sb.rest(`orders?public_ref=eq.${encodeURIComponent(ref)}&email=eq.${encodeURIComponent(email)}&select=*`);
  const order = rows?.[0];
  if (!order) return send(res, 404, { error: "not_found", message: "No order matched that reference and email." });
  const items = await sb.rest(`order_items?order_id=eq.${order.id}&select=name,quantity,unit_price_paise,line_total_paise`);
  send(res, 200, {
    order: {
      publicRef: order.public_ref,
      paymentStatus: order.payment_status,
      fulfilmentStatus: order.fulfilment_status,
      subtotalPaise: order.subtotal_paise,
      shippingPaise: order.shipping_paise,
      taxPaise: order.tax_paise,
      totalPaise: order.total_paise,
      trackingNumber: order.tracking_number,
      courierName: order.courier_name,
      trackingUrl: order.tracking_url,
      dispatchedAt: order.dispatched_at,
      items,
    },
  });
}

export async function handleWebhook(req, res) {
  if (!method(req, ["POST"])) return send(res, 405, { error: "method_not_allowed" });
  const raw = await readRaw(req);
  const signature = req.headers["x-razorpay-signature"];
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!verifyWebhookSignature({ rawBody: raw, signature, secret })) {
    return send(res, 400, { error: "invalid_signature" });
  }
  const event = JSON.parse(raw.toString("utf8"));
  const payment = event.payload?.payment?.entity;
  if (!payment?.order_id || !databaseConfigured()) return send(res, 200, { received: true });

  const rows = await sb.rest(`orders?razorpay_order_id=eq.${payment.order_id}&select=id,payment_status`);
  const order = rows?.[0];
  if (!order) return send(res, 200, { received: true });

  if (event.event === "payment.captured") {
    const valid = verifyPaymentSignature({
      orderId: payment.order_id,
      paymentId: payment.id,
      signature: payment.notes?.client_signature,
      secret: process.env.RAZORPAY_KEY_SECRET,
    });
    if (!valid) {
      await sb.rpc("record_payment_event", {
        p_order_id: order.id,
        p_razorpay_order_id: payment.order_id,
        p_razorpay_payment_id: payment.id,
        p_status: "captured_unverified",
        p_amount_paise: payment.amount,
      }).catch(() => {});
      return send(res, 200, { received: true, applied: false });
    }
    await sb.rpc("finalize_paid_order", {
      p_order_id: order.id,
      p_razorpay_order_id: payment.order_id,
      p_razorpay_payment_id: payment.id,
      p_signature: "webhook",
    });
  }

  if (event.event === "payment.failed") {
    await sb.rpc("release_checkout_order", { p_order_id: order.id, p_payment_status: "failed" });
  }

  send(res, 200, { received: true });
}

export async function handleAdminLogin(req, res) {
  if (!method(req, ["POST"])) return send(res, 405, { error: "method_not_allowed" });
  if (!databaseConfigured()) return send(res, 503, { error: "database_not_configured", message: reasonMessage("database_not_configured") });
  const body = await readJson(req);
  const session = await signInAdmin(String(body.email || ""), String(body.password || ""));
  if (!session?.access_token) {
    return send(res, 401, { error: "admin_required", message: "Those details are not an admin login." });
  }
  const user = await sb.rest(`admin_users?user_id=eq.${session.user.id}&select=user_id`);
  if (!user?.length) return send(res, 403, { error: "admin_required", message: "This account is not an Amaanat admin." });
  send(res, 200, { accessToken: session.access_token, expiresIn: session.expires_in });
}

export async function handleAdminOverview(req, res) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return send(res, admin.status, { error: admin.error });
  const [orders, products] = await Promise.all([
    sb.rest("orders?select=payment_status,fulfilment_status,total_paise"),
    sb.rest("products?select=id,active,inventory_confirmed,stock_quantity"),
  ]);
  const site = await settings();
  const paid = (orders || []).filter((order) => order.payment_status === "paid");
  const threshold = site.lowStockThreshold ?? 2;
  send(res, 200, {
    totalOrders: orders?.length || 0,
    revenuePaise: paid.reduce((sum, order) => sum + order.total_paise, 0),
    pendingOrders: (orders || []).filter((order) => order.payment_status === "pending").length,
    completedOrders: (orders || []).filter((order) => order.fulfilment_status === "delivered").length,
    activeProducts: (products || []).filter((product) => product.active).length,
    lowStock: (products || []).filter((product) => product.inventory_confirmed && product.stock_quantity != null && product.stock_quantity <= threshold),
  });
}

export async function handleAdminProducts(req, res) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return send(res, admin.status, { error: admin.error });
  if (req.method === "GET") {
    const rows = await sb.rest("products?select=*&order=created_at.asc");
    return send(res, 200, { products: (rows || []).map(fromRow) });
  }
  if (req.method === "POST") {
    const body = await readJson(req);
    const pricePaise = Number(body.pricePaise);
    if (!body.name || !body.slug || !body.description || !body.category || !Number.isInteger(pricePaise)) {
      return send(res, 400, { error: "invalid_product", message: "Name, slug, description, category, and price are required." });
    }
    const id = body.id || `p${Date.now()}`;
    const row = {
      id,
      slug: body.slug,
      name: body.name,
      description: body.description,
      category: body.category,
      price_paise: pricePaise,
      image_path: body.image || "",
      alt_text: body.alt || `Catalogue photograph of ${body.name}.`,
      stock_quantity: null,
      inventory_confirmed: false,
      active: body.active !== false,
      featured: body.featured === true,
    };
    const inserted = await sb.rest("products", { method: "POST", body: row });
    return send(res, 201, { product: fromRow(inserted[0]) });
  }
  return send(res, 405, { error: "method_not_allowed" });
}

export async function handleAdminProduct(req, res) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return send(res, admin.status, { error: admin.error });
  const url = new URL(req.url, "http://local");
  const id = url.searchParams.get("id");
  if (!id) return send(res, 400, { error: "missing_id" });
  if (req.method === "PATCH") {
    const body = await readJson(req);
    const patch = {};
    if (body.name != null) patch.name = body.name;
    if (body.description != null) patch.description = body.description;
    if (body.category != null) patch.category = body.category;
    if (body.pricePaise != null) patch.price_paise = body.pricePaise;
    if (body.image != null) patch.image_path = body.image;
    if (body.alt != null) patch.alt_text = body.alt;
    if (body.active != null) patch.active = body.active;
    if (body.featured != null) patch.featured = body.featured;
    patch.updated_at = new Date().toISOString();
    const rows = await sb.rest(`products?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
    return send(res, 200, { product: fromRow(rows[0]) });
  }
  if (req.method === "DELETE") {
    const rows = await sb.rest(`products?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { active: false, updated_at: new Date().toISOString() },
    });
    return send(res, 200, { product: fromRow(rows[0]) });
  }
  return send(res, 405, { error: "method_not_allowed" });
}

export async function handleAdminStock(req, res) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return send(res, admin.status, { error: admin.error });
  if (!method(req, ["POST"])) return send(res, 405, { error: "method_not_allowed" });
  const body = await readJson(req);
  if (!Number.isInteger(body.stockQuantity) || body.stockQuantity < 0) {
    return send(res, 400, { error: "invalid_quantity", message: "Enter a whole number of pieces on hand." });
  }
  try {
    const product = await sb.rpc("set_product_stock", {
      p_product_id: body.productId,
      p_quantity: body.stockQuantity,
      p_note: body.note || "Stock updated from admin",
    });
    send(res, 200, { product: fromRow(product) });
  } catch (error) {
    send(res, 400, { error: "stock_failed", message: error.message });
  }
}

export async function handleAdminMovements(req, res) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return send(res, admin.status, { error: admin.error });
  const url = new URL(req.url, "http://local");
  const productId = url.searchParams.get("productId");
  const filter = productId ? `product_id=eq.${encodeURIComponent(productId)}&` : "";
  const rows = await sb.rest(`inventory_movements?${filter}select=*&order=created_at.desc&limit=100`);
  send(res, 200, { movements: rows || [] });
}

export async function handleAdminOrders(req, res) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return send(res, admin.status, { error: admin.error });
  const url = new URL(req.url, "http://local");
  const status = url.searchParams.get("status");
  const q = (url.searchParams.get("q") || "").trim();
  let path = "orders?select=*&order=created_at.desc&limit=100";
  if (status) path += `&fulfilment_status=eq.${encodeURIComponent(status)}`;
  if (q) path += `&or=(public_ref.ilike.*${encodeURIComponent(q)}*,email.ilike.*${encodeURIComponent(q)}*)`;
  const orders = await sb.rest(path);
  send(res, 200, { orders: orders || [] });
}

export async function handleAdminOrder(req, res) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return send(res, admin.status, { error: admin.error });
  const url = new URL(req.url, "http://local");
  const id = url.searchParams.get("id");
  if (!id) return send(res, 400, { error: "missing_id" });
  if (req.method === "GET") {
    const orders = await sb.rest(`orders?id=eq.${id}&select=*`);
    const items = await sb.rest(`order_items?order_id=eq.${id}&select=*`);
    const customer = orders?.[0] ? await sb.rest(`customers?id=eq.${orders[0].customer_id}&select=*`) : [];
    return send(res, 200, { order: orders?.[0] || null, items: items || [], customer: customer?.[0] || null });
  }
  if (req.method === "PATCH") {
    const body = await readJson(req);
    const patch = { updated_at: new Date().toISOString() };
    if (body.fulfilmentStatus) patch.fulfilment_status = body.fulfilmentStatus;
    if (body.trackingNumber != null) patch.tracking_number = body.trackingNumber;
    if (body.courierName != null) patch.courier_name = body.courierName;
    if (body.trackingUrl != null) patch.tracking_url = body.trackingUrl;
    if (body.dispatchedAt != null) patch.dispatched_at = body.dispatchedAt;
    if (body.fulfilmentStatus === "shipped" && !body.dispatchedAt) patch.dispatched_at = new Date().toISOString();
    const rows = await sb.rest(`orders?id=eq.${id}`, { method: "PATCH", body: patch });
    if (body.fulfilmentStatus === "cancelled" || body.fulfilmentStatus === "refunded") {
      await sb.rpc("release_checkout_order", {
        p_order_id: id,
        p_payment_status: body.fulfilmentStatus === "refunded" ? "refunded" : "cancelled",
      });
    }
    return send(res, 200, { order: rows[0] });
  }
  return send(res, 405, { error: "method_not_allowed" });
}

export async function handleAdminSettings(req, res) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return send(res, admin.status, { error: admin.error });
  if (req.method === "GET") return send(res, 200, { settings: await settings() });
  if (req.method === "PATCH") {
    const body = await readJson(req);
    const patch = {};
    if ("shippingPaise" in body) patch.shipping_paise = body.shippingPaise;
    if ("shippingConfirmed" in body) patch.shipping_confirmed = body.shippingConfirmed === true;
    if ("taxConfirmed" in body) patch.tax_confirmed = body.taxConfirmed === true;
    if ("taxRateBps" in body) patch.tax_rate_bps = body.taxRateBps;
    if ("whatsappE164" in body) patch.whatsapp_e164 = body.whatsappE164 || null;
    if ("contactEmail" in body) patch.contact_email = body.contactEmail || null;
    if ("lowStockThreshold" in body) patch.low_stock_threshold = body.lowStockThreshold;
    const rows = await sb.rest("site_settings?id=eq.1", { method: "PATCH", body: patch });
    return send(res, 200, { settings: toSettings(rows[0]) });
  }
  return send(res, 405, { error: "method_not_allowed" });
}
