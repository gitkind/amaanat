// Product image storage.
//  - supabase: Supabase Storage (public bucket), server-side upload with the service-role key.
//  - local:    files under public/uploads (development / tests only).
import crypto from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // under Vercel's 4.5 MB request limit
export const MAX_IMAGES_PER_PRODUCT = 10;

// Detect by magic bytes; the client's Content-Type is not trusted.
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", type: "image/jpeg" };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", type: "image/png" };
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return { ext: "webp", type: "image/webp" };
  return null;
}

export function newObjectPath(productId, ext) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(productId)) throw new Error("invalid product id");
  return `products/${productId}/${crypto.randomUUID()}.${ext}`;
}

export function newSiteAssetPath(ext) {
  return `site/${crypto.randomUUID()}.${ext}`;
}

export function createSupabaseStorage({ url, serviceRoleKey, bucket, fetchImpl = fetch }) {
  const base = url.replace(/\/+$/, "");
  const publicPrefix = `${base}/storage/v1/object/public/${bucket}/`;
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
  return {
    kind: "supabase",
    async put(objectPath, buffer, contentType) {
      const res = await fetchImpl(`${base}/storage/v1/object/${bucket}/${objectPath}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": contentType, "x-upsert": "false", "Cache-Control": "max-age=31536000" },
        body: buffer,
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`Storage upload failed (${res.status})`);
      return publicPrefix + objectPath;
    },
    owns: (publicUrl) => String(publicUrl).startsWith(publicPrefix),
    async remove(publicUrl) {
      if (!this.owns(publicUrl)) return false;
      const objectPath = publicUrl.slice(publicPrefix.length);
      const res = await fetchImpl(`${base}/storage/v1/object/${bucket}`, {
        method: "DELETE",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ prefixes: [objectPath] }),
        signal: AbortSignal.timeout(10000),
      });
      return res.ok;
    },
  };
}

export function createLocalStorage({ rootDir, urlPrefix = "/uploads/" }) {
  return {
    kind: "local",
    async put(objectPath, buffer) {
      const abs = path.join(rootDir, objectPath);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, buffer, { flag: "wx" });
      return urlPrefix + objectPath;
    },
    owns: (publicUrl) => /^(products|site)\//.test(String(publicUrl).slice(urlPrefix.length)) && String(publicUrl).startsWith(urlPrefix),
    async remove(publicUrl) {
      if (!this.owns(publicUrl)) return false;
      const rel = String(publicUrl).slice(urlPrefix.length);
      const abs = path.resolve(rootDir, rel);
      if (!abs.startsWith(path.resolve(rootDir) + path.sep)) return false;
      await unlink(abs).catch(() => {});
      return true;
    },
  };
}
