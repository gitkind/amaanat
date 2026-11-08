// LOCAL DEVELOPMENT ONLY: runs the store on a throwaway PGlite database in ./.local-db.
//
//   npm run dev:local                     # real catalogue, stock stays unconfirmed
//   npm run dev:local -- --test-fixtures  # ALSO sets placeholder stock (5 each) and ₹0 shipping
//                                          # in the LOCAL database so checkout can be exercised.
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

const app = createApp(deps);
http.createServer(app.handler).listen(config.port, () => {
  console.log(`  AMAANAT (local PGlite) → http://localhost:${config.port}   payments: ${razorpayMode(config.razorpay)}`);
});
