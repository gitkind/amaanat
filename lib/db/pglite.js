// Local development + test adapter: real PostgreSQL (WASM) via PGlite.
// Applies the same migrations as Supabase on top of a minimal Supabase shim
// (roles, auth.users, auth.uid()). Never used in production.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toDbError } from "./errors.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MIGRATIONS_DIR = path.join(root, "database", "migrations");

const SUPABASE_SHIM = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function listMigrations() {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  return files.map((file) => ({ version: file.replace(/\.sql$/, ""), file: path.join(MIGRATIONS_DIR, file) }));
}

export async function createPgliteDb({ dataDir } = {}) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("PGlite is for local development and tests only");
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.exec(SUPABASE_SHIM);

  const applied = new Set((await pg.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
  for (const m of await listMigrations()) {
    if (applied.has(m.version)) continue;
    await pg.exec(await readFile(m.file, "utf8"));
    await pg.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING", [m.version]);
  }

  async function rpc(name, args = {}) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Invalid function name: ${name}`);
    const keys = Object.keys(args);
    for (const k of keys) if (!/^[a-z_][a-z0-9_]*$/.test(k)) throw new Error(`Invalid arg: ${k}`);
    const params = keys.map((k) => {
      const v = args[k];
      return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
    });
    const sql = `SELECT public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) AS result`;
    try {
      const { rows } = await pg.query(sql, params);
      return rows[0]?.result ?? null;
    } catch (error) {
      throw toDbError(error, 400);
    }
  }

  return {
    kind: "pglite",
    rpc,
    pg, // exposed for tests and the local auth provider
    close: () => pg.close(),
  };
}
