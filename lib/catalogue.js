import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { availability } from "./order.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function fromRow(row) {
  const images = Array.isArray(row.images) && row.images.length ? row.images : row.image_path ? [row.image_path] : [];
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    pricePaise: row.price_paise,
    image: row.image_path || images[0] || "",
    images,
    alt: row.alt_text,
    stockQuantity: row.stock_quantity,
    inventoryConfirmed: row.inventory_confirmed === true,
    active: row.active !== false,
    featured: row.featured === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toSettings(row) {
  if (!row) return null;
  return {
    shippingPaise: row.shipping_paise,
    shippingConfirmed: row.shipping_confirmed === true,
    taxConfirmed: row.tax_confirmed === true,
    taxRateBps: row.tax_rate_bps,
    whatsappE164: row.whatsapp_e164,
    contactEmail: row.contact_email,
    lowStockThreshold: row.low_stock_threshold,
  };
}

export async function readCatalogueFile() {
  const raw = await readFile(path.join(root, "data", "products.json"), "utf8");
  return JSON.parse(raw).products.map((p) => ({ ...p, images: p.images || (p.image ? [p.image] : []) }));
}

export async function readSettingsFile() {
  const raw = await readFile(path.join(root, "data", "settings.json"), "utf8");
  return JSON.parse(raw);
}

export function slugifyCategory(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// What the browser sees. Exact stock is not exposed beyond what the quantity
// selector needs (capped at the per-line maximum) and a low-stock hint.
export function publicProduct(product, { lowStockThreshold = 2 } = {}) {
  const a = availability(product);
  const stock = Number.isInteger(product.stockQuantity) ? product.stockQuantity : null;
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    description: product.description,
    category: product.category,
    categorySlug: slugifyCategory(product.category),
    pricePaise: product.pricePaise,
    image: product.image,
    images: product.images,
    alt: product.alt,
    featured: product.featured,
    createdAt: product.createdAt,
    availability: {
      code: a.code,
      label: a.code === "in" && stock !== null && stock <= lowStockThreshold ? `Only ${stock} left` : a.label,
      canBuy: a.canBuy,
      maxQuantity: a.canBuy ? Math.min(stock, 50) : 0,
    },
  };
}

const SORTS = {
  featured: (a, b) => Number(b.featured) - Number(a.featured) || String(a.createdAt).localeCompare(String(b.createdAt)),
  newest: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
  price_asc: (a, b) => a.pricePaise - b.pricePaise || a.name.localeCompare(b.name),
  price_desc: (a, b) => b.pricePaise - a.pricePaise || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
};

export function parseCatalogueQuery(searchParams) {
  const num = (k) => {
    const v = searchParams.get(k);
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  const sort = searchParams.get("sort");
  return {
    q: (searchParams.get("q") || "").trim().slice(0, 80),
    category: (searchParams.get("category") || "").trim().toLowerCase().slice(0, 60),
    sort: Object.hasOwn(SORTS, sort) ? sort : "featured",
    inStock: searchParams.get("inStock") === "1" || searchParams.get("inStock") === "true",
    featured: searchParams.get("featured") === "1" || searchParams.get("featured") === "true",
    minPrice: num("minPrice"),
    maxPrice: num("maxPrice"),
  };
}

export function queryCatalogue(products, query) {
  const terms = query.q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = products.filter((p) => {
    if (p.active === false) return false;
    if (query.category && slugifyCategory(p.category) !== query.category) return false;
    if (query.featured && !p.featured) return false;
    if (query.inStock && !availability(p).canBuy) return false;
    if (query.minPrice != null && p.pricePaise < query.minPrice) return false;
    if (query.maxPrice != null && p.pricePaise > query.maxPrice) return false;
    if (terms.length) {
      const hay = `${p.name} ${p.description || ""} ${p.category}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
  return out.sort(SORTS[query.sort] || SORTS.featured);
}

export function collections(products) {
  const map = new Map();
  for (const p of products) {
    if (p.active === false) continue;
    const slug = slugifyCategory(p.category);
    const entry = map.get(slug) || { slug, name: p.category, count: 0, image: p.image };
    entry.count += 1;
    map.set(slug, entry);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}
