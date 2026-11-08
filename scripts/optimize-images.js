// Generates responsive WebP variants of the repository photos (originals are kept untouched).
//   npm run images
// Output: public/assets/opt/<name>-<width>.webp + public/assets/opt/manifest.json
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const OUT = path.join(PUBLIC, "assets", "opt");
const WIDTHS = [400, 720, 1080];

const sources = [
  ...(await readdir(path.join(PUBLIC, "assets", "products"))).filter((f) => /\.(jpe?g|png)$/i.test(f)).map((f) => `assets/products/${f}`),
  "assets/post.jpg",
];

await mkdir(OUT, { recursive: true });
const manifest = {};
for (const rel of sources) {
  const input = path.join(PUBLIC, rel);
  const meta = await sharp(input).metadata();
  const base = path.basename(rel).replace(/\.[^.]+$/, "");
  const variants = [];
  for (const w of WIDTHS.filter((x) => x < meta.width).concat(meta.width <= 1080 ? [meta.width] : [])) {
    const file = `${base}-${w}.webp`;
    const info = await sharp(input).rotate().resize({ width: w }).webp({ quality: 78, effort: 5 }).toFile(path.join(OUT, file));
    variants.push({ w, src: `/assets/opt/${file}`, bytes: info.size });
  }
  manifest[rel] = { width: meta.width, height: meta.height, variants };
  console.log(rel, variants.map((v) => `${v.w}w=${Math.round(v.bytes / 1024)}KB`).join(" "));
}
await writeFile(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
