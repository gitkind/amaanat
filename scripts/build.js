// Production build check (no bundler needed: the site is plain ES modules + static files).
// Fails the build if:
//   - a repository product photo has no optimized WebP variants,
//   - any storefront page fails to render or lacks title / description / canonical,
//   - anything under public/ looks like a secret.
//   npm run build
import http from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../lib/app.js";
import { loadConfig } from "../lib/config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const failures = [];
const fail = (msg) => failures.push(msg);

// 1. Optimized images
const manifest = JSON.parse(await readFile(path.join(PUBLIC, "assets/opt/manifest.json"), "utf8").catch(() => "{}"));
for (const f of await readdir(path.join(PUBLIC, "assets/products"))) {
  if (!/\.(jpe?g|png)$/i.test(f)) continue;
  const key = `assets/products/${f}`;
  if (!manifest[key]?.variants?.length) fail(`No optimized images for ${key} — run: npm run images`);
  for (const v of manifest[key]?.variants || []) await stat(path.join(PUBLIC, v.src)).catch(() => fail(`Missing ${v.src}`));
}

// 2. Every page renders with SEO basics (uses the bundled catalogue; no database needed)
const app = createApp({ config: loadConfig({ NODE_ENV: "test", APP_BASE_URL: "https://example.invalid" }), db: null, auth: null, razorpay: null, log: { error() {}, warn() {} } });
const server = http.createServer(app.handler).listen(0);
await new Promise((r) => server.on("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
const catalogue = JSON.parse(await readFile(path.join(ROOT, "data/products.json"), "utf8")).products;
const pages = ["/", "/shop", "/about", "/contact", "/track", "/cart", "/checkout", "/account", "/wishlist", "/order", "/faq", "/shipping", "/returns", "/privacy", "/terms",
  ...[...new Set(catalogue.map((p) => p.category.toLowerCase()))].map((c) => `/collections/${c}`),
  ...catalogue.map((p) => `/products/${p.slug}`)];
const titles = new Map();
for (const p of pages) {
  const res = await fetch(base + p);
  const body = await res.text();
  if (res.status !== 200) { fail(`${p} returned ${res.status}`); continue; }
  const title = body.match(/<title>([^<]+)<\/title>/)?.[1];
  if (!title) fail(`${p} has no <title>`);
  if (!/<meta name="description" content="[^"]{20,}/.test(body)) fail(`${p} has no meaningful meta description`);
  if (!/<link rel="canonical" href="https:\/\/example\.invalid/.test(body)) fail(`${p} has no canonical URL`);
  if ((body.match(/<h1[\s>]/g) || []).length !== 1) fail(`${p} should have exactly one <h1>`);
  if (titles.has(title)) fail(`${p} duplicates the title of ${titles.get(title)}`);
  titles.set(title, p);
}
for (const p of ["/sitemap.xml", "/robots.txt"]) {
  const res = await fetch(base + p);
  if (res.status !== 200) fail(`${p} returned ${res.status}`);
}
server.close();

// 3. No secrets shipped to the browser
const SECRET_PATTERNS = [/rzp_live_[A-Za-z0-9]+/, /service_role/i, /SUPABASE_SERVICE_ROLE_KEY\s*=/, /RAZORPAY_KEY_SECRET\s*=/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
async function scan(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "uploads") await scan(full); continue; }
    if (!/\.(js|html|css|json|txt|svg)$/.test(entry.name)) continue;
    const text = await readFile(full, "utf8");
    for (const re of SECRET_PATTERNS) if (re.test(text)) fail(`Possible secret in ${path.relative(ROOT, full)} (${re})`);
  }
}
await scan(PUBLIC);

if (failures.length) {
  console.error(`Build check failed:\n - ${failures.join("\n - ")}`);
  process.exit(1);
}
console.log(`Build check passed: ${pages.length} pages rendered with title, description and canonical; images optimized; no secrets in public/.`);
