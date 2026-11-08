// LOCAL DEVELOPMENT ONLY: runs the store on a throwaway PGlite database in ./.local-db.
//
//   npm run dev:local                     # real catalogue, stock stays unconfirmed
//   npm run dev:local -- --test-fixtures  # ALSO sets placeholder stock (5 each) and ₹0 shipping
//                                          # in the LOCAL database so checkout can be exercised.
//   npm run dev:local -- --make-admin you@example.com [--role manager]
//                                          # grants admin to an account you already registered
//                                          # on /account.html (LOCAL database only; no default passwords).
//
// Fixture values are NOT business data. They never touch Supabase.
import http from "node:http";
import { createApp } from "../lib/app.js";
import { buildDeps } from "../lib/bootstrap.js";
import { loadConfig } from "../lib/config.js";
import { razorpayMode } from "../lib/razorpay.js";

if (process.env.NODE_ENV === "production") throw new Error("dev-local is not for production");
const config = loadConfig({ ...process.env, DATABASE_DRIVER: "pglite" });
const deps = await buildDeps(config);

if (process.argv.includes("--test-fixtures")) {
  const ids = (await deps.db.rpc("api_list_products", { p_include_inactive: false })).map((p) => p.id);
  for (const id of ids) {
    await deps.db.rpc("set_product_stock", { p_product_id: id, p_quantity: 5, p_note: "LOCAL TEST FIXTURE — not real stock" });
  }
  await deps.db.pg.query("UPDATE site_settings SET shipping_paise = 0, shipping_confirmed = true WHERE id = 1");
  console.log("  ⚠ Local test fixtures applied: stock=5 per product, shipping=₹0 (local DB only)");
}

const adminIdx = process.argv.indexOf("--make-admin");
if (adminIdx > -1) {
  const email = String(process.argv[adminIdx + 1] || "").toLowerCase();
  const role = process.argv.includes("--role") ? process.argv[process.argv.indexOf("--role") + 1] : "owner";
  const { rows } = await deps.db.pg.query("SELECT id FROM auth.users WHERE email = $1", [email]);
  if (!rows[0]) {
    console.error(`  ✗ No local account for ${email}. Register it at /account.html first, then rerun.`);
  } else {
    await deps.db.pg.query("INSERT INTO admin_users (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = $2", [rows[0].id, role]);
    console.log(`  ✓ ${email} is now a local ${role}. Sign in at /admin/`);
  }
}

const app = createApp(deps);
http.createServer(app.handler).listen(config.port, () => {
  console.log(`  AMAANAT (local PGlite) → http://localhost:${config.port}   payments: ${razorpayMode(config.razorpay)}`);
});
