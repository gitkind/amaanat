// Server-rendered storefront pages. Content comes only from the database
// (products, settings, published pages) or from the brand copy that was
// already on the original Amaanat landing page. Nothing is invented here:
// no reviews, ratings, discounts, delivery promises or policies.
import { collections as buildCollections, parseCatalogueQuery, publicProduct, queryCatalogue } from "../catalogue.js";
import { getProducts, getSettings } from "../services.js";
import { img, ogImagePath, publicUrl } from "./assets.js";
import { formatINR, formatPlainText, html, jsonScript, raw } from "./html.js";
import { BRAND, POLICY_TITLES, layout } from "./layout.js";
import { renderSections } from "./sections.js";
import { defaultDocument } from "../cms.js";

// Copy from the original landing page (owner-provided), used when the admin
// hasn't set homepage text.
export const DEFAULT_COPY = {
  heroEyebrow: "A new house of everyday gold",
  heroSubtitle: "Some things are too precious to lose.",
  heroText: "Jewellery you are trusted to keep — memories, gifts, and the small reminders of who you are. Made to be worn every single day.",
  heroImage: "/assets/post.jpg",
  storyTitle: "Something precious that someone trusts you to keep safe.",
  storyText: "Choosing a name was not easy. It needed to feel like a promise — not a trend, not a season, but a word you could return to.\n\nThat is what your jewellery already is. A gift kept close. A day you do not want to forget. A small, gold reminder of who you are when you put it on in the morning.",
};
export const PROMISE = [
  ["No tarnish", "Gold that keeps its warmth, without the dull film of neglect."],
  ["No fading", "Colour that holds, so the piece you chose is the piece you keep."],
  ["No skin irritation", "Kind against the skin, for jewellery you forget you are wearing."],
];

export async function loadSite(deps) {
  const [products, settings, content, cms] = await Promise.all([
    getProducts(deps),
    getSettings(deps),
    deps.db ? deps.db.rpc("api_public_content", {}) : Promise.resolve(null),
    // Published website content. Missing until migration 007 is applied: fall back to defaults.
    deps.db ? deps.db.rpc("api_cms_public", {}).catch(() => null) : Promise.resolve(null),
  ]);
  const c = content || {};
  const published = cms && typeof cms === "object" ? cms : {};
  return {
    cms: published,
    founderLive: Boolean(published.founder?.visible && published.founder?.name),
    paymentsOnline: Boolean(deps.razorpay),
    products: products.filter((p) => p.active !== false),
    settings: settings || {},
    collections: buildCollections(products),
    storeName: c.store_name || null,
    logoUrl: c.logo_url || null,
    announcement: c.announcement || null,
    homepage: { ...DEFAULT_COPY, ...Object.fromEntries(Object.entries(c.homepage || {}).filter(([, v]) => v)) },
    pages: c.pages || [],
    bestSellers: c.best_sellers || [],
    contact: {
      email: c.contact_email || null, phone: c.contact_phone || null, whatsapp: c.whatsapp_e164 || null, address: c.business_address || null,
    },
    social: { instagram: c.instagram_url || null, facebook: c.facebook_url || null, youtube: c.youtube_url || null, pinterest: c.pinterest_url || null },
  };
}

const threshold = (site) => site.settings?.lowStockThreshold ?? 2;
const pub = (site, p) => publicProduct(p, { lowStockThreshold: threshold(site) });

function priceLabel(p) {
  return p.minPricePaise !== p.maxPricePaise ? `From ${formatINR(p.minPricePaise)}` : formatINR(p.minPricePaise ?? p.pricePaise);
}

export function productCard(site, product, { eager = false } = {}) {
  const p = pub(site, product);
  const a = p.availability;
  const href = `/products/${p.slug}`;
  const quick = a.canBuy && !p.variants.length;
  return html`
<article class="card">
  <a class="card-media" href="${href}" tabindex="-1" aria-hidden="true">${img(p.image, { alt: p.alt || p.name, sizes: "(max-width: 760px) 50vw, (max-width: 1080px) 33vw, 25vw", eager })}</a>
  <div class="card-body">
    <p class="card-cat">${p.category}</p>
    <h3 class="card-title"><a href="${href}">${p.name}</a></h3>
    <p class="card-price">${priceLabel(p)}</p>
    <p class="card-status${a.canBuy ? " card-status--in" : ""}">${a.label}</p>
    ${quick ? html`<button class="btn btn--ghost btn--small card-quick" type="button" data-add-to-bag="${p.id}" data-name="${p.name}">Add to bag</button>` : ""}
  </div>
</article>`;
}

function grid(site, products, opts) {
  return html`<div class="product-grid">${products.map((p, i) => productCard(site, p, { eager: opts?.eagerFirst && i < 4 }))}</div>`;
}

function breadcrumb(items) {
  return html`<nav class="breadcrumb container" aria-label="Breadcrumb"><ol>${items.map(([label, href], i) =>
    html`<li>${href && i < items.length - 1 ? html`<a href="${href}">${label}</a>` : html`<span aria-current="page">${label}</span>`}</li>`)}</ol></nav>`;
}

function breadcrumbLd(base, items) {
  return {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: items.map(([name, href], i) => ({ "@type": "ListItem", position: i + 1, name, item: href ? base + href : undefined })),
  };
}

function organizationLd(site, base) {
  const sameAs = [site.social.instagram || BRAND.instagramFallback, site.social.facebook, site.social.youtube, site.social.pinterest].filter(Boolean);
  return {
    "@context": "https://schema.org", "@type": "Organization", name: site.storeName || BRAND.name, url: `${base}/`, slogan: BRAND.tagline,
    ...(site.logoUrl ? { logo: /^https?:/.test(site.logoUrl) ? site.logoUrl : base + publicUrl(site.logoUrl) } : {}),
    ...(sameAs.length ? { sameAs } : {}),
    ...(site.contact.email ? { email: site.contact.email } : {}),
  };
}

// ---------------- Home ----------------
// Website content documents: the published CMS version, or the original copy.
export function cmsDoc(site, key) {
  return site.cms?.[key] || defaultDocument(key, { homepage: site.homepage, promise: PROMISE });
}

function previewBanner(site) {
  return site.preview ? html`<div class="preview-bar" role="status">Preview of unpublished changes — customers don't see this yet. <a href="/admin/#/website">Back to the editor</a></div>` : "";
}

export function homePage(site, base) {
  const doc = cmsDoc(site, "home");
  const { body: sections, hasH1, firstImage } = renderSections(site, doc.sections, { productCard });
  const body = html`${previewBanner(site)}${hasH1 ? "" : html`<h1 class="visually-hidden">${site.storeName || BRAND.name} — ${BRAND.tagline}</h1>`}${sections}`;
  return layout({
    site, title: "", active: "home", body, canonical: `${base}/`, noindex: site.preview,
    description: "Amaanat is everyday gold-tone jewellery you can trust to keep. Necklaces, sets and anklets made to be worn every day.",
    ogImage: base + ogImagePath(firstImage || site.homepage.heroImage),
    jsonLd: [organizationLd(site, base), { "@context": "https://schema.org", "@type": "WebSite", name: BRAND.name, url: `${base}/` }],
  });
}

// ---------------- Shop / collection ----------------
export function shopPage(site, base, { collectionSlug = null, searchParams }) {
  const collection = collectionSlug ? site.collections.find((c) => c.slug === collectionSlug) : null;
  if (collectionSlug && !collection) return null;
  const query = parseCatalogueQuery(searchParams);
  query.category = collection ? collection.slug : "";
  const results = queryCatalogue(site.products, query);
  const title = collection ? collection.name : "Shop all jewellery";
  const path = collection ? `/collections/${collection.slug}` : "/shop";
  const filtered = Boolean(query.q || query.inStock || query.sort !== "featured" || query.minPrice != null || query.maxPrice != null);
  const crumbs = [["Home", "/"], ["Shop", "/shop"], ...(collection ? [[collection.name, path]] : [])];
  const body = html`
${breadcrumb(crumbs)}
<header class="page-hero container">
  <h1>${title}</h1>
  <p>${collection ? `Amaanat ${collection.name.toLowerCase()} — everyday gold-tone pieces.` : "Everyday gold-tone pieces, made to be worn."}</p>
</header>
<div class="container">
  <div class="toolbar">
    <nav class="chips" aria-label="Collections">
      <a class="chip" href="/shop"${collection ? "" : raw(' aria-current="page"')}>All</a>
      ${site.collections.map((c) => html`<a class="chip" href="/collections/${c.slug}"${collection?.slug === c.slug ? raw(' aria-current="page"') : ""}>${c.name}</a>`)}
    </nav>
    <form class="toolbar-form" method="get" action="${path}" role="search" id="shop-filters">
      <label class="visually-hidden" for="q">Search pieces</label>
      <input id="q" name="q" type="search" placeholder="Search pieces" maxlength="80" value="${query.q}">
      <label class="check"><input type="checkbox" name="inStock" value="1"${query.inStock ? raw(" checked") : ""}> In stock</label>
      <label class="visually-hidden" for="sort">Sort by</label>
      <select id="sort" name="sort">
        ${[["featured", "Featured"], ["newest", "Newest"], ["price_asc", "Price: low to high"], ["price_desc", "Price: high to low"], ["name", "Name"]].map(([v, l]) =>
          html`<option value="${v}"${query.sort === v ? raw(" selected") : ""}>${l}</option>`)}
      </select>
      <button class="btn btn--small" type="submit">Apply</button>
    </form>
  </div>
  <h2 class="visually-hidden">${title}</h2>
  <p class="results-count" role="status">${results.length} ${results.length === 1 ? "piece" : "pieces"}${query.q ? html` for “${query.q}”` : ""}</p>
  ${results.length ? grid(site, results, { eagerFirst: true }) : html`<div class="empty-state"><h2>Nothing matched</h2><p>Try another search or collection.</p><a class="btn btn--ghost" href="/shop">Clear filters</a></div>`}
  <div style="height:clamp(3rem,6vw,5rem)"></div>
</div>`;
  return layout({
    site, title, body, active: collection ? `collection:${collection.slug}` : "shop",
    canonical: base + path, noindex: filtered,
    description: collection
      ? `Shop Amaanat ${collection.name.toLowerCase()}: ${collection.count} everyday gold-tone ${collection.count === 1 ? "piece" : "pieces"}.`
      : `Shop all Amaanat jewellery: ${site.products.length} everyday gold-tone pieces — ${site.collections.map((c) => c.name.toLowerCase()).join(", ")}.`,
    ogImage: base + ogImagePath(results[0]?.image || "/assets/post.jpg"),
    jsonLd: [breadcrumbLd(base, crumbs), {
      "@context": "https://schema.org", "@type": "ItemList",
      itemListElement: results.slice(0, 30).map((p, i) => ({ "@type": "ListItem", position: i + 1, url: `${base}/products/${p.slug}`, name: p.name })),
    }],
    scripts: ["/js/shop.js"],
  });
}

// ---------------- Product ----------------
export function productPage(site, base, slug) {
  const product = site.products.find((p) => p.slug === slug);
  if (!product) return null;
  const p = pub(site, product);
  const a = p.availability;
  const collection = site.collections.find((c) => c.name === p.category);
  const crumbs = [["Home", "/"], ["Shop", "/shop"], ...(collection ? [[collection.name, `/collections/${collection.slug}`]] : []), [p.name, `/products/${p.slug}`]];
  const related = site.products.filter((x) => x.id !== p.id && x.category === p.category).slice(0, 4);
  const images = p.images.length ? p.images : [p.image];
  const shipping = site.settings?.shippingConfirmed && Number.isInteger(site.settings.shippingPaise) ? site.settings.shippingPaise : null;
  const published = new Set(site.pages.map((x) => x.slug));
  const offers = (() => {
    // Offers only for units actually purchasable now; unconfirmed stock is never advertised.
    const units = p.variants.length ? p.variants.filter((v) => v.availability.canBuy) : a.canBuy ? [{ pricePaise: p.pricePaise }] : [];
    if (!units.length) return undefined;
    const prices = units.map((u) => u.pricePaise / 100);
    return units.length === 1
      ? { "@type": "Offer", price: prices[0].toFixed(2), priceCurrency: "INR", availability: "https://schema.org/InStock", url: `${base}/products/${p.slug}` }
      : { "@type": "AggregateOffer", lowPrice: Math.min(...prices).toFixed(2), highPrice: Math.max(...prices).toFixed(2), offerCount: units.length, priceCurrency: "INR", availability: "https://schema.org/InStock" };
  })();
  const body = html`
${breadcrumb(crumbs)}
<div class="container pdp" id="pdp">
  <div class="gallery">
    <div class="gallery-main" id="gallery-main">${img(images[0], { alt: p.alt || p.name, sizes: "(max-width: 860px) 100vw, 56vw", eager: true })}</div>
    ${images.length > 1 ? html`<div class="gallery-thumbs" role="list">${images.map((src, i) => html`
      <button class="gallery-thumb" type="button" role="listitem" data-index="${i}" aria-label="Show image ${i + 1} of ${images.length}"${i === 0 ? raw(' aria-current="true"') : ""}>${img(src, { alt: "", sizes: "80px" })}</button>`)}</div>` : ""}
  </div>
  <div class="pdp-info">
    ${collection ? html`<p class="eyebrow"><a href="/collections/${collection.slug}" class="text-link" style="text-decoration:none">${p.category}</a></p>` : html`<p class="eyebrow">${p.category}</p>`}
    <h1>${p.name}</h1>
    <p class="pdp-price" id="pdp-price">${priceLabel(p)}</p>
    <p class="pdp-status${a.canBuy ? " pdp-status--in" : ""}" id="pdp-status">${a.label}</p>
    <p class="pdp-desc">${p.description}</p>
    <form id="buy-form" novalidate>
      ${p.variants.length ? html`<fieldset class="variant-picker"><legend>Choose an option</legend><div class="variant-options">
        ${p.variants.map((v) => html`<label class="variant-option"><input type="radio" name="variant" value="${v.id}"${v.availability.canBuy ? "" : raw(" disabled")}>
          <span>${v.name}<small>${formatINR(v.pricePaise)} · ${v.availability.label}</small></span></label>`)}
      </div></fieldset>` : ""}
      <div class="buy-row">
        <div class="qty" role="group" aria-label="Quantity"${a.canBuy ? "" : raw(" hidden")}>
          <button type="button" data-step="-1" aria-label="Decrease quantity">−</button><output id="qty" aria-live="polite">1</output><button type="button" data-step="1" aria-label="Increase quantity">+</button>
        </div>
        <button class="btn" type="submit" id="add"${a.canBuy && !p.variants.length ? "" : raw(" disabled")}>${a.canBuy ? (p.variants.length ? "Choose an option" : "Add to bag") : a.label}</button>
      </div>
      <button class="btn btn--ghost btn--block" type="button" id="wish" hidden>Save to wishlist</button>
      ${a.code === "unconfirmed" ? html`<p class="fine-print">Not available to order yet — stock is still being confirmed.</p>` : ""}
    </form>
    <div class="details">
      <details><summary>Shipping</summary><div>
        ${shipping === null ? "Shipping charges are shown at checkout once confirmed." : shipping === 0 ? "Shipping is free on orders." : `Shipping is ${formatINR(shipping)} per order.`}
        ${published.has("shipping") ? html` <a class="text-link" href="/shipping">Shipping policy</a>` : ""}
      </div></details>
      <details><summary>Returns</summary><div>
        ${published.has("returns") ? html`See our <a class="text-link" href="/returns">returns &amp; refunds policy</a>.` : html`Our returns policy is being finalised. <a class="text-link" href="/contact">Contact us</a> with any questions before ordering.`}
      </div></details>
      ${site.paymentsOnline ? html`<details><summary>Secure payment</summary><div>Payments are processed by Razorpay. Your order is confirmed only after the payment is verified by our server.</div></details>`
        : site.settings?.codEnabled ? html`<details><summary>Payment</summary><div>Pay in cash when your order is delivered.</div></details>` : ""}
    </div>
  </div>
</div>
<script type="application/json" id="product-data">${raw(jsonScript({ id: p.id, name: p.name, images: images.map(publicUrl), alt: p.alt || p.name, variants: p.variants, availability: a, pricePaise: p.pricePaise }))}</script>
${related.length ? html`<section class="section section--cream" aria-labelledby="related-title"><div class="container">
  <div class="section-head"><h2 id="related-title">You may also like</h2>${collection ? html`<a class="link-arrow" href="/collections/${collection.slug}">All ${collection.name.toLowerCase()}</a>` : ""}</div>
  ${grid(site, related)}</div></section>` : ""}`;
  return layout({
    site, title: p.name, body, active: collection ? `collection:${collection.slug}` : "shop",
    canonical: `${base}/products/${p.slug}`, ogType: "product",
    description: `${p.description} ${priceLabel(p)}.`.slice(0, 300),
    ogImage: base + ogImagePath(images[0]),
    jsonLd: [breadcrumbLd(base, crumbs), {
      "@context": "https://schema.org", "@type": "Product", name: p.name, description: p.description, sku: p.id, category: p.category,
      image: images.map((src) => base + ogImagePath(src)), brand: { "@type": "Brand", name: BRAND.name },
      ...(offers ? { offers } : {}),
    }],
    scripts: ["/js/product.js"],
  });
}

// ---------------- About / contact / policies ----------------
export function aboutPage(site, base, extra) {
  const doc = cmsDoc(site, "about");
  const first = doc.sections.find((x) => x.enabled !== false);
  const ownHero = first?.type === "hero";
  const { body: sections, firstImage } = renderSections(site, doc.sections, { productCard, allowH1: ownHero });
  const body = html`${previewBanner(site)}
${ownHero ? "" : html`<header class="page-hero container"><p class="eyebrow">Our story</p><h1>The name is the promise</h1></header>`}
${sections}
${extra?.body ? html`<section class="section"><div class="container prose">${formatPlainText(extra.body)}</div></section>` : ""}`;
  return layout({
    site, title: "Our story", body, active: "about", canonical: `${base}/about`, noindex: site.preview,
    description: "Amaanat means a trust — something precious someone trusts you to keep safe. The story behind our everyday gold-tone jewellery.",
    ogImage: base + ogImagePath(firstImage || "/assets/post.jpg"),
  });
}

// ---------------- Meet the Founder ----------------
export const founderLive = (site) => Boolean(site.cms?.founder?.visible && site.cms.founder.name);

export function founderPage(site, base) {
  const f = site.preview ? cmsDoc(site, "founder") : site.cms?.founder || {};
  const live = site.preview ? Boolean(f.name) : founderLive(site);
  const block = (title, text) => (text ? html`<section class="founder-block"><h2>${title}</h2>${formatPlainText(text)}</section>` : "");
  const body = live ? html`${previewBanner(site)}
<section class="founder-hero container">
  <div class="founder-photo">${f.image?.src ? img(f.image.src, { alt: f.image.alt || f.name, sizes: "(max-width: 860px) 100vw, 40vw", eager: true }) : html`<span class="founder-initial" aria-hidden="true">${f.name.slice(0, 1)}</span>`}</div>
  <div class="founder-intro">
    <p class="eyebrow">Meet the founder</p>
    <h1>${f.name}</h1>
    ${f.designation ? html`<p class="founder-role">${f.designation}</p>` : ""}
    ${formatPlainText(f.bio)}
  </div>
</section>
<div class="container founder-body">
  ${block("The story behind Amaanat", f.story)}
  ${block("Inspiration", f.inspiration)}
  ${f.mission || f.vision ? html`<div class="founder-mv">${f.mission ? html`<section><p class="eyebrow">Mission</p>${formatPlainText(f.mission)}</section>` : ""}${f.vision ? html`<section><p class="eyebrow">Vision</p>${formatPlainText(f.vision)}</section>` : ""}</div>` : ""}
</div>
${f.message ? html`<section class="section section--cream"><div class="container letter"><p class="eyebrow">A message from ${f.name}</p>${formatPlainText(f.message)}${f.signature ? html`<p class="letter-sign">${f.signature}</p>` : ""}</div></section>` : ""}
<div class="container" style="padding-block:3rem 4rem;text-align:center"><a class="btn" href="/shop">Shop the collection</a></div>`
    : html`${previewBanner(site)}<div class="narrow empty-state"><p class="eyebrow">Meet the founder</p><h1 style="font-size:var(--step-3)">Our founder's story is coming soon</h1>
<p>In the meantime, read <a class="text-link" href="/about">the story behind the name</a>.</p></div>`;
  return layout({
    site, title: live ? `Meet the founder — ${f.name}` : "Meet the founder", body, active: "founder", canonical: `${base}/meet-the-founder`,
    noindex: site.preview || !live,
    description: live ? `${f.name}${f.designation ? `, ${f.designation}` : ""} — the person behind Amaanat jewellery.`.slice(0, 300) : "The story of Amaanat's founder is coming soon.",
    ogImage: live && f.image?.src ? base + ogImagePath(f.image.src) : base + ogImagePath("/assets/post.jpg"),
    ogType: live ? "profile" : "website",
  });
}

export function contactPage(site, base) {
  const c = site.contact;
  const instagram = site.social.instagram || BRAND.instagramFallback;
  const wa = c.whatsapp ? `https://wa.me/${c.whatsapp.replace(/^\+/, "")}` : null;
  const body = html`
<header class="page-hero container"><p class="eyebrow">Contact</p><h1>We'd love to hear from you</h1>
  <p>Questions about a piece or an order? Reach us on any of these.</p></header>
<div class="container" style="padding-bottom:4rem"><div class="account-grid">
  ${c.email ? html`<div class="panel"><h2>Email</h2><p><a class="text-link" href="mailto:${c.email}">${c.email}</a></p></div>` : ""}
  ${wa ? html`<div class="panel"><h2>WhatsApp</h2><p><a class="text-link" href="${wa}" target="_blank" rel="noopener">Message us on WhatsApp</a></p></div>` : ""}
  ${c.phone ? html`<div class="panel"><h2>Phone</h2><p><a class="text-link" href="tel:${c.phone.replace(/[^+0-9]/g, "")}">${c.phone}</a></p></div>` : ""}
  <div class="panel"><h2>Instagram</h2><p><a class="text-link" href="${instagram}" target="_blank" rel="noopener">Follow and message us on Instagram</a></p></div>
  ${c.address ? html`<div class="panel"><h2>Address</h2><p>${c.address}</p></div>` : ""}
  <div class="panel"><h2>Your order</h2><p>Have your order reference? <a class="text-link" href="/track">Track your order</a>.</p></div>
</div></div>`;
  return layout({
    site, title: "Contact", body, active: "contact", canonical: `${base}/contact`,
    description: "Contact Amaanat about a piece or an order.",
    jsonLd: [organizationLd(site, base)],
  });
}

export function policyPage(site, base, slug, page) {
  const title = page?.title || POLICY_TITLES[slug];
  const body = html`
<header class="page-hero container"><h1>${title}</h1>${page?.updatedAt ? html`<p>Last updated ${new Date(page.updatedAt).toLocaleDateString("en-IN", { dateStyle: "long" })}</p>` : ""}</header>
<div class="container prose">
  ${page ? formatPlainText(page.body) : html`<p>This page is being prepared and will be published soon.</p>
    <p>Until then, please <a class="text-link" href="/contact">contact us</a> with any questions before you order.</p>`}
</div>`;
  return layout({
    site, title, body, active: slug, canonical: `${base}/${slug}`, noindex: !page,
    description: page ? `${title} for Amaanat jewellery orders.` : `Amaanat's ${title.toLowerCase()} page is being prepared. Contact us with any questions.`,
  });
}

// ---------------- App shells (filled by client JS; not indexed) ----------------
const SHELLS = {
  cart: { title: "Your bag", description: "Review the Amaanat pieces in your bag before checkout.", script: "/js/cart.js", body: html`<header class="page-hero container"><h1>Your bag</h1></header><div class="container" id="cart" aria-live="polite"><div class="spinner" role="status" aria-label="Loading your bag"></div></div>` },
  checkout: {
    title: "Checkout", description: "Secure checkout for your Amaanat order, with payment by Razorpay.", script: "/js/checkout.js",
    body: html`<header class="page-hero container"><h1>Checkout</h1></header>
<div class="container checkout-layout">
  <section aria-labelledby="delivery-title">
    <h2 id="delivery-title">Delivery details</h2>
    <div id="checkout-notice"></div>
    <div class="form-group" id="saved-wrap" hidden><label for="saved-address">Saved address</label><select id="saved-address"></select></div>
    <form id="checkout-form" novalidate>
      <div class="form-row">
        <div class="form-group"><label for="fullName">Full name</label><input id="fullName" name="fullName" autocomplete="name" required maxlength="120"></div>
        <div class="form-group"><label for="phone">Mobile</label><input id="phone" name="phone" type="tel" inputmode="numeric" autocomplete="tel-national" required maxlength="16"></div>
      </div>
      <div class="form-group"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="254"></div>
      <div class="form-group"><label for="address">Address</label><input id="address" name="address" autocomplete="address-line1" required maxlength="200"></div>
      <div class="form-group"><label for="apartment">Apartment, floor (optional)</label><input id="apartment" name="apartment" autocomplete="address-line2" maxlength="200"></div>
      <div class="form-row">
        <div class="form-group"><label for="locality">Locality</label><input id="locality" name="locality" required maxlength="120"></div>
        <div class="form-group"><label for="city">City</label><input id="city" name="city" autocomplete="address-level2" required maxlength="120"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label for="state">State</label><select id="state" name="state" autocomplete="address-level1" required></select></div>
        <div class="form-group"><label for="pin">PIN code</label><input id="pin" name="pin" inputmode="numeric" autocomplete="postal-code" required maxlength="6"></div>
      </div>
      <div class="form-group"><label for="notes">Note (optional)</label><textarea id="notes" name="notes" maxlength="500"></textarea></div>
      <label class="check" id="save-wrap" hidden><input type="checkbox" id="saveAddress"> Save this address to my account</label>
      <fieldset class="variant-picker" id="pay-methods" hidden style="margin-top:1.5rem"><legend>Payment</legend><div class="variant-options">
        <label class="variant-option" data-method="cod" hidden><input type="radio" name="paymentMethod" value="cod"><span>Cash on delivery<small>Pay in cash when your order arrives</small></span></label>
        <label class="variant-option" data-method="razorpay" hidden><input type="radio" name="paymentMethod" value="razorpay"><span>Pay online<small>UPI, cards and net banking via Razorpay</small></span></label>
      </div></fieldset>
      <button class="btn btn--block" id="pay-btn" type="submit" disabled style="margin-top:1rem">Pay securely</button>
      <p class="fine-print" id="pay-mode"></p>
    </form>
  </section>
  <aside class="summary" aria-labelledby="summary-title"><h2 id="summary-title">Order summary</h2><div id="summary"><div class="spinner"></div></div></aside>
</div>`,
  },
  order: { title: "Your order", description: "Confirmation and status of your Amaanat order.", script: "/js/order.js", body: html`<div class="narrow" id="order" aria-live="polite"><header class="page-hero" style="padding-inline:0"><h1>Your order</h1></header><div class="spinner" role="status" aria-label="Loading order"></div></div>` },
  track: {
    title: "Track your order", description: "Track an Amaanat order with your order reference and the email used at checkout.", script: "/js/track.js", index: true,
    body: html`<div class="narrow"><header class="page-hero" style="padding-inline:0"><h1>Track your order</h1><p>Enter the order reference from your confirmation and the email used at checkout.</p></header>
<form class="panel" id="track-form" novalidate>
  <div class="form-group"><label for="ref">Order reference</label><input id="ref" name="ref" placeholder="AM-1A2B3C4D" required maxlength="11" autocapitalize="characters"></div>
  <div class="form-group"><label for="t-email">Email</label><input id="t-email" name="email" type="email" required maxlength="254" autocomplete="email"></div>
  <button class="btn btn--block" type="submit">Find order</button>
</form><div id="track-result" aria-live="polite"></div></div>`,
  },
  account: { title: "Account", description: "Sign in to your Amaanat account to see orders, saved addresses and your wishlist.", script: "/js/account.js", body: html`<header class="page-hero container"><h1 id="account-title">Account</h1><p id="account-sub"></p></header><div class="container" id="account" aria-live="polite" style="padding-bottom:4rem"><div class="spinner"></div></div>` },
  wishlist: { title: "Wishlist", description: "The Amaanat pieces you have saved to your wishlist.", script: "/js/wishlist.js", body: html`<header class="page-hero container"><h1>Wishlist</h1><p>Pieces you've saved.</p></header><div class="container" id="wishlist" aria-live="polite" style="padding-bottom:4rem"><div class="spinner"></div></div>` },
  "forgot-password": {
    title: "Forgot password", description: "Request a link to reset the password for your Amaanat account.", script: "/js/forgot.js",
    body: html`<div class="narrow"><header class="page-hero" style="padding-inline:0"><p class="eyebrow">Account</p><h1>Reset your password</h1>
<p>Enter the email address you use to sign in. If it matches an account, we'll email you a link to choose a new password.</p></header>
<form class="panel" id="forgot-form" novalidate>
  <div class="form-group"><label for="fp-email">Email</label><input id="fp-email" name="email" type="email" autocomplete="email" required maxlength="254"></div>
  <button class="btn btn--block" type="submit">Email me a reset link</button>
  <p class="fine-print" id="forgot-msg" role="status" aria-live="polite"></p>
</form>
<p class="fine-print">Remembered it? <a class="text-link" href="/account">Customer sign in</a> · <a class="text-link" href="/admin/">Store admin sign in</a></p></div>`,
  },
  "reset-password": {
    title: "Choose a new password", description: "Choose a new password for your Amaanat account.", script: "/js/reset.js",
    body: html`<div class="narrow"><header class="page-hero" style="padding-inline:0"><p class="eyebrow">Account</p><h1>Choose a new password</h1>
<p id="reset-sub">Checking your reset link…</p></header>
<div id="reset-status" aria-live="polite"><div class="spinner" role="status" aria-label="Checking your link"></div></div>
<form class="panel" id="reset-form" novalidate hidden>
  <div class="form-group"><label for="rp-password">New password</label><input id="rp-password" name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="72" aria-describedby="rp-hint"></div>
  <p class="fine-print" id="rp-hint" style="margin-top:-.6rem;margin-bottom:1rem">Use 8 to 72 characters. A longer phrase is stronger than a short complex word.</p>
  <div class="form-group"><label for="rp-confirm">Confirm new password</label><input id="rp-confirm" name="confirm" type="password" autocomplete="new-password" required minlength="8" maxlength="72"></div>
  <label class="check" style="margin-bottom:1rem"><input type="checkbox" id="rp-show"> Show passwords</label>
  <button class="btn btn--block" type="submit">Save new password</button>
</form></div>`,
  },
};

export function shellPage(site, base, name) {
  const s = SHELLS[name];
  return layout({
    site, title: s.title, body: s.body, active: name, canonical: `${base}/${name}`, noindex: !s.index,
    description: s.description,
    scripts: [s.script],
  });
}

export function notFoundPage(site) {
  const body = html`<div class="container empty-state"><p class="eyebrow">404</p><h1 style="font-size:var(--step-3)">We couldn't find that page</h1>
<p>It may have moved, or the piece may no longer be available.</p><a class="btn" href="/shop">Shop the collection</a></div>`;
  return layout({ site, title: "Page not found", body, noindex: true, description: "Page not found.", canonical: null });
}

// ---------------- sitemap / robots ----------------
export function sitemapXml(site, base) {
  const urls = [
    ["/", "weekly"], ["/shop", "weekly"], ["/about", "monthly"], ["/contact", "monthly"], ["/track", "yearly"],
    ...(founderLive(site) ? [["/meet-the-founder", "monthly"]] : []),
    ...site.collections.map((c) => [`/collections/${c.slug}`, "weekly"]),
    ...site.products.map((p) => [`/products/${p.slug}`, "weekly", p.updatedAt]),
    ...site.pages.filter((p) => p.slug !== "about").map((p) => [`/${p.slug}`, "monthly"]),
  ];
  const x = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([path, freq, mod]) => `  <url><loc>${x(base + path)}</loc>${mod ? `<lastmod>${x(new Date(mod).toISOString().slice(0, 10))}</lastmod>` : ""}<changefreq>${freq}</changefreq></url>`).join("\n")}
</urlset>
`;
}

export function robotsTxt(base, { production }) {
  if (!production) return "User-agent: *\nDisallow: /\n";
  return `User-agent: *
Disallow: /admin/
Disallow: /api/
Disallow: /cart
Disallow: /checkout
Disallow: /account
Disallow: /order
Disallow: /wishlist
Disallow: /forgot-password
Disallow: /reset-password

Sitemap: ${base}/sitemap.xml
`;
}
