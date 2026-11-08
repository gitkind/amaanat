import { collections, fromRow, parseCatalogueQuery, publicProduct, queryCatalogue } from "../catalogue.js";
import { HttpError } from "../http.js";
import { publicSettings, quoteOrder, reasonMessage, validateAddress } from "../order.js";
import { paymentsEnabled, razorpayMode } from "../razorpay.js";
import { cartView, getProducts, getSettings, rpc } from "../services.js";
import { sha256 } from "../session.js";
import { AuthError } from "../auth/supabase.js";

const PRODUCT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkProductId(id) {
  if (!PRODUCT_ID_RE.test(String(id || ""))) throw new HttpError(400, "invalid_product", "Unknown product.");
  return String(id);
}

function checkQuantity(q, { allowZero = false } = {}) {
  if (!Number.isInteger(q) || q < (allowZero ? 0 : 1) || q > 50) {
    throw new HttpError(400, "invalid_quantity", "Choose a quantity between 1 and 50.");
  }
  return q;
}

// ---------------- Catalogue ----------------

export async function health(ctx) {
  const { config, db, auth } = ctx.deps;
  return ctx.send(200, {
    ok: true,
    database: db ? db.kind : "none",
    auth: auth ? auth.kind : "none",
    payments: paymentsEnabled(config.razorpay),
    razorpayMode: razorpayMode(config.razorpay),
    webhookConfigured: Boolean(config.razorpay.webhookSecret),
  });
}

export async function listProducts(ctx) {
  const [products, settings] = await Promise.all([getProducts(ctx.deps), getSettings(ctx.deps)]);
  const query = parseCatalogueQuery(ctx.url.searchParams);
  const result = queryCatalogue(products, query);
  const threshold = settings?.lowStockThreshold ?? 2;
  return ctx.send(200, {
    products: result.map((p) => publicProduct(p, { lowStockThreshold: threshold })),
    total: result.length,
    query,
    collections: collections(products),
  });
}

export async function getProduct(ctx) {
  const slug = String(ctx.params.slug || "");
  if (!/^[a-z0-9-]{1,120}$/.test(slug)) throw new HttpError(404, "not_found", "That piece was not found.");
  const [products, settings] = await Promise.all([getProducts(ctx.deps), getSettings(ctx.deps)]);
  const product = products.find((p) => p.slug === slug && p.active !== false);
  if (!product) throw new HttpError(404, "not_found", "That piece was not found.");
  const threshold = settings?.lowStockThreshold ?? 2;
  const related = products
    .filter((p) => p.id !== product.id && p.active !== false && p.category === product.category)
    .slice(0, 4)
    .map((p) => publicProduct(p, { lowStockThreshold: threshold }));
  return ctx.send(200, { product: publicProduct(product, { lowStockThreshold: threshold }), related });
}

export async function listCollections(ctx) {
  return ctx.send(200, { collections: collections(await getProducts(ctx.deps)) });
}

export async function settings(ctx) {
  const s = await getSettings(ctx.deps);
  const { config, db } = ctx.deps;
  const blockers = [];
  if (!db) blockers.push("database_not_configured");
  if (!paymentsEnabled(config.razorpay)) blockers.push("payments_not_configured");
  if (!s?.shippingConfirmed || !Number.isInteger(s?.shippingPaise)) blockers.push("shipping_unconfigured");
  return ctx.send(200, {
    settings: publicSettings(s),
    checkout: {
      enabled: blockers.length === 0,
      blockers: blockers.map((code) => ({ code, message: reasonMessage(code) })),
      razorpayMode: razorpayMode(config.razorpay),
    },
  });
}

// ---------------- Cart ----------------

async function resolveCartId(ctx, create) {
  const user = await ctx.user();
  if (user) return rpc(ctx.deps, "api_cart_resolve", { p_user_id: user.id, p_guest_hash: null, p_create: create });
  const token = create ? ctx.deps.sessions.ensureGuestCartToken(ctx.req, ctx.res) : ctx.deps.sessions.guestCartToken(ctx.req);
  if (!token) return null;
  return rpc(ctx.deps, "api_cart_resolve", { p_user_id: null, p_guest_hash: sha256(token), p_create: create });
}

export async function loadCart(ctx) {
  const cartId = await resolveCartId(ctx, false);
  const rows = cartId ? await rpc(ctx.deps, "api_cart_get", { p_cart_id: cartId }) : [];
  return { cartId, rows };
}

async function cartResponse(ctx, rows) {
  const s = await getSettings(ctx.deps);
  const items = cartView(rows, s);
  const quote = quoteOrder({ lines: items.map((i) => ({ product: i._unit, quantity: i.quantity })), settings: s });
  return ctx.send(200, {
    items: items.map(({ _unit, ...rest }) => rest), // eslint-disable-line no-unused-vars
    count: items.reduce((n, i) => n + i.quantity, 0),
    subtotalPaise: items.reduce((n, i) => n + i.lineTotalPaise, 0),
    quote: quote.ok
      ? { ok: true, subtotalPaise: quote.subtotalPaise, shippingPaise: quote.shippingPaise, taxPaise: quote.taxPaise, totalPaise: quote.totalPaise }
      : { ok: false, error: quote.error, message: reasonMessage(quote.error, quote.productName) },
  });
}

export async function getCart(ctx) {
  if (!ctx.deps.db) return ctx.send(200, { items: [], count: 0, subtotalPaise: 0, quote: { ok: false, error: "database_not_configured", message: reasonMessage("database_not_configured") } });
  const { rows } = await loadCart(ctx);
  return cartResponse(ctx, rows);
}

function checkVariantId(value) {
  if (value == null || value === "") return null;
  if (!UUID_RE.test(String(value))) throw new HttpError(400, "unknown_variant", reasonMessage("unknown_variant"));
  return String(value);
}

async function putLine(ctx, { productId, variantId, quantity, mode, create = true }) {
  const cartId = await resolveCartId(ctx, create);
  if (!cartId) return cartResponse(ctx, []);
  const rows = await rpc(ctx.deps, "api_cart_put", {
    p_cart_id: cartId, p_product_id: productId, p_variant_id: variantId, p_quantity: quantity, p_mode: mode,
  });
  return cartResponse(ctx, rows);
}

export async function addCartItem(ctx) {
  const body = await ctx.json();
  return putLine(ctx, {
    productId: checkProductId(body.productId),
    variantId: checkVariantId(body.variantId),
    quantity: checkQuantity(body.quantity ?? 1),
    mode: "add",
  });
}

export async function setCartItem(ctx) {
  const body = await ctx.json();
  return putLine(ctx, {
    productId: checkProductId(ctx.params.productId),
    variantId: checkVariantId(body.variantId ?? ctx.url.searchParams.get("variant")),
    quantity: checkQuantity(body.quantity, { allowZero: true }),
    mode: "set",
  });
}

export async function removeCartItem(ctx) {
  return putLine(ctx, {
    productId: checkProductId(ctx.params.productId),
    variantId: checkVariantId(ctx.url.searchParams.get("variant")),
    quantity: 0,
    mode: "set",
    create: false,
  });
}

// ---------------- Auth ----------------

function requireAuthProvider(ctx) {
  if (!ctx.deps.auth || !ctx.deps.db) throw new HttpError(503, "auth_not_configured", "Accounts are not configured yet.");
  return ctx.deps.auth;
}

function credentials(body) {
  const email = String(body.email || "").trim().toLowerCase().slice(0, 254);
  const password = String(body.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "invalid_email", "Enter a valid email address.");
  if (password.length < 8 || password.length > 72) throw new HttpError(400, "weak_password", "Use a password of 8 to 72 characters.");
  return { email, password };
}

async function mergeGuestCart(ctx, user) {
  const token = ctx.deps.sessions.guestCartToken(ctx.req);
  if (!token) return;
  try {
    await ctx.deps.db.rpc("api_cart_merge", { p_guest_hash: sha256(token), p_user_id: user.id });
    ctx.deps.sessions.clearGuestCart(ctx.res);
  } catch (error) {
    ctx.deps.log.warn(`[cart] merge failed: ${error.message}`);
  }
}

function authFail(error) {
  if (error instanceof AuthError) return new HttpError(error.status, error.code, error.message);
  return error;
}

export async function register(ctx) {
  const auth = requireAuthProvider(ctx);
  const body = await ctx.json();
  const { email, password } = credentials(body);
  let result;
  try {
    result = await auth.signUp(email, password);
  } catch (error) {
    throw authFail(error);
  }
  const fullName = String(body.fullName || "").trim().slice(0, 120);
  if (result.user?.id && fullName.length >= 2) {
    await ctx.deps.db.rpc("api_profile_upsert", { p_user_id: result.user.id, p_full_name: fullName, p_phone: null }).catch(() => {});
  }
  if (result.session) {
    ctx.deps.sessions.setSession(ctx.res, result.session);
    await mergeGuestCart(ctx, result.session.user);
  }
  return ctx.send(201, {
    user: result.session ? { id: result.user.id, email: result.user.email } : null,
    needsConfirmation: result.needsConfirmation,
    message: result.needsConfirmation ? "Check your email to confirm the account, then sign in." : "Account created.",
  });
}

export async function login(ctx) {
  const auth = requireAuthProvider(ctx);
  const { email, password } = credentials(await ctx.json());
  const limit = ctx.deps.limiter.hit(`login:${email}`, 10, 15 * 60 * 1000);
  if (!limit.ok) throw new HttpError(429, "rate_limited", "Too many attempts. Try again later.", { retryAfter: limit.retryAfter });
  let session;
  try {
    session = await auth.signIn(email, password);
  } catch (error) {
    throw authFail(error);
  }
  if (!session) throw new HttpError(401, "invalid_credentials", "Email or password is incorrect.");
  ctx.deps.sessions.setSession(ctx.res, session);
  await mergeGuestCart(ctx, session.user);
  return ctx.send(200, { user: { id: session.user.id, email: session.user.email } });
}

export async function logout(ctx) {
  const token = ctx.cookies.am_at;
  if (token && ctx.deps.auth) await ctx.deps.auth.signOut(token).catch(() => {});
  ctx.deps.sessions.clearSession(ctx.res);
  return ctx.send(200, { ok: true });
}

export async function me(ctx) {
  const user = await ctx.user();
  return ctx.send(200, { user: user ? { id: user.id, email: user.email } : null, accountsEnabled: Boolean(ctx.deps.auth && ctx.deps.db) });
}

// ---------------- Account ----------------

function profileView(data, user) {
  const p = data?.profile;
  return {
    user: { id: user.id, email: user.email },
    profile: { fullName: p?.full_name || "", phone: p?.phone || "" },
    addresses: (data?.addresses || []).map((a) => ({
      id: a.id, label: a.label, fullName: a.full_name, phone: a.phone, line: a.line, apartment: a.apartment,
      locality: a.locality, city: a.city, state: a.state, pin: a.pin, isDefault: a.is_default,
    })),
  };
}

export async function getAccount(ctx) {
  const user = await ctx.requireUser();
  return ctx.send(200, profileView(await rpc(ctx.deps, "api_profile_get", { p_user_id: user.id }), user));
}

export async function updateProfile(ctx) {
  const user = await ctx.requireUser();
  const body = await ctx.json();
  const fullName = String(body.fullName || "").trim().slice(0, 120);
  const phone = String(body.phone || "").replace(/[\s-]/g, "").replace(/^\+91/, "").replace(/^0/, "");
  const errors = {};
  if (fullName && fullName.length < 2) errors.fullName = "Enter your name.";
  if (phone && !/^[6-9]\d{9}$/.test(phone)) errors.phone = "Enter a 10-digit Indian mobile number.";
  if (Object.keys(errors).length) throw new HttpError(400, "invalid_profile", "Check the details.", { errors });
  const data = await rpc(ctx.deps, "api_profile_upsert", { p_user_id: user.id, p_full_name: fullName || null, p_phone: phone || null });
  return ctx.send(200, profileView(data, user));
}

export async function saveAddress(ctx) {
  const user = await ctx.requireUser();
  const id = ctx.params.id || null;
  if (id && !UUID_RE.test(id)) throw new HttpError(404, "address_not_found", "That address was not found.");
  const body = await ctx.json();
  const check = validateAddress(body);
  if (!check.ok) throw new HttpError(400, "invalid_address", "Check the address.", { errors: check.errors });
  const data = await rpc(ctx.deps, "api_address_save", {
    p_user_id: user.id,
    p_address_id: id,
    p: { ...check.address, isDefault: body.isDefault === true },
  });
  return ctx.send(id ? 200 : 201, profileView(data, user));
}

export async function deleteAddress(ctx) {
  const user = await ctx.requireUser();
  const id = ctx.params.id;
  if (!UUID_RE.test(id || "")) throw new HttpError(404, "address_not_found", "That address was not found.");
  return ctx.send(200, profileView(await rpc(ctx.deps, "api_address_delete", { p_user_id: user.id, p_address_id: id }), user));
}

// ---------------- Wishlist ----------------

async function wishlistResponse(ctx, rows) {
  const s = await getSettings(ctx.deps);
  return ctx.send(200, { products: (rows || []).map((r) => publicProduct(fromRow(r), { lowStockThreshold: s?.lowStockThreshold ?? 2 })) });
}

export async function getWishlist(ctx) {
  const user = await ctx.requireUser();
  return wishlistResponse(ctx, await rpc(ctx.deps, "api_wishlist_list", { p_user_id: user.id }));
}

export async function addWishlist(ctx) {
  const user = await ctx.requireUser();
  const productId = checkProductId(ctx.params.productId);
  return wishlistResponse(ctx, await rpc(ctx.deps, "api_wishlist_set", { p_user_id: user.id, p_product_id: productId, p_on: true }));
}

export async function removeWishlist(ctx) {
  const user = await ctx.requireUser();
  const productId = checkProductId(ctx.params.productId);
  return wishlistResponse(ctx, await rpc(ctx.deps, "api_wishlist_set", { p_user_id: user.id, p_product_id: productId, p_on: false }));
}

// ---------------- Public store content (admin-managed) ----------------

export async function content(ctx) {
  if (!ctx.deps.db) return ctx.send(200, { content: { pages: [], bestSellers: [], homepage: {}, announcement: null } });
  const c = (await ctx.deps.db.rpc("api_public_content", {})) || {};
  return ctx.send(200, {
    content: {
      storeName: c.store_name || null,
      contactEmail: c.contact_email || null,
      contactPhone: c.contact_phone || null,
      whatsappE164: c.whatsapp_e164 || null,
      businessAddress: c.business_address || null,
      social: { instagram: c.instagram_url || null, facebook: c.facebook_url || null, youtube: c.youtube_url || null, pinterest: c.pinterest_url || null },
      logoUrl: c.logo_url || null,
      announcement: c.announcement || null,
      homepage: c.homepage || {},
      pages: c.pages || [],
      bestSellers: c.best_sellers || [],
    },
  }, { "Cache-Control": "public, max-age=60" });
}

export async function page(ctx) {
  const slug = String(ctx.params.slug || "");
  if (!/^[a-z]{2,20}$/.test(slug) || !ctx.deps.db) throw new HttpError(404, "not_found", "This page has not been published yet.");
  const p = await ctx.deps.db.rpc("api_public_page", { p_slug: slug });
  if (!p) throw new HttpError(404, "not_found", "This page has not been published yet.");
  return ctx.send(200, { page: { slug: p.slug, title: p.title, body: p.body, updatedAt: p.updated_at } });
}
