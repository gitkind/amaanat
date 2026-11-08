import { asset, publicUrl } from "./assets.js";
import { html, jsonScript, raw } from "./html.js";

export const BRAND = {
  name: "Amaanat",
  tagline: "Some things are too precious to lose.",
  // The Instagram handle already linked from the original site.
  instagramFallback: "https://www.instagram.com/amanaat.ind/",
};

// Self-hosted in /public/fonts; the two used above the fold are preloaded.
const PRELOAD_FONTS = ["/fonts/jost.woff2", "/fonts/cormorant-garamond.woff2"];

export const POLICY_TITLES = { faq: "FAQ", shipping: "Shipping", returns: "Returns & refunds", privacy: "Privacy policy", terms: "Terms of service", about: "About" };

function wordmark(site, { tag = "a" } = {}) {
  const inner = site.logoUrl
    ? html`<img src="${publicUrl(site.logoUrl)}" alt="${BRAND.name}" width="160" height="44">`
    : html`<span class="wordmark-hi" lang="hi">अमानत</span><span class="wordmark-en">Amaanat</span>`;
  return tag === "a" ? html`<a class="wordmark" href="/" aria-label="${BRAND.name} — home">${inner}</a>` : html`<span class="wordmark">${inner}</span>`;
}

function header(site, active) {
  const cur = (key) => (active === key ? raw(' aria-current="page"') : "");
  return html`
<a class="skip-link" href="#main">Skip to content</a>
${site.announcement ? html`<div class="announcement">${site.announcement.link ? html`<a href="${site.announcement.link}">${site.announcement.text}</a>` : site.announcement.text}</div>` : ""}
<header class="site-header" id="header">
  <div class="container header-inner">
    <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav"><span class="nav-toggle-bars" aria-hidden="true"></span>Menu</button>
    ${wordmark(site)}
    <nav class="site-nav" id="site-nav" aria-label="Main">
      <button class="nav-close" type="button" aria-label="Close menu">Close</button>
      <a href="/shop"${cur("shop")}>Shop all</a>
      ${site.collections.map((c) => html`<a href="/collections/${c.slug}"${cur(`collection:${c.slug}`)}>${c.name}</a>`)}
      <a href="/about"${cur("about")}>Our story</a>
      <a class="show-sm" href="/track"${cur("track")}>Track order</a>
      <a class="show-sm" href="/account"${cur("account")}>Account</a>
    </nav>
    <div class="header-actions">
      <a class="hide-sm" href="/track"${cur("track")}>Track</a>
      <a class="hide-sm" href="/account" data-account-link${cur("account")}>Account</a>
      <a class="bag-link" href="/cart"${cur("cart")}>Bag <span class="bag-count" data-count="0" aria-label="items in bag"></span></a>
    </div>
  </div>
</header>`;
}

function footer(site) {
  const pages = new Map((site.pages || []).map((p) => [p.slug, p.title]));
  const social = [
    ["Instagram", site.social?.instagram || BRAND.instagramFallback],
    ["Facebook", site.social?.facebook],
    ["YouTube", site.social?.youtube],
    ["Pinterest", site.social?.pinterest],
  ].filter(([, url]) => url);
  return html`
<footer class="site-footer">
  <div class="container">
    <div class="footer-grid">
      <div class="footer-brand">
        ${wordmark(site, { tag: "span" })}
        <p class="footer-tag">${BRAND.tagline}</p>
      </div>
      <div class="footer-col">
        <h2>Shop</h2>
        <ul>
          <li><a href="/shop">All pieces</a></li>
          ${site.collections.map((c) => html`<li><a href="/collections/${c.slug}">${c.name}</a></li>`)}
        </ul>
      </div>
      <div class="footer-col">
        <h2>Help</h2>
        <ul>
          <li><a href="/contact">Contact</a></li>
          <li><a href="/track">Track an order</a></li>
          ${["faq", "shipping", "returns"].filter((s) => pages.has(s)).map((s) => html`<li><a href="/${s}">${POLICY_TITLES[s]}</a></li>`)}
        </ul>
      </div>
      <div class="footer-col">
        <h2>Amaanat</h2>
        <ul>
          <li><a href="/about">Our story</a></li>
          ${["privacy", "terms"].filter((s) => pages.has(s)).map((s) => html`<li><a href="/${s}">${POLICY_TITLES[s]}</a></li>`)}
          ${social.map(([name, url]) => html`<li><a href="${url}" target="_blank" rel="noopener">${name}</a></li>`)}
        </ul>
      </div>
    </div>
    <form class="newsletter-form footer-newsletter" id="newsletter" novalidate>
      <label class="footer-newsletter-label" for="nl-email">Letters from Amaanat</label>
      <input id="nl-email" name="email" type="email" autocomplete="email" placeholder="Your email" required maxlength="254">
      <button class="btn btn--gold" type="submit">Sign up</button>
      <p class="newsletter-note">We'll only use your email to write to you about Amaanat. Unsubscribe any time by replying.</p>
      <p class="newsletter-msg" role="status" aria-live="polite"></p>
    </form>
    <div class="footer-small"><span>© ${new Date().getFullYear()} ${site.storeName || BRAND.name} · India</span><span>Payments secured by Razorpay</span></div>
  </div>
</footer>`;
}

/**
 * opts: { site, title, description, path, canonical (abs), ogImage (abs), ogType, jsonLd[], noindex, active, body, scripts[], data }
 */
export function layout(opts) {
  const { site, title, description, canonical, ogImage, ogType = "website", jsonLd = [], noindex = false, active, body, scripts = [] } = opts;
  const fullTitle = title ? `${title} — ${BRAND.name}` : `${BRAND.name} — ${BRAND.tagline}`;
  return html`<!DOCTYPE html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fullTitle}</title>
<meta name="description" content="${description}">
${canonical ? html`<link rel="canonical" href="${canonical}">` : ""}
${noindex ? html`<meta name="robots" content="noindex, follow">` : ""}
<meta name="theme-color" content="#faeede">
<meta property="og:site_name" content="${BRAND.name}">
<meta property="og:title" content="${title || BRAND.name}">
<meta property="og:description" content="${description}">
<meta property="og:type" content="${ogType}">
${canonical ? html`<meta property="og:url" content="${canonical}">` : ""}
${ogImage ? html`<meta property="og:image" content="${ogImage}"><meta name="twitter:image" content="${ogImage}">` : ""}
<meta property="og:locale" content="en_IN">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${PRELOAD_FONTS.map((f) => html`<link rel="preload" href="${f}" as="font" type="font/woff2" crossorigin>`)}
<link rel="stylesheet" href="${asset("/styles.css")}">
${jsonLd.filter(Boolean).map((j) => html`<script type="application/ld+json">${raw(jsonScript(j))}</script>`)}
</head>
<body data-page="${active || ""}">
<div class="grain" aria-hidden="true"></div>
${header(site, active)}
<main id="main" tabindex="-1">
${body}
</main>
${footer(site)}
<script src="${asset("/app.js")}" defer></script>
${scripts.map((s) => html`<script src="${asset(s)}" defer></script>`)}
</body>
</html>`;
}
