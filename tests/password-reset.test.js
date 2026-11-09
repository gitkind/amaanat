import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, test } from "node:test";
import { createSupabaseAuth } from "../lib/auth/supabase.js";
import { startTestServer } from "./helpers.js";

let t;
before(async () => {
  t = await startTestServer({ payments: false, webhook: false });
  t.owner = await t.adminClient("reset-owner@example.test", "owner", "original owner password");
  t.customer = t.client();
  await t.customer.post("/api/auth/register", { email: "reset-customer@example.test", password: "original customer password" });
});
after(() => t.close());
beforeEach(() => t.app.deps.limiter.reset());

const tokenFrom = (link) => new URL(link).searchParams.get("token_hash");
async function requestLink(email) {
  const before = t.emails.length;
  const r = await t.client().post("/api/auth/forgot", { email });
  return { r, email: t.emails.length > before ? t.emails.at(-1) : null };
}

describe("pages and links", () => {
  test("forgot / reset pages render, are noindex, and both sign-in forms link to recovery", async () => {
    for (const p of ["/forgot-password", "/reset-password"]) {
      const res = await fetch(t.base + p);
      const html = await res.text();
      assert.equal(res.status, 200, p);
      assert.match(html, /noindex/);
      assert.match(html, /<h1>/);
    }
    assert.match(await (await fetch(`${t.base}/admin/`)).text(), /href="\/forgot-password">Forgot password\?/);
    assert.match(await readFile(new URL("../public/js/account.js", import.meta.url), "utf8"), /href="\/forgot-password">Forgot password\?/);
  });
});

describe("requesting a reset link", () => {
  test("same generic answer for registered and unknown emails; only registered emails get a link", async () => {
    const unknown = await requestLink("nobody@example.test");
    const known = await requestLink("reset-owner@example.test");
    assert.equal(unknown.r.status, 200);
    assert.equal(known.r.status, 200);
    assert.deepEqual({ ...unknown.r.body, _status: 0 }, { ...known.r.body, _status: 0 }, "responses must not reveal registration");
    assert.equal(unknown.email, null);
    assert.equal(known.email.to, "reset-owner@example.test");
    const link = new URL(known.email.link);
    assert.equal(`${link.origin}${link.pathname}`, `${t.base}/reset-password`, "redirect goes to this site's reset page");
    assert.equal(link.searchParams.get("type"), "recovery");
    assert.equal((await t.client().post("/api/auth/forgot", { email: "not-an-email" })).status, 400);
  });

  test("per-email limit: extra requests still get the generic answer but send nothing", async () => {
    const sent = [];
    for (let i = 0; i < 4; i++) {
      const { r, email } = await requestLink("reset-customer@example.test");
      assert.equal(r.status, 200);
      sent.push(Boolean(email));
    }
    assert.deepEqual(sent, [true, true, true, false]);
  });
});

describe("using the link", () => {
  test("invalid or reused links are rejected; the token never comes back to the page", async () => {
    assert.equal((await t.client().post("/api/auth/recovery", { tokenHash: "x".repeat(30) })).body.error, "recovery_invalid");
    assert.equal((await t.client().post("/api/auth/recovery", {})).status, 400);
    const { email } = await requestLink("reset-owner@example.test");
    const token = tokenFrom(email.link);
    const c = t.client();
    const r = await c.post("/api/auth/recovery", { tokenHash: token });
    assert.equal(r.status, 200);
    assert.match(r.body.email, /^r•+@example\.test$/, "email shown masked");
    assert.ok(!JSON.stringify(r.body).includes(token));
    const cookie = r.headers.getSetCookie().find((x) => x.startsWith("am_recovery="));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/api\/auth/);
    assert.match(cookie, /Max-Age=900/);
    assert.equal((await t.client().post("/api/auth/recovery", { tokenHash: token })).status, 400, "single use");
  });

  test("password rules and clear errors", async () => {
    assert.equal((await t.client().post("/api/auth/reset", { password: "a long new password", confirm: "a long new password" })).status, 401, "needs a verified link");
    const { email } = await requestLink("reset-owner@example.test");
    const c = t.client();
    await c.post("/api/auth/recovery", { tokenHash: tokenFrom(email.link) });
    const short = await c.post("/api/auth/reset", { password: "short", confirm: "short" });
    assert.equal(short.status, 400);
    assert.equal(short.body.errors.password, "Use at least 8 characters.");
    assert.equal((await c.post("/api/auth/reset", { password: "x".repeat(73), confirm: "x".repeat(73) })).body.errors.password, "Use 72 characters or fewer.");
    assert.equal((await c.post("/api/auth/reset", { password: "          ", confirm: "          " })).body.errors.password, "The password can't be only spaces.");
    assert.equal((await c.post("/api/auth/reset", { password: "a long new password", confirm: "different" })).body.errors.confirm, "The passwords don't match.");
    const same = await c.post("/api/auth/reset", { password: "original owner password", confirm: "original owner password" });
    assert.equal(same.status, 422);
    assert.equal(same.body.error, "same_password");
  });

  test("admin reset: new password works, old one doesn't, owner role kept, redirected to admin sign-in", async () => {
    const { email } = await requestLink("reset-owner@example.test");
    const c = t.client();
    await c.post("/api/auth/recovery", { tokenHash: tokenFrom(email.link) });
    const done = await c.post("/api/auth/reset", { password: "brand new owner phrase", confirm: "brand new owner phrase" });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.redirect, "/admin/");
    const cleared = done.headers.getSetCookie();
    assert.ok(cleared.some((x) => x.startsWith("am_recovery=;") && /Max-Age=0/.test(x)), "recovery cookie cleared");
    assert.equal((await c.post("/api/auth/reset", { password: "another phrase here", confirm: "another phrase here" })).status, 401, "recovery session ends");

    assert.equal((await t.client().post("/api/admin/login", { email: "reset-owner@example.test", password: "original owner password" })).status, 401);
    const admin = t.client();
    const login = await admin.post("/api/admin/login", { email: "reset-owner@example.test", password: "brand new owner phrase" });
    assert.equal(login.status, 200);
    assert.equal(login.body.admin.role, "owner", "owner role preserved");
    assert.equal((await admin.get("/api/admin/overview")).status, 200);
  });

  test("customer reset redirects to the customer sign-in", async () => {
    const { email } = await requestLink("reset-customer@example.test");
    const c = t.client();
    await c.post("/api/auth/recovery", { tokenHash: tokenFrom(email.link) });
    const done = await c.post("/api/auth/reset", { password: "brand new customer phrase", confirm: "brand new customer phrase" });
    assert.equal(done.body.redirect, "/account");
    assert.equal((await t.client().post("/api/auth/login", { email: "reset-customer@example.test", password: "brand new customer phrase" })).status, 200);
  });

  test("default Supabase links (access token in the URL fragment) are accepted too", async () => {
    const session = await t.app.deps.auth.signIn("reset-customer@example.test", "brand new customer phrase");
    const c = t.client();
    const r = await c.post("/api/auth/recovery", { accessToken: session.accessToken });
    assert.equal(r.status, 200);
    assert.equal((await t.client().post("/api/auth/recovery", { accessToken: "not.a.valid.token.value.at.all" })).status, 400);
  });
});

describe("Supabase provider contract (mocked HTTP; no network)", () => {
  function fakeFetch(handler) {
    const calls = [];
    const impl = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
      const [status, json] = handler(url, init);
      return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
    };
    return { calls, impl };
  }

  test("uses /recover (resetPasswordForEmail), /verify, PUT /user and global /logout with the anon key only", async () => {
    const f = fakeFetch((url) => (url.includes("/verify")
      ? [200, { access_token: "at", refresh_token: "rt", expires_in: 3600, user: { id: "u1", email: "a@b.test" } }]
      : [200, {}]));
    const auth = createSupabaseAuth({ url: "https://proj.supabase.co", anonKey: "anon-key", fetchImpl: f.impl });
    await auth.recover("a@b.test", "https://shop.test/reset-password");
    await auth.verifyRecovery("hash123456");
    await auth.updatePassword("at", "new password 1");
    await auth.signOut("at", { scope: "global" });
    assert.equal(f.calls[0].url, "https://proj.supabase.co/auth/v1/recover?redirect_to=https%3A%2F%2Fshop.test%2Freset-password");
    assert.deepEqual(f.calls[0].body, { email: "a@b.test" });
    assert.deepEqual(f.calls[1].body, { type: "recovery", token_hash: "hash123456" });
    assert.equal(f.calls[2].method, "PUT");
    assert.equal(f.calls[2].headers.Authorization, "Bearer at");
    assert.equal(f.calls[3].url, "https://proj.supabase.co/auth/v1/logout?scope=global");
    assert.ok(f.calls.every((c) => c.headers.apikey === "anon-key"));
  });

  test("maps Supabase errors to clear messages; unknown emails are not distinguishable", async () => {
    const respond = (status, json) => fakeFetch(() => [status, json]).impl;
    const mk = (status, json) => createSupabaseAuth({ url: "https://p.supabase.co", anonKey: "k", fetchImpl: respond(status, json) });
    assert.equal(await mk(200, {}).recover("x@y.test"), true);
    await assert.rejects(mk(429, { msg: "rate limit" }).recover("x@y.test"), { code: "rate_limited" });
    await assert.rejects(mk(422, { error_code: "same_password", msg: "New password should be different from the old password." }).updatePassword("t", "p"), { code: "same_password" });
    await assert.rejects(mk(422, { error_code: "weak_password", msg: "Password should contain at least one number." }).updatePassword("t", "p"), { code: "weak_password", message: "Password should contain at least one number." });
    await assert.rejects(mk(401, { msg: "invalid JWT" }).updatePassword("t", "p"), { code: "recovery_expired" });
    assert.equal(await mk(403, { msg: "Token has expired or is invalid" }).verifyRecovery("hash123456"), null);
  });
});
