// Test harness: real app + real migrations on in-memory PGlite, local auth,
// and an in-memory Razorpay stand-in. All values here are TEST FIXTURES ONLY.
import crypto from "node:crypto";
import http from "node:http";
import { createApp } from "../lib/app.js";
import { createLocalAuth } from "../lib/auth/local.js";
import { loadConfig } from "../lib/config.js";
import { createPgliteDb } from "../lib/db/pglite.js";
import { createLocalStorage } from "../lib/storage.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const TEST_KEY_SECRET = "test_key_secret_fixture";
export const TEST_WEBHOOK_SECRET = "test_webhook_secret_fixture";
export const TEST_CRON_SECRET = "test_cron_secret_fixture";

const alnum = (n) => crypto.randomBytes(n).toString("hex").slice(0, n);

export function createFakeRazorpay() {
  const orders = new Map();
  const payments = new Map();
  const fake = {
    calls: [],
    failCreate: false,
    failFetch: false,
    async createOrder({ amount, receipt, notes }) {
      fake.calls.push(["createOrder", amount, receipt]);
      if (fake.failCreate) throw new Error("simulated gateway outage");
      const o = { id: `order_${alnum(14)}`, amount, currency: "INR", receipt, notes, status: "created" };
      orders.set(o.id, o);
      return o;
    },
    async fetchPayment(id) {
      if (fake.failFetch) throw new Error("simulated outage");
      const p = payments.get(id);
      if (!p) throw new Error("not found");
      return p;
    },
    async fetchOrderPayments(orderId) {
      if (fake.failFetch) {
        const { RazorpayError } = await import("../lib/razorpay.js");
        throw new RazorpayError("simulated outage", 0);
      }
      return [...payments.values()].filter((p) => p.order_id === orderId);
    },
    // Simulates the customer paying on Razorpay's side.
    pay(orderId, { status = "captured", amount } = {}) {
      const o = orders.get(orderId);
      const p = { id: `pay_${alnum(14)}`, order_id: orderId, amount: amount ?? o.amount, currency: "INR", status };
      payments.set(p.id, p);
      return p;
    },
    order: (id) => orders.get(id),
    refunds: [],
    refundMode: "processed", // "processed" | "pending" | "error" | "timeout"
    async createRefund(paymentId, { amount }) {
      const { RazorpayError } = await import("../lib/razorpay.js");
      if (fake.refundMode === "error") throw new RazorpayError("The amount is invalid", 400);
      if (fake.refundMode === "timeout") throw new RazorpayError("Razorpay unreachable: timeout", 0);
      const r = { id: `rfnd_${alnum(14)}`, payment_id: paymentId, amount, status: fake.refundMode };
      fake.refunds.push(r);
      return r;
    },
  };
  return fake;
}

export function sign(orderId, paymentId, secret = TEST_KEY_SECRET) {
  return crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
}

export function signWebhook(body, secret = TEST_WEBHOOK_SECRET) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export async function startTestServer({ payments = true, webhook = true } = {}) {
  const config = loadConfig({
    NODE_ENV: "test",
    RAZORPAY_KEY_ID: payments ? "rzp_test_fixture000" : "",
    RAZORPAY_KEY_SECRET: payments ? TEST_KEY_SECRET : "",
    RAZORPAY_WEBHOOK_SECRET: webhook ? TEST_WEBHOOK_SECRET : "",
    CRON_SECRET: TEST_CRON_SECRET,
    RESERVATION_MINUTES: "30",
  });
  const db = await createPgliteDb();
  const auth = createLocalAuth({ pg: db.pg, secret: "test-local-auth-secret" });
  const razorpay = payments ? createFakeRazorpay() : null;
  const silent = { log() {}, info() {}, warn() {}, error() {} };
  const uploadDir = await mkdtemp(path.join(os.tmpdir(), "amaanat-uploads-"));
  const storage = createLocalStorage({ rootDir: uploadDir });
  const app = createApp({ config, db, auth, razorpay, storage, log: silent });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base, db, razorpay, app,
    uploadDir,
    async close() {
      await new Promise((r) => server.close(r));
      await db.close();
      await rm(uploadDir, { recursive: true, force: true });
    },
    // Registers a user and grants an admin role (test database only).
    async adminClient(email, role = "owner", password = "admin test password") {
      const c = createClient(base);
      const reg = await c.post("/api/auth/register", { email, password });
      if (reg.status !== 201) throw new Error(`register failed: ${reg.status}`);
      const { rows } = await db.pg.query("SELECT id FROM auth.users WHERE email = $1", [email]);
      await db.pg.query("INSERT INTO admin_users (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = $2", [rows[0].id, role]);
      return c;
    },
    // --- fixtures (test database only) ---
    async setStock(productId, qty) {
      return db.rpc("set_product_stock", { p_product_id: productId, p_quantity: qty, p_note: "test fixture" });
    },
    async setShipping(paise) {
      await db.pg.query("UPDATE site_settings SET shipping_paise = $1, shipping_confirmed = true WHERE id = 1", [paise]);
    },
    async stockOf(productId) {
      return (await db.pg.query("SELECT stock_quantity FROM products WHERE id = $1", [productId])).rows[0].stock_quantity;
    },
    async orderRow(id) {
      return (await db.pg.query("SELECT * FROM orders WHERE id = $1", [id])).rows[0];
    },
    client() {
      return createClient(base);
    },
  };
}

// Minimal browser-like client with a cookie jar and same-origin headers.
export function createClient(base) {
  const jar = new Map();
  async function request(method, path, { body, headers = {}, raw } = {}) {
    const h = { Origin: base, ...headers };
    if (jar.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    let payload;
    if (raw !== undefined) {
      payload = raw;
    } else if (body !== undefined) {
      h["Content-Type"] = "application/json";
      payload = typeof body === "string" ? body : JSON.stringify(body);
    }
    const res = await fetch(base + path, { method, headers: h, body: payload, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (/Max-Age=0/.test(c) || value === "") jar.delete(name);
      else jar.set(name, value);
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text, headers: res.headers };
  }
  return {
    jar,
    get: (p, o) => request("GET", p, o),
    post: (p, body, o = {}) => request("POST", p, { ...o, body }),
    put: (p, body, o = {}) => request("PUT", p, { ...o, body }),
    del: (p, o) => request("DELETE", p, o),
    upload: (p, buffer, type = "image/png") => request("POST", p, { raw: buffer, headers: { "Content-Type": type } }),
  };
}

export const CUSTOMER = {
  fullName: "Test Customer",
  email: "test.customer@example.test",
  phone: "9876543210",
  address: "12 Test Street",
  apartment: "",
  locality: "Test Nagar",
  city: "Testpur",
  state: "Maharashtra",
  pin: "400001",
  notes: "",
};

export const newKey = () => crypto.randomBytes(24).toString("base64url");

// Smallest valid images for upload tests.
export const PNG_1PX = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
