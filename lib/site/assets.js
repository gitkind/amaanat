import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { html } from "./html.js";

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

const versions = new Map();
// Content-hash query string so CSS/JS can be cached long-term and still update on deploy.
export function asset(urlPath) {
  // Cache hashes in production; recompute in development so edits show up immediately.
  if (process.env.NODE_ENV !== "production") versions.delete(urlPath);
  if (!versions.has(urlPath)) {
    let v = "0";
    try {
      v = crypto.createHash("sha256").update(readFileSync(path.join(PUBLIC, urlPath))).digest("hex").slice(0, 10);
    } catch {
      /* missing file: no version */
    }
    versions.set(urlPath, v);
  }
  return `${urlPath}?v=${versions.get(urlPath)}`;
}

let manifest;
function imageManifest() {
  if (!manifest) {
    try {
      manifest = JSON.parse(readFileSync(path.join(PUBLIC, "assets", "opt", "manifest.json"), "utf8"));
    } catch {
      manifest = {};
    }
  }
  return manifest;
}

export function publicUrl(p) {
  if (!p) return "/assets/post.jpg";
  return /^https?:\/\//.test(p) || p.startsWith("/") ? p : `/${p}`;
}

// Responsive <img>. Uses pre-generated WebP variants for repository photos;
// uploaded images (Supabase Storage) are served as uploaded.
export function img(src, { alt = "", sizes = "100vw", eager = false, className = "" } = {}) {
  const key = String(src || "").replace(/^\//, "");
  const m = imageManifest()[key];
  const loading = eager ? "eager" : "lazy";
  const priority = eager ? "high" : "auto";
  if (m?.variants?.length) {
    const largest = m.variants[m.variants.length - 1];
    const srcset = m.variants.map((v) => `${v.src} ${v.w}w`).join(", ");
    return html`<img src="${largest.src}" srcset="${srcset}" sizes="${sizes}" width="${m.width}" height="${m.height}" alt="${alt}" loading="${loading}" fetchpriority="${priority}" decoding="async" class="${className}">`;
  }
  return html`<img src="${publicUrl(src)}" alt="${alt}" loading="${loading}" fetchpriority="${priority}" decoding="async" class="${className}">`;
}

// Absolute URL of a mid-size image for Open Graph / structured data.
export function ogImagePath(src) {
  const key = String(src || "").replace(/^\//, "");
  const m = imageManifest()[key];
  if (m?.variants?.length) return m.variants[m.variants.length - 1].src;
  return publicUrl(src);
}
