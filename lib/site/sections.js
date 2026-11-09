// Renders owner-edited CMS sections (see lib/cms.js) with the storefront's
// design system. All values are escaped by html``; text uses formatPlainText.
import { collections as buildCollections } from "../catalogue.js";
import { img } from "./assets.js";
import { formatPlainText, html } from "./html.js";

function buttons(list, { first = "btn", rest = "btn btn--ghost" } = {}) {
  if (!list?.length) return "";
  return html`<div class="hero-actions">${list.map((b, i) => html`<a class="${i === 0 ? first : rest}" href="${b.href}">${b.label}</a>`)}</div>`;
}

function linkArrow(list) {
  const b = list?.[0];
  return b ? html`<a class="link-arrow" href="${b.href}">${b.label}</a>` : "";
}

function head(s, { id, tag = "h2" } = {}) {
  if (!s.eyebrow && !s.title && !s.text) return "";
  const h = tag === "h1" ? html`<h1 id="${id}">${s.title}</h1>` : s.title ? html`<h2 id="${id}">${s.title}</h2>` : "";
  return html`<div>${s.eyebrow ? html`<p class="eyebrow">${s.eyebrow}</p>` : ""}${h}${s.text ? html`<p>${s.text}</p>` : ""}</div>`;
}

const hasImage = (s) => Boolean(s.image?.src);

function productsFor(site, s) {
  const limit = Number(s.limit) || 4;
  const byId = new Map(site.products.map((p) => [p.id, p]));
  switch (s.source) {
    case "bestsellers": return site.bestSellers.map((id) => byId.get(id)).filter(Boolean).slice(0, limit);
    case "newest": return [...site.products].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit);
    case "collection": return site.products.filter((p) => buildCollections([p])[0]?.slug === s.collection).slice(0, limit);
    case "manual": return (s.productIds || []).map((id) => byId.get(id)).filter(Boolean).slice(0, limit);
    default: return site.products.filter((p) => p.featured).slice(0, limit);
  }
}

const RENDER = {
  hero(site, s, { h1, id }) {
    const titleTag = h1 ? "h1" : "h2";
    const title = s.title
      ? html`<span class="hero-title-hi">${s.title}</span>`
      : html`<span class="hero-title-hi" lang="hi">अमानत</span><span class="hero-title-en">Amaanat</span>`;
    const heading = titleTag === "h1" ? html`<h1 class="hero-title" id="${id}">${title}</h1>` : html`<h2 class="hero-title" id="${id}">${title}</h2>`;
    const copy = html`<div class="hero-copy">
    ${s.eyebrow ? html`<p class="eyebrow">${s.eyebrow}</p>` : ""}
    ${heading}
    ${s.subtitle ? html`<p class="hero-tagline">${s.subtitle}</p>` : ""}
    ${s.text ? html`<p class="lede">${s.text}</p>` : ""}
    ${buttons(s.buttons)}
  </div>`;
    const media = hasImage(s) ? html`<div class="hero-media">${img(s.image.src, { alt: s.image.alt, sizes: s.layout === "full" ? "100vw" : "(max-width: 860px) 100vw, 52vw", eager: h1 })}</div>` : "";
    return html`<section class="hero hero--${s.layout}${hasImage(s) ? "" : " hero--no-media"}" aria-labelledby="${id}">${s.layout === "split-left" ? [media, copy] : [copy, media]}</section>`;
  },

  imageText(site, s, { id }) {
    return html`<section class="section" aria-labelledby="${id}"><div class="container split${s.layout === "image-right" ? " split--reverse" : ""}">
    ${hasImage(s) ? html`<div class="split-media reveal">${img(s.image.src, { alt: s.image.alt, sizes: "(max-width: 860px) 100vw, 50vw" })}</div>` : ""}
    <div>
      ${s.eyebrow ? html`<p class="eyebrow">${s.eyebrow}</p>` : ""}
      ${s.title ? html`<h2 id="${id}">${s.title}</h2>` : ""}
      ${formatPlainText(s.text)}
      ${buttons(s.buttons)}
    </div></div></section>`;
  },

  featuredProducts(site, s, { id, productCard, tone }) {
    const items = productsFor(site, s);
    if (!items.length) return "";
    return html`<section class="section${tone()}" aria-labelledby="${id}"><div class="container">
    <div class="section-head">${head(s, { id })}${linkArrow(s.buttons)}</div>
    <div class="product-grid${s.layout === "grid-3" ? " product-grid--3" : ""}">${items.map((p) => productCard(site, p))}</div>
  </div></section>`;
  },

  categories(site, s, { id }) {
    const wanted = new Set(s.collections || []);
    const list = site.collections.filter((c) => !wanted.size || wanted.has(c.slug));
    if (!list.length) return "";
    const imageFor = (slug) => site.products.find((p) => buildCollections([p])[0]?.slug === slug)?.image;
    return html`<section class="section" aria-labelledby="${id}"><div class="container">
    <div class="section-head">${head(s, { id })}${linkArrow(s.buttons)}</div>
    ${s.layout === "chips"
      ? html`<nav class="chips chips--large" aria-label="${s.title || "Collections"}">${list.map((c) => html`<a class="chip" href="/collections/${c.slug}">${c.name}</a>`)}</nav>`
      : html`<div class="tiles">${list.map((c) => html`
      <a class="tile reveal" href="/collections/${c.slug}">${img(imageFor(c.slug) || c.image, { alt: "", sizes: "(max-width: 760px) 100vw, 33vw" })}
        <span class="tile-label"><h3>${c.name}</h3><span>${c.count} ${c.count === 1 ? "piece" : "pieces"}</span></span></a>`)}</div>`}
  </div></section>`;
  },

  promo(site, s, { id }) {
    const photo = s.layout === "image" && hasImage(s);
    return html`<section class="promo promo--${photo ? "image" : s.layout === "image" ? "gold" : s.layout}" aria-labelledby="${id}">
    ${photo ? html`<div class="promo-media">${img(s.image.src, { alt: s.image.alt, sizes: "100vw" })}</div>` : ""}
    <div class="container promo-copy">
      ${s.eyebrow ? html`<p class="eyebrow">${s.eyebrow}</p>` : ""}
      ${s.title ? html`<h2 id="${id}">${s.title}</h2>` : ""}
      ${s.text ? html`<p class="lede">${s.text}</p>` : ""}
      ${buttons(s.buttons, { first: "btn", rest: "btn btn--ghost" })}
    </div></section>`;
  },

  story(site, s, { id, tone }) {
    return html`<section class="section${tone()}" aria-labelledby="${id}"><div class="container split${s.layout === "image-right" ? " split--reverse" : ""}">
    ${hasImage(s) ? html`<div class="split-media reveal">${img(s.image.src, { alt: s.image.alt, sizes: "(max-width: 860px) 100vw, 50vw" })}</div>` : ""}
    <div>
      ${s.showDefinition ? html`<div class="definition"><span lang="hi">अमानत</span><span>noun · a trust</span></div>` : ""}
      ${s.title ? html`<blockquote class="quote" id="${id}">${s.title}</blockquote>` : ""}
      ${formatPlainText(s.text)}
      ${linkArrow(s.buttons)}
    </div></div></section>`;
  },

  testimonials(site, s, { id }) {
    if (!s.items?.length) return "";
    return html`<section class="section section--cream" aria-labelledby="${id}"><div class="container">
    <div class="section-head">${head({ ...s, text: "" }, { id })}</div>
    <div class="testimonials testimonials--${s.layout}">${s.items.filter((q) => q.quote).map((q) => html`
      <figure class="testimonial"><blockquote>${q.quote}</blockquote>${q.name ? html`<figcaption><b>${q.name}</b>${q.detail ? html`<span>${q.detail}</span>` : ""}</figcaption>` : ""}</figure>`)}
    </div></div></section>`;
  },

  newsletter(site, s, { id }) {
    return html`<section class="section section--${s.layout === "band" ? "ink" : "cream"}" aria-labelledby="${id}"><div class="container newsletter">
    <div>${s.eyebrow ? html`<p class="eyebrow">${s.eyebrow}</p>` : ""}<h2 id="${id}">${s.title || "Letters from Amaanat"}</h2>${s.text ? html`<p>${s.text}</p>` : ""}</div>
    <form class="newsletter-form" novalidate>
      <label class="visually-hidden" for="${id}-email">Email</label>
      <input id="${id}-email" name="email" type="email" autocomplete="email" placeholder="Your email" required maxlength="254">
      <button class="btn" type="submit">${s.buttonLabel || "Sign up"}</button>
      <p class="newsletter-note">We'll only use your email to write to you about Amaanat.</p>
      <p class="newsletter-msg" role="status" aria-live="polite"></p>
    </form></div></section>`;
  },

  text(site, s, { id }) {
    const cls = s.layout === "letter" ? "letter" : s.layout === "center" ? "prose prose--center" : "prose";
    return html`<section class="section" aria-labelledby="${id}"><div class="container ${cls}">
    ${s.eyebrow ? html`<p class="eyebrow">${s.eyebrow}</p>` : ""}
    ${s.title ? html`<h2 id="${id}">${s.title}</h2>` : ""}
    ${formatPlainText(s.text)}
    ${s.signature ? html`<p class="letter-sign">${s.signature}</p>` : ""}
    ${buttons(s.buttons)}
  </div></section>`;
  },

  highlights(site, s, { id }) {
    if (!s.items?.length && !s.title) return "";
    return html`<section class="section${s.layout === "band" ? " section--ink" : ""}" aria-labelledby="${id}"><div class="container">
    <div class="section-head"><div>${s.eyebrow ? html`<p class="eyebrow">${s.eyebrow}</p>` : ""}${s.title ? html`<h2 id="${id}">${s.title}</h2>` : ""}
      ${s.text ? html`<p class="lede">${s.text}</p>` : ""}</div></div>
    ${s.items?.length ? html`<ol class="promise">${s.items.map((it) => html`<li><h3>${it.title}</h3><p>${it.text}</p></li>`)}</ol>` : ""}
  </div></section>`;
  },
};

// Returns { body, hasH1, firstImage }.
export function renderSections(site, sections, { productCard, allowH1 = true }) {
  const live = (sections || []).filter((s) => s.enabled !== false && RENDER[s.type]);
  let h1Used = !allowH1;
  let cream = false;
  const tone = () => { cream = !cream; return cream ? " section--cream" : ""; };
  const parts = live.map((s, i) => {
    const isH1 = !h1Used && s.type === "hero";
    if (isH1) h1Used = true;
    return RENDER[s.type](site, s, { h1: isH1, id: `s-${s.id || i}`, productCard, tone });
  });
  const firstImage = live.find((s) => s.image?.src)?.image.src || null;
  return { body: parts, hasH1: allowH1 && h1Used, firstImage };
}
