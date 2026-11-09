// Guards the number of database/auth round trips on hot paths. In production each
// round trip is a network call to Supabase, so these counts are response time.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { CUSTOMER, createClient, startTestServer } from "./helpers.js";

let t;
let calls = [];
before(async () => {
  t = await startTestServer();
  const raw = t.db.rpc;
  t.db.rpc = (name, args) => { calls.push(name); return raw(name, args); };
  const auth = t.app.deps.auth;
  const getUser = auth.getUser;
  auth.getUser = (...a) => { calls.push("auth.getUser"); return getUser(...a); };
});
after(() => t.close());
beforeEach(() => { t.app.deps.limiter.reset(); calls = []; });

describe("round trips on hot paths", () => {
  test("a new visitor's bag check makes no database call", async () => {
    const r = await createClient(t.base).get("/api/cart");
    assert.equal(r.status, 200);
    assert.equal(r.body.count, 0);
    assert.deepEqual(calls, []);
  });

  test("a signed-in request looks the user up once, even when several parts need it", async () => {
    const c = createClient(t.base);
    await c.post("/api/auth/register", { email: "perf@example.test", password: "perf test password" });
    await t.setStock("p04", 3);
    await t.setShipping(0);
    await t.db.pg.query("UPDATE site_settings SET cod_enabled = true WHERE id = 1");
    await c.post("/api/cart/items", { productId: "p04", quantity: 1 });
    calls = [];
    const r = await c.post("/api/checkout", { checkoutKey: crypto.randomBytes(24).toString("base64url"), customer: CUSTOMER, paymentMethod: "cod" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "placed");
    assert.equal(calls.filter((x) => x === "auth.getUser").length, 1, calls.join(","));
    assert.equal(calls.filter((x) => x === "api_cart_resolve").length, 1, "the bag is found once and reused to clear it");
    assert.equal((await c.get("/api/cart")).body.count, 0, "bag cleared after the order");
  });
});
