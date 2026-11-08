// Builds the app dependencies from environment configuration.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { createLocalAuth } from "./auth/local.js";
import { createSupabaseAuth } from "./auth/supabase.js";
import { loadConfig } from "./config.js";
import { createPostgrestDb } from "./db/postgrest.js";
import { createRazorpayClient, paymentsEnabled } from "./razorpay.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function buildDeps(config = loadConfig()) {
  let db = null;
  let auth = null;
  if (config.dbDriver === "supabase") {
    if (!config.supabaseReady) throw new Error("DATABASE_DRIVER=supabase needs SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY");
    db = createPostgrestDb({ url: config.supabase.url, serviceRoleKey: config.supabase.serviceRoleKey });
    auth = createSupabaseAuth({ url: config.supabase.url, anonKey: config.supabase.anonKey });
  } else if (config.dbDriver === "pglite") {
    if (config.isProduction) throw new Error("DATABASE_DRIVER=pglite is not allowed in production");
    const { createPgliteDb } = await import("./db/pglite.js");
    db = await createPgliteDb({ dataDir: path.resolve(ROOT, config.pgliteDataDir) });
    auth = createLocalAuth({ pg: db.pg, secret: config.localAuthSecret });
  }
  const razorpay = paymentsEnabled(config.razorpay)
    ? createRazorpayClient({ keyId: config.razorpay.keyId, keySecret: config.razorpay.keySecret })
    : null;
  return { config, db, auth, razorpay };
}

let appPromise;
export function getApp() {
  appPromise ||= buildDeps().then((deps) => createApp(deps));
  return appPromise;
}
