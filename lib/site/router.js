import { requestOrigin, setSecurityHeaders } from "../security.js";
import { toString } from "./html.js";
import {
  aboutPage, contactPage, founderPage, homePage, loadSite, notFoundPage, policyPage, productPage, robotsTxt, shellPage, shopPage, sitemapXml,
} from "./pages.js";

const POLICY_SLUGS = new Set(["faq", "shipping", "returns", "privacy", "terms"]);
const SHELLS = new Set(["cart", "checkout", "order", "track", "account", "wishlist", "forgot-password", "reset-password"]);

// Old .html URLs keep working via permanent redirects.
const LEGACY = {
  "/index.html": () => "/",
  "/shop.html": (sp) => (sp.get("category") ? `/collections/${encodeURIComponent(sp.get("category"))}` : "/shop"),
  "/product.html": (sp) => (sp.get("slug") ? `/products/${encodeURIComponent(sp.get("slug"))}` : "/shop"),
  "/cart.html": () => "/cart",
  "/checkout.html": () => "/checkout",
  "/order.html": (sp) => `/order${sp.get("id") ? `?id=${encodeURIComponent(sp.get("id"))}` : ""}`,
  "/order-tracking.html": () => "/track",
  "/account.html": (sp) => `/account${sp.get("next") ? `?next=${encodeURIComponent(sp.get("next"))}` : ""}`,
  "/about.html": () => "/about",
  "/contact.html": () => "/contact",
};

function baseUrl(req, config) {
  return config.appBaseUrl || requestOrigin(req, config.trustProxy) || "";
}

function sendHtml(res, status, page, { cache = true, production } = {}) {
  const body = toString(page);
  res.statusCode = status;
  setSecurityHeaders(res, { html: true, production });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Pages hold no personal data (bag/account load via the API), so the CDN may cache briefly.
  res.setHeader("Cache-Control", cache ? "public, max-age=0, s-maxage=60, stale-while-revalidate=600" : "no-store");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function sendText(res, type, body) {
  res.statusCode = 200;
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(body);
}

// Returns true when the request was handled.
export async function handleSite(req, res, url, deps) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const { config } = deps;
  const production = config.isProduction;

  if (LEGACY[url.pathname]) {
    res.statusCode = 301;
    res.setHeader("Location", LEGACY[url.pathname](url.searchParams));
    res.end();
    return true;
  }

  const ROUTES = [
    [/^\/$/, "home"], [/^\/shop$/, "shop"], [/^\/collections\/([a-z0-9-]{1,60})$/, "collection"],
    [/^\/products\/([a-z0-9-]{1,120})$/, "product"], [/^\/about$/, "about"], [/^\/contact$/, "contact"],
    [/^\/meet-the-founder$/, "founder"],
    [/^\/sitemap\.xml$/, "sitemap"], [/^\/robots\.txt$/, "robots"],
  ];
  let m = null;
  let route = null;
  for (const [re, name] of ROUTES) {
    const hit = re.exec(path);
    if (hit) { m = hit; route = name; break; }
  }
  if (!route && POLICY_SLUGS.has(path.slice(1))) route = "policy";
  if (!route && SHELLS.has(path.slice(1))) route = "shell";
  if (!route) return false;

  const base = baseUrl(req, config);
  if (route === "robots") {
    sendText(res, "text/plain; charset=utf-8", robotsTxt(base, { production: production && Boolean(config.appBaseUrl) }));
    return true;
  }

  const site = await loadSite(deps);
  // ?preview=draft shows unpublished website content — only to signed-in admins, never cached.
  const previewRequested = url.searchParams.has("preview");
  if (previewRequested && ["home", "about", "founder"].includes(route)) {
    const drafts = await loadDrafts(req, res, deps);
    if (drafts) {
      site.cms = { ...site.cms, ...drafts };
      site.preview = true;
    }
  }
  let page = null;
  switch (route) {
    case "home": page = homePage(site, base); break;
    case "shop": page = shopPage(site, base, { searchParams: url.searchParams }); break;
    case "collection": page = shopPage(site, base, { collectionSlug: m[1], searchParams: url.searchParams }); break;
    case "product": page = productPage(site, base, m[1]); break;
    case "about": {
      const extra = deps.db ? await deps.db.rpc("api_public_page", { p_slug: "about" }) : null;
      page = aboutPage(site, base, extra);
      break;
    }
    case "contact": page = contactPage(site, base); break;
    case "founder": page = founderPage(site, base); break;
    case "policy": {
      const slug = path.slice(1);
      const p = deps.db ? await deps.db.rpc("api_public_page", { p_slug: slug }) : null;
      page = policyPage(site, base, slug, p ? { title: p.title, body: p.body, updatedAt: p.updated_at } : null);
      break;
    }
    case "shell": page = shellPage(site, base, path.slice(1)); break;
    case "sitemap":
      sendText(res, "application/xml; charset=utf-8", sitemapXml(site, base));
      return true;
  }
  if (!page) {
    sendHtml(res, 404, notFoundPage(site, base), { cache: false, production });
    return true;
  }
  sendHtml(res, 200, page, { production, cache: !previewRequested });
  return true;
}

async function loadDrafts(req, res, deps) {
  if (!deps.db || !deps.auth) return null;
  const user = await deps.sessions.currentUser(req, res).catch(() => null);
  if (!user?.id) return null;
  const role = await deps.db.rpc("api_admin_role", { p_user_id: user.id }).catch(() => null);
  if (!role) return null;
  const out = {};
  for (const key of ["home", "about", "founder", "site"]) {
    const state = await deps.db.rpc("api_admin_cms_get", { p_key: key }).catch(() => null);
    if (state?.draft && Object.keys(state.draft).length) out[key] = state.draft;
  }
  return out;
}

export async function sendNotFound(req, res, deps) {
  const site = await loadSite(deps).catch(() => ({ products: [], collections: [], pages: [], social: {}, contact: {}, homepage: {}, settings: {}, bestSellers: [] }));
  sendHtml(res, 404, notFoundPage(site, baseUrl(req, deps.config)), { cache: false, production: deps.config.isProduction });
}
