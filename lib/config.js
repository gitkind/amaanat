// Central environment reading. Secrets stay on the server; nothing here is
// ever serialised to the browser except the explicitly public fields used by
// /api/settings and the Razorpay key id (which Razorpay designs to be public).

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env = process.env) {
  const supabase = {
    url: env.SUPABASE_URL || "",
    anonKey: env.SUPABASE_ANON_KEY || "",
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || "",
  };
  const supabaseReady = Boolean(supabase.url && supabase.anonKey && supabase.serviceRoleKey);
  const nodeEnv = env.NODE_ENV || "development";

  let dbDriver = (env.DATABASE_DRIVER || "").toLowerCase();
  if (!dbDriver) dbDriver = supabaseReady ? "supabase" : "none";

  return {
    nodeEnv,
    isProduction: nodeEnv === "production",
    port: int(env.PORT, 3000),
    appBaseUrl: (env.APP_BASE_URL || "").replace(/\/+$/, ""),
    corsOrigin: env.CORS_ORIGIN || "",
    trustProxy: env.TRUST_PROXY === "true" || Boolean(env.VERCEL),
    supabase,
    supabaseReady,
    dbDriver, // "supabase" | "pglite" | "none"
    pgliteDataDir: env.PGLITE_DATA_DIR || ".local-db",
    localAuthSecret: env.LOCAL_AUTH_SECRET || "",
    razorpay: {
      keyId: env.RAZORPAY_KEY_ID || "",
      keySecret: env.RAZORPAY_KEY_SECRET || "",
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || "",
      allowLive: env.RAZORPAY_ALLOW_LIVE === "true",
    },
    storeName: env.STORE_NAME || "Amaanat",
    reservationMinutes: Math.min(120, Math.max(5, int(env.RESERVATION_MINUTES, 30))),
    cronSecret: env.CRON_SECRET || "",
  };
}
