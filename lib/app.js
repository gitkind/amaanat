import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError, parseCookies, readJson, readRaw, send } from "./http.js";
import { createRateLimiter } from "./ratelimit.js";
import { clientIp, isSameOriginRequest, setSecurityHeaders } from "./security.js";
import { createSessionManager } from "./session.js";
import * as store from "./routes/store.js";
import * as checkout from "./routes/checkout.js";
import * as admin from "./routes/admin.js";
import { handleSite, sendNotFound } from "./site/router.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PUBLIC_DIR = path.join(ROOT, "public");

const MIN = 60 * 1000;
// [method, path pattern, handler, options]
// rate: [bucket, limit, windowMs] per client IP. csrf defaults to true for mutating methods.
const ROUTES = [
  ["GET", "/api/health", store.health],
  ["GET", "/api/products", store.listProducts, { rate: ["read", 300, MIN] }],
  ["GET", "/api/products/:slug", store.getProduct, { rate: ["read", 300, MIN] }],
  ["GET", "/api/collections", store.listCollections],
  ["GET", "/api/settings", store.settings],
  ["GET", "/api/content", store.content],
  ["GET", "/api/pages/:slug", store.page],
  ["POST", "/api/newsletter", store.newsletter, { rate: ["newsletter", 5, 10 * MIN] }],

  ["GET", "/api/cart", store.getCart, { rate: ["cart", 120, MIN] }],
  ["POST", "/api/cart/items", store.addCartItem, { rate: ["cart", 120, MIN] }],
  ["PUT", "/api/cart/items/:productId", store.setCartItem, { rate: ["cart", 120, MIN] }],
  ["DELETE", "/api/cart/items/:productId", store.removeCartItem, { rate: ["cart", 120, MIN] }],

  ["POST", "/api/auth/register", store.register, { rate: ["register", 5, 15 * MIN] }],
  ["POST", "/api/auth/login", store.login, { rate: ["login", 20, 15 * MIN] }],
  ["POST", "/api/auth/logout", store.logout],
  ["GET", "/api/auth/me", store.me],
  ["POST", "/api/auth/forgot", store.forgotPassword, { rate: ["forgot", 5, 15 * MIN] }],
  ["POST", "/api/auth/recovery", store.startRecovery, { rate: ["recovery", 10, 15 * MIN] }],
  ["POST", "/api/auth/reset", store.resetPassword, { rate: ["reset", 10, 15 * MIN] }],

  ["GET", "/api/account", store.getAccount],
  ["PUT", "/api/account/profile", store.updateProfile, { rate: ["account", 30, MIN] }],
  ["POST", "/api/account/addresses", store.saveAddress, { rate: ["account", 30, MIN] }],
  ["PUT", "/api/account/addresses/:id", store.saveAddress, { rate: ["account", 30, MIN] }],
  ["DELETE", "/api/account/addresses/:id", store.deleteAddress, { rate: ["account", 30, MIN] }],
  ["GET", "/api/account/orders", checkout.listMyOrders],

  ["GET", "/api/wishlist", store.getWishlist],
  ["PUT", "/api/wishlist/:productId", store.addWishlist, { rate: ["cart", 120, MIN] }],
  ["DELETE", "/api/wishlist/:productId", store.removeWishlist, { rate: ["cart", 120, MIN] }],

  ["POST", "/api/checkout", checkout.createCheckout, { rate: ["checkout", 10, 10 * MIN] }],
  ["POST", "/api/checkout/cancel", checkout.cancelCheckout, { rate: ["checkout-cancel", 20, 10 * MIN] }],
  ["POST", "/api/payments/verify", checkout.verifyPayment, { rate: ["verify", 30, 10 * MIN] }],
  ["GET", "/api/orders/:id", checkout.getOrder, { rate: ["order", 60, MIN] }],
  ["POST", "/api/orders/lookup", checkout.lookupOrder, { rate: ["lookup", 10, 15 * MIN] }],

  // Server-to-server: authenticated by HMAC / bearer secret, not cookies.
  ["POST", "/api/webhooks/razorpay", checkout.razorpayWebhook, { csrf: false, rawBody: true }],
  ["POST", "/api/webhook", checkout.razorpayWebhook, { csrf: false, rawBody: true }], // legacy path
  ["GET", "/api/internal/reconcile", checkout.reconcile, { csrf: false }],
  ["POST", "/api/internal/reconcile", checkout.reconcile, { csrf: false }],

  // Admin: cookie session + server-side role check in every handler; CSRF checks apply.
  ["POST", "/api/admin/login", admin.adminLogin, { rate: ["admin-login", 10, 15 * MIN] }],
  ["GET", "/api/admin/me", admin.adminMe],
  ["GET", "/api/admin/overview", admin.overview],
  ["GET", "/api/admin/products", admin.listProducts],
  ["POST", "/api/admin/products", admin.createProduct],
  ["GET", "/api/admin/products/:id", admin.getProduct],
  ["PUT", "/api/admin/products/:id", admin.updateProduct],
  ["DELETE", "/api/admin/products/:id", admin.deleteProduct],
  ["POST", "/api/admin/products/:id/archive", admin.archiveProduct],
  ["POST", "/api/admin/products/:id/restore", admin.restoreProduct],
  ["POST", "/api/admin/products/:id/images", admin.uploadImage, { rate: ["upload", 60, 10 * MIN] }],
  ["PUT", "/api/admin/products/:id/images", admin.reorderImages],
  ["DELETE", "/api/admin/products/:id/images", admin.removeImage],
  ["POST", "/api/admin/products/:id/variants", admin.saveVariant],
  ["PUT", "/api/admin/products/:id/variants/:variantId", admin.saveVariant],
  ["DELETE", "/api/admin/products/:id/variants/:variantId", admin.deleteVariant],
  ["GET", "/api/admin/inventory", admin.inventory],
  ["POST", "/api/admin/inventory/adjust", admin.adjustStock],
  ["GET", "/api/admin/inventory/movements", admin.movements],
  ["GET", "/api/admin/orders", admin.listOrders],
  ["GET", "/api/admin/orders/:id", admin.getOrder],
  ["POST", "/api/admin/orders/:id/fulfilment", admin.setFulfilment],
  ["POST", "/api/admin/orders/:id/reconcile", admin.reconcileOrder, { rate: ["admin-gateway", 60, 10 * MIN] }],
  ["POST", "/api/admin/orders/:id/cancel", admin.cancelUnpaid, { rate: ["admin-gateway", 60, 10 * MIN] }],
  ["POST", "/api/admin/orders/:id/refund", admin.refundOrder, { rate: ["admin-refund", 20, 10 * MIN] }],
  ["POST", "/api/admin/orders/:id/resolve", admin.resolveReview],
  ["POST", "/api/admin/orders/:id/cod-collected", admin.codCollected],
  ["GET", "/api/admin/customers", admin.listCustomers],
  ["GET", "/api/admin/customer", admin.getCustomer],
  ["GET", "/api/admin/settings", admin.getSettingsAdmin],
  ["PUT", "/api/admin/settings", admin.updateSettings],
  ["POST", "/api/admin/settings/logo", admin.uploadLogo, { rate: ["upload", 60, 10 * MIN] }],
  ["GET", "/api/admin/pages", admin.listPages],
  ["PUT", "/api/admin/pages/:slug", admin.savePage],
  ["GET", "/api/admin/audit", admin.auditLog],
  ["GET", "/api/admin/newsletter", admin.newsletterList],
].map(([method, pattern, handler, options = {}]) => {
  const names = [];
  const re = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, n) => (names.push(n), "([^/]+)"))}$`);
  return { method, pattern, re, names, handler, options };
});

function matchRoute(method, pathname) {
  let pathMatched = false;
  for (const r of ROUTES) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    const params = {};
    r.names.forEach((n, i) => {
      try {
        params[n] = decodeURIComponent(m[i + 1]);
      } catch {
        params[n] = "";
      }
    });
    return { route: r, params };
  }
  return { route: null, pathMatched };
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp",
  ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

function serveStatic(req, res, config, notFoundHandler) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    return res.end();
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://local").pathname);
  } catch {
    res.statusCode = 400;
    return res.end("Bad request");
  }
  if (pathname.endsWith("/")) pathname += "index.html";
  // Only files inside public/, no dotfiles, no traversal.
  const abs = path.resolve(PUBLIC_DIR, `.${pathname}`);
  const rel = path.relative(PUBLIC_DIR, abs);
  const notFound = () => {
    if (notFoundHandler) return notFoundHandler();
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not found");
  };
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep).some((seg) => seg.startsWith("."))) return notFound();
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return notFound();
  }
  if (!stat.isFile()) return notFound();
  const ext = path.extname(abs).toLowerCase();
  if (!MIME[ext]) return notFound();
  setSecurityHeaders(res, { html: ext === ".html", production: config.isProduction });
  if (rel.split(path.sep)[0] === "admin") res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Content-Type", MIME[ext]);
  // CSS/JS are referenced with a content hash (?v=) so they can be cached for a year.
  const versioned = new URL(req.url, "http://local").searchParams.has("v");
  res.setHeader("Cache-Control", ext === ".html" ? "no-cache"
    : versioned ? "public, max-age=31536000, immutable"
      : ext === ".woff2" ? "public, max-age=31536000, immutable"
        : [".jpg", ".jpeg", ".png", ".webp", ".svg"].includes(ext) ? "public, max-age=2592000" : "public, max-age=300");
  res.setHeader("Content-Length", stat.size);
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(abs).on("error", () => res.destroy()).pipe(res);
}

/**
 * deps: { config, db, auth, razorpay, log?, limiter? }
 */
export function createApp(deps) {
  const log = deps.log || console;
  const limiter = deps.limiter || createRateLimiter();
  const secure = deps.config.isProduction || deps.config.appBaseUrl.startsWith("https://");
  const sessions = createSessionManager({ auth: deps.auth, secure });
  const full = { ...deps, log, limiter, sessions };
  const allowedOrigins = [deps.config.appBaseUrl, deps.config.corsOrigin].filter(Boolean);

  async function handleApi(req, res, url) {
    setSecurityHeaders(res, { production: deps.config.isProduction });
    const { route, params, pathMatched } = matchRoute(req.method, url.pathname);
    if (!route) return send(res, pathMatched ? 405 : 404, { error: pathMatched ? "method_not_allowed" : "not_found" });

    const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (mutating && route.options.csrf !== false && !isSameOriginRequest(req, { trustProxy: deps.config.trustProxy, allowed: allowedOrigins })) {
      return send(res, 403, { error: "cross_origin_blocked", message: "Cross-site request blocked." });
    }
    const ip = clientIp(req, deps.config.trustProxy);
    if (route.options.rate) {
      const [bucket, limit, windowMs] = route.options.rate;
      const r = limiter.hit(`${bucket}:${ip}`, limit, windowMs);
      if (!r.ok) return send(res, 429, { error: "rate_limited", message: "Too many requests. Try again shortly." }, { "Retry-After": String(r.retryAfter) });
    }

    const ctx = {
      req, res, url, params, ip, deps: full,
      cookies: parseCookies(req.headers.cookie),
      send: (status, body, headers) => send(res, status, body, headers),
      json: () => readJson(req),
      raw: (limit) => readRaw(req, limit),
      user: () => sessions.currentUser(req, res),
      async requireUser() {
        if (!deps.auth || !deps.db) throw new HttpError(503, "auth_not_configured", "Accounts are not configured yet.");
        const user = await sessions.currentUser(req, res);
        if (!user) throw new HttpError(401, "login_required", "Sign in to continue.");
        return user;
      },
    };

    try {
      await route.handler(ctx);
    } catch (error) {
      if (error instanceof HttpError) {
        const headers = error.extra?.retryAfter ? { "Retry-After": String(error.extra.retryAfter) } : {};
        return send(res, error.status, { error: error.code, message: error.message, ...error.extra }, headers);
      }
      log.error(`[api] ${req.method} ${url.pathname}:`, error);
      return send(res, 500, { error: "internal_error", message: "Something went wrong. Nothing was charged." });
    }
  }

  async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://local");
    } catch {
      res.statusCode = 400;
      return res.end();
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (req.method === "OPTIONS") {
        // Same-origin app: CORS only for an explicitly configured origin, never with "*".
        const origin = req.headers.origin;
        if (origin && deps.config.corsOrigin && origin === deps.config.corsOrigin) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Order-Key");
          res.setHeader("Vary", "Origin");
        }
        res.statusCode = 204;
        return res.end();
      }
      if (deps.config.corsOrigin && req.headers.origin === deps.config.corsOrigin) {
        res.setHeader("Access-Control-Allow-Origin", deps.config.corsOrigin);
        res.setHeader("Vary", "Origin");
      }
      return handleApi(req, res, url);
    }
    try {
      if (await handleSite(req, res, url, full)) return;
    } catch (error) {
      log.error(`[site] ${req.method} ${url.pathname}:`, error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Something went wrong. Please try again shortly.");
      }
      return;
    }
    return serveStatic(req, res, deps.config, () => sendNotFound(req, res, full).catch(() => res.end()));
  }

  return { handler, deps: full };
}
