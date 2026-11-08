import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  handleHealth,
  handleProducts,
  handleSettings,
  handleCheckout,
  handleVerify,
  handleCancel,
  handleOrderStatus,
  handleWebhook,
  handleAdminLogin,
  handleAdminOverview,
  handleAdminProducts,
  handleAdminProduct,
  handleAdminStock,
  handleAdminMovements,
  handleAdminOrders,
  handleAdminOrder,
  handleAdminSettings,
} from "../lib/server.js";

import { databaseConfigured } from "../lib/supabase.js";
import { paymentsConfigured, razorpayMode } from "../lib/razorpay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

const routes = {
  "GET /api/health": handleHealth,
  "GET /api/products": handleProducts,
  "GET /api/settings": handleSettings,
  "POST /api/checkout": handleCheckout,
  "POST /api/verify": handleVerify,
  "POST /api/cancel": handleCancel,
  "GET /api/order-status": handleOrderStatus,
  "POST /api/webhook": handleWebhook,
  "POST /api/admin/login": handleAdminLogin,
  "GET /api/admin/overview": handleAdminOverview,
  "GET /api/admin/products": handleAdminProducts,
  "POST /api/admin/products": handleAdminProducts,
  "GET /api/admin/product": handleAdminProduct,
  "PATCH /api/admin/product": handleAdminProduct,
  "DELETE /api/admin/product": handleAdminProduct,
  "POST /api/admin/stock": handleAdminStock,
  "GET /api/admin/movements": handleAdminMovements,
  "GET /api/admin/orders": handleAdminOrders,
  "GET /api/admin/order": handleAdminOrder,
  "PATCH /api/admin/order": handleAdminOrder,
  "GET /api/admin/settings": handleAdminSettings,
  "PATCH /api/admin/settings": handleAdminSettings,
};

function setCors(res) {
  const origin = process.env.CORS_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://local");
  let filePath = decodeURIComponent(url.pathname);
  if (filePath === "/") filePath = "/index.html";

  const safePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const absPath = path.join(ROOT, safePath);

  if (!absPath.startsWith(ROOT)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    res.end("Not found");
    return;
  }

  if (stat.isDirectory()) {
    const indexPath = path.join(absPath, "index.html");
    try {
      fs.statSync(indexPath);
      serveFile(res, indexPath);
    } catch {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain");
      res.end("Not found");
    }
    return;
  }

  serveFile(res, absPath);
}

function serveFile(res, absPath) {
  const ext = path.extname(absPath).toLowerCase();
  const contentType = MIME[ext] || "application/octet-stream";
  res.setHeader("Content-Type", contentType);

  if (ext === ".html") {
    res.setHeader("Cache-Control", "no-cache");
  } else if ([".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".ico"].includes(ext)) {
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  } else {
    res.setHeader("Cache-Control", "public, max-age=3600");
  }

  const stream = fs.createReadStream(absPath);
  stream.on("error", () => {
    res.statusCode = 500;
    res.end("Internal error");
  });
  stream.pipe(res);
}

async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url, "http://local");
  const pathname = url.pathname;

  if (pathname.startsWith("/api/") || pathname === "/api") {
    const routeKey = `${req.method} ${pathname}`;
    const fn = routes[routeKey];
    if (fn) {
      try {
        await fn(req, res);
      } catch (err) {
        console.error(`[ERROR] ${routeKey}:`, err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "internal_error" }));
        }
      }
      return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  serveStatic(req, res);
}

export default handler;

const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url).replace(/\\/g, "/") ===
    path.resolve(process.argv[1]).replace(/\\/g, "/");

if (isDirectRun) {
  const port = Number(process.env.PORT) || 3000;
  http.createServer(handler).listen(port, () => {
    console.log(`
  ╔══════════════════════════════════════╗
  ║       A M A A N A T   S E R V E R   ║
  ╚══════════════════════════════════════╝

  → http://localhost:${port}

  Database : ${databaseConfigured() ? "✓ connected" : "✗ not configured"}
  Payments : ${paymentsConfigured() ? `✓ ${razorpayMode()} mode` : "✗ not configured"}
`);
  });
}
