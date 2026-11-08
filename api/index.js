import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getApp } from "../lib/bootstrap.js";
import { razorpayMode } from "../lib/razorpay.js";

// Vercel entry point (also used by the local server below).
export default async function handler(req, res) {
  const app = await getApp();
  return app.handler(req, res);
}

const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url).replace(/\\/g, "/") === path.resolve(process.argv[1]).replace(/\\/g, "/");

if (isDirectRun) {
  const app = await getApp();
  const { config, db, auth } = app.deps;
  http.createServer(app.handler).listen(config.port, () => {
    console.log(`
  AMAANAT server  →  http://localhost:${config.port}

  Database : ${db ? db.kind : "not configured (read-only catalogue from data/products.json)"}
  Accounts : ${auth ? auth.kind : "not configured"}
  Payments : ${razorpayMode(config.razorpay)}${config.razorpay.webhookSecret ? " (webhook secret set)" : ""}
`);
  });
}
