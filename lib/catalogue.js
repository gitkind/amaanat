import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function fromRow(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    pricePaise: row.price_paise,
    image: row.image_path,
    alt: row.alt_text,
    stockQuantity: row.stock_quantity,
    inventoryConfirmed: row.inventory_confirmed,
    active: row.active,
    featured: row.featured,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toSettings(row) {
  if (!row) return null;
  return {
    shippingPaise: row.shipping_paise,
    shippingConfirmed: row.shipping_confirmed,
    taxConfirmed: row.tax_confirmed,
    taxRateBps: row.tax_rate_bps,
    whatsappE164: row.whatsapp_e164,
    contactEmail: row.contact_email,
    lowStockThreshold: row.low_stock_threshold,
  };
}

export async function readCatalogueFile() {
  const raw = await readFile(path.join(root, "data", "products.json"), "utf8");
  return JSON.parse(raw).products;
}

export async function readSettingsFile() {
  const raw = await readFile(path.join(root, "data", "settings.json"), "utf8");
  return JSON.parse(raw);
}
