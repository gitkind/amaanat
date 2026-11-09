// Website content (CMS): the single source of truth for what the owner can edit.
// The admin editor is generated from SCHEMA (served by /api/admin/cms/schema) and
// every save is re-validated here, so the browser never decides what is stored.
// Content is plain data (no HTML); the storefront escapes everything it renders.
import crypto from "node:crypto";
import { HttpError } from "./http.js";

export const DOC_KEYS = ["home", "about", "founder", "site"];
export const MAX_SECTIONS = 30;

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function clean(v, max) {
  return String(v ?? "").replace(CONTROL, "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

// Links: site paths (/shop), anchors, https://, mailto:, tel:. Never javascript:, data:, //host.
export function cleanHref(v) {
  const s = clean(v, 500);
  if (!s) return "";
  if (/^\/(?!\/)[^\s<>"'\\]*$/.test(s) || /^#[A-Za-z0-9_-]+$/.test(s)) return s;
  if (/^mailto:[^\s<>"'@]+@[^\s<>"']+$/i.test(s)) return s;
  if (/^tel:\+?[0-9 ()-]{5,20}$/i.test(s)) return s.replace(/\s/g, "");
  try {
    const u = new URL(s);
    if (u.protocol === "https:") return u.toString();
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "invalid_input", `“${s.slice(0, 60)}” is not a valid link. Use a page on this site (e.g. /shop) or a full https:// address.`);
}

// Images: bundled site photos, local uploads (dev) or https (Supabase Storage).
export function cleanImage(v) {
  const s = clean(v, 500);
  if (!s) return "";
  if (/^\/(assets|uploads)\/[A-Za-z0-9/_\-.]+\.(jpe?g|png|webp)$/i.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.protocol === "https:" && /\.(jpe?g|png|webp)$/i.test(u.pathname)) return u.toString();
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "invalid_input", "An image could not be used. Upload a JPEG, PNG or WebP image.");
}

// ---------------------------------------------------------------
// Field kinds: text, textarea, image (+ alt), link, buttons, select,
// toggle, items (repeatable group), products, collections.
// ---------------------------------------------------------------
const f = {
  eyebrow: { key: "eyebrow", label: "Small heading above the title", kind: "text", max: 60, hint: "Optional, e.g. “New collection”" },
  title: { key: "title", label: "Heading", kind: "text", max: 140 },
  text: { key: "text", label: "Text", kind: "textarea", max: 2000, hint: "Leave a blank line between paragraphs." },
  image: { key: "image", label: "Image", kind: "image" },
  buttons: (max = 2) => ({ key: "buttons", label: max === 1 ? "Button" : "Buttons", kind: "buttons", max }),
};

const BUTTON_LAYOUTS = [["image-right", "Image on the right"], ["image-left", "Image on the left"]];

export const SECTION_TYPES = {
  hero: {
    label: "Hero banner", description: "Large opening banner with heading, text, image and buttons.",
    layouts: [["split-right", "Text left, image right"], ["split-left", "Image left, text right"], ["full", "Full-width image with text over it"]],
    fields: [f.eyebrow, { ...f.title, hint: "Leave empty to show the Amaanat wordmark." }, { key: "subtitle", label: "Tagline", kind: "text", max: 160 }, { ...f.text, max: 600 }, f.image, f.buttons(2)],
  },
  imageText: {
    label: "Image with text", description: "A photo beside a heading, text and a button.",
    layouts: BUTTON_LAYOUTS,
    fields: [f.eyebrow, f.title, f.text, f.image, f.buttons(1)],
  },
  featuredProducts: {
    label: "Featured products", description: "A row of products picked automatically or by hand.",
    layouts: [["grid-4", "4 per row"], ["grid-3", "3 per row"]],
    fields: [f.eyebrow, f.title, { ...f.text, max: 400 },
      { key: "source", label: "Which products", kind: "select", options: [["featured", "Products marked “featured”"], ["bestsellers", "Best sellers (from paid orders)"], ["newest", "Newest"], ["collection", "One collection"], ["manual", "Choose by hand"]] },
      { key: "collection", label: "Collection", kind: "collections", single: true, showIf: ["source", "collection"] },
      { key: "productIds", label: "Products", kind: "products", max: 12, showIf: ["source", "manual"] },
      { key: "limit", label: "How many to show", kind: "select", options: [["4", "4"], ["8", "8"], ["12", "12"]] },
      f.buttons(1)],
  },
  categories: {
    label: "Product categories", description: "Tiles linking to your collections.",
    layouts: [["tiles", "Photo tiles"], ["chips", "Simple links"]],
    fields: [f.eyebrow, f.title, { key: "collections", label: "Collections to show", kind: "collections", hint: "Leave all unticked to show every collection." }, f.buttons(1)],
  },
  promo: {
    label: "Promotional banner", description: "An eye-catching banner for an offer, launch or announcement.",
    layouts: [["image", "Photo background"], ["gold", "Gold band"], ["cream", "Cream band"]],
    fields: [f.eyebrow, f.title, { ...f.text, max: 500 }, f.image, f.buttons(2)],
  },
  story: {
    label: "Brand story", description: "Your story with a photo and the अमानत definition.",
    layouts: BUTTON_LAYOUTS,
    fields: [{ key: "showDefinition", label: "Show “अमानत — noun · a trust”", kind: "toggle" }, { ...f.title, label: "Quote / heading" }, f.text, f.image, f.buttons(1)],
  },
  testimonials: {
    label: "Testimonials", description: "Words from real customers. Only add genuine quotes you have permission to use.",
    layouts: [["grid", "Cards in a grid"], ["single", "One large quote at a time"]],
    fields: [f.eyebrow, f.title,
      { key: "items", label: "Quotes", kind: "items", max: 12, itemLabel: "quote", fields: [
        { key: "quote", label: "Quote", kind: "textarea", max: 600 },
        { key: "name", label: "Customer name", kind: "text", max: 80 },
        { key: "detail", label: "Detail (optional)", kind: "text", max: 80, hint: "e.g. city or the piece they bought" },
      ] }],
  },
  newsletter: {
    label: "Newsletter sign-up", description: "Invite visitors to join your mailing list.",
    layouts: [["cream", "Cream background"], ["band", "Warm band"]],
    fields: [f.eyebrow, f.title, { ...f.text, max: 400 }, { key: "buttonLabel", label: "Button text", kind: "text", max: 30 }],
  },
  text: {
    label: "Custom text", description: "A heading and paragraphs — for notes, announcements or anything else.",
    layouts: [["left", "Aligned left"], ["center", "Centred"], ["letter", "Letter style (italic, centred)"]],
    fields: [f.eyebrow, f.title, { ...f.text, max: 6000, hint: "Blank line = new paragraph. Start a line with “## ” for a sub-heading or “- ” for a list." }, { key: "signature", label: "Sign-off (optional)", kind: "text", max: 80 }, f.buttons(2)],
  },
  highlights: {
    label: "Highlights", description: "Up to six short points, e.g. what makes your jewellery special.",
    layouts: [["band", "Warm band"], ["plain", "Plain background"]],
    fields: [f.eyebrow, f.title, { ...f.text, max: 400 },
      { key: "items", label: "Points", kind: "items", max: 6, itemLabel: "point", fields: [
        { key: "title", label: "Title", kind: "text", max: 60 },
        { key: "text", label: "Text", kind: "textarea", max: 300 },
      ] }],
  },
};

export const FOUNDER_FIELDS = [
  { key: "visible", label: "Show the Meet the Founder page on the website", kind: "toggle", hint: "While off, the page says the story is coming soon and isn't linked or indexed." },
  { key: "name", label: "Founder name", kind: "text", max: 80, placeholder: "Founder's full name" },
  { key: "designation", label: "Designation", kind: "text", max: 80, placeholder: "e.g. Founder & Creative Director" },
  { key: "image", label: "Founder photograph", kind: "image" },
  { key: "bio", label: "Biography", kind: "textarea", max: 4000, placeholder: "A short introduction to the founder." },
  { key: "story", label: "The story behind Amaanat", kind: "textarea", max: 6000, placeholder: "How and why Amaanat began." },
  { key: "inspiration", label: "Brand inspiration", kind: "textarea", max: 3000, placeholder: "What inspires the designs." },
  { key: "mission", label: "Mission", kind: "textarea", max: 1500 },
  { key: "vision", label: "Vision", kind: "textarea", max: 1500 },
  { key: "message", label: "Message from the founder (optional)", kind: "textarea", max: 3000 },
  { key: "signature", label: "Sign-off (optional)", kind: "text", max: 80, placeholder: "e.g. With love, —" },
];

export const SITE_FIELDS = [
  { key: "tagline", label: "Footer tagline", kind: "text", max: 120 },
  { key: "newsletterTitle", label: "Footer newsletter heading", kind: "text", max: 60 },
  { key: "newsletterNote", label: "Footer newsletter note", kind: "text", max: 240 },
  { key: "navLinks", label: "Extra links in the main menu", kind: "items", max: 4, itemLabel: "link", fields: [
    { key: "label", label: "Text", kind: "text", max: 30 }, { key: "href", label: "Link", kind: "link" }] },
  { key: "footerLinks", label: "Extra links in the footer", kind: "items", max: 8, itemLabel: "link", fields: [
    { key: "label", label: "Text", kind: "text", max: 40 }, { key: "href", label: "Link", kind: "link" }] },
  { key: "copyright", label: "Footer small print", kind: "text", max: 120, hint: "Shown after © year. Leave empty for the store name." },
];

const SECTION_DOCS = new Set(["home", "about"]);

// ---------------------------------------------------------------
// Validation
// ---------------------------------------------------------------
function cleanField(field, value) {
  switch (field.kind) {
    case "text": return clean(value, field.max || 200);
    case "textarea": return clean(value, field.max || 2000);
    case "image": {
      const v = value && typeof value === "object" ? value : { src: value };
      return { src: cleanImage(v.src), alt: clean(v.alt, 200) };
    }
    case "link": return cleanHref(value);
    case "toggle": return value === true;
    case "select": {
      const allowed = field.options.map(([v]) => v);
      return allowed.includes(String(value)) ? String(value) : allowed[0];
    }
    case "buttons": {
      const list = Array.isArray(value) ? value.slice(0, field.max) : [];
      return list.map((b) => ({ label: clean(b?.label, 40), href: cleanHref(b?.href) })).filter((b) => b.label && b.href);
    }
    case "products": {
      const list = Array.isArray(value) ? value : [];
      return [...new Set(list.map(String).filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id)))].slice(0, field.max || 12);
    }
    case "collections": {
      const list = (field.single ? [value] : Array.isArray(value) ? value : []).map(String).filter((s) => /^[a-z0-9-]{1,60}$/.test(s));
      return field.single ? list[0] || "" : [...new Set(list)].slice(0, 20);
    }
    case "items": {
      const list = Array.isArray(value) ? value.slice(0, field.max) : [];
      return list
        .map((item) => Object.fromEntries(field.fields.map((sub) => [sub.key, cleanField(sub, item?.[sub.key])])))
        .filter((item) => Object.values(item).some((v) => v && (typeof v !== "object" || v.src)));
    }
    default: return null;
  }
}

function cleanFields(fields, input) {
  const src = input && typeof input === "object" ? input : {};
  return Object.fromEntries(fields.map((field) => [field.key, cleanField(field, src[field.key])]));
}

const newId = () => crypto.randomBytes(6).toString("hex");

export function cleanSection(input) {
  const type = String(input?.type || "");
  const def = SECTION_TYPES[type];
  if (!def) throw new HttpError(400, "invalid_input", "Unknown section type.");
  const layouts = def.layouts.map(([v]) => v);
  return {
    id: /^[a-z0-9]{6,16}$/.test(String(input.id || "")) ? input.id : newId(),
    type,
    enabled: input.enabled !== false,
    layout: layouts.includes(input.layout) ? input.layout : layouts[0],
    ...cleanFields(def.fields, input),
  };
}

export function cleanDocument(key, input) {
  if (!DOC_KEYS.includes(key)) throw new HttpError(404, "not_found", "Unknown content.");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "invalid_input", "Content is invalid.");
  if (SECTION_DOCS.has(key)) {
    const sections = Array.isArray(input.sections) ? input.sections : [];
    if (sections.length > MAX_SECTIONS) throw new HttpError(400, "invalid_input", `A page can have up to ${MAX_SECTIONS} sections.`);
    const out = sections.map(cleanSection);
    const seen = new Set();
    for (const s of out) { if (seen.has(s.id)) s.id = newId(); seen.add(s.id); }
    return { sections: out };
  }
  return cleanFields(key === "founder" ? FOUNDER_FIELDS : SITE_FIELDS, input);
}

// What the admin editor needs to build its forms.
export function schema() {
  return {
    docs: {
      home: { label: "Homepage", kind: "sections", path: "/" },
      about: { label: "About & brand story", kind: "sections", path: "/about" },
      founder: { label: "Meet the Founder", kind: "form", path: "/meet-the-founder", fields: FOUNDER_FIELDS },
      site: { label: "Menu & footer", kind: "form", path: "/", fields: SITE_FIELDS },
    },
    sectionTypes: Object.fromEntries(Object.entries(SECTION_TYPES).map(([type, d]) => [type, { label: d.label, description: d.description, layouts: d.layouts, fields: d.fields }])),
    maxSections: MAX_SECTIONS,
  };
}

// ---------------------------------------------------------------
// Defaults: reproduce the storefront exactly as it was before the CMS,
// using the owner's original copy (and any older homepage settings).
// ---------------------------------------------------------------
export function defaultDocument(key, { homepage = {}, promise = [] } = {}) {
  const im = (src, alt) => {
    try { return { src: cleanImage(src) || "/assets/post.jpg", alt }; } catch { return { src: "/assets/post.jpg", alt }; }
  };
  const h = homepage;
  const highlights = { type: "highlights", layout: "band", eyebrow: "Worn, not stored", title: "Jewellery you can live in.",
    text: "Amaanat is here for the pieces that stay on — through workdays, washbasins, and the long stretch of ordinary hours.",
    items: promise.map(([title, text]) => ({ title, text })) };
  if (key === "home") {
    return { sections: [
      { type: "hero", layout: "split-right", eyebrow: h.heroEyebrow, title: h.heroTitle || "", subtitle: h.heroSubtitle, text: h.heroText,
        image: im(h.heroImage, "Gold-tone Amaanat jewellery resting on a cream plate in warm daylight"),
        buttons: [{ label: "Shop the collection", href: "/shop" }, { label: "Our story", href: "/about" }] },
      { type: "categories", layout: "tiles", eyebrow: "Collections", title: "Find your piece", collections: [], buttons: [{ label: "Shop all", href: "/shop" }] },
      { type: "featuredProducts", layout: "grid-4", eyebrow: "Most loved", title: "Best sellers", text: "Ranked by pieces in paid orders.", source: "bestsellers", limit: "4", buttons: [] },
      { type: "featuredProducts", layout: "grid-4", eyebrow: "The edit", title: "Pieces that hold up", source: "featured", limit: "8", buttons: [{ label: "View all", href: "/shop" }] },
      { type: "story", layout: "image-left", showDefinition: true, title: h.storyTitle, text: h.storyText,
        image: im("/assets/post.jpg", "Amaanat pieces arranged on a cream plate in afternoon light"), buttons: [{ label: "Read our story", href: "/about" }] },
      { type: "featuredProducts", layout: "grid-4", eyebrow: "Just in", title: "New arrivals", source: "newest", limit: "4", buttons: [{ label: "See what's new", href: "/shop?sort=newest" }] },
      highlights,
    ].map((s, i) => ({ ...cleanSection({ ...s, id: `default${i}` }) })) };
  }
  if (key === "about") {
    return { sections: [
      { type: "story", layout: "image-left", showDefinition: true, title: h.storyTitle, text: h.storyText,
        image: im("/assets/post.jpg", "Gold rings, a clover chain and a beaded bracelet on a cream plate"), buttons: [] },
      highlights,
      { type: "text", layout: "letter", eyebrow: "A note from the beginning",
        text: "Thank you for being here at the start of this journey. I wanted something that felt like a promise. That is still the whole of it — pieces entrusted to you, and to the days you will wear them.",
        signature: "Amaanat · 2026", buttons: [{ label: "Shop the collection", href: "/shop" }] },
    ].map((s, i) => cleanSection({ ...s, id: `about${i}` })) };
  }
  if (key === "founder") return cleanFields(FOUNDER_FIELDS, {});
  return cleanFields(SITE_FIELDS, {});
}
