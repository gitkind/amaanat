import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { createClient, startTestServer } from "./helpers.js";

let t;
before(async () => {
  t = await startTestServer();
  t.owner = await t.adminClient("team-owner@example.test", "owner");
});
after(() => t.close());
beforeEach(() => t.app.deps.limiter.reset());

async function customer(email) {
  const c = createClient(t.base);
  assert.equal((await c.post("/api/auth/register", { email, password: "team test password" })).status, 201);
  return c;
}
const idOf = (members, email) => members.find((m) => m.email === email)?.userId;

describe("team management", () => {
  test("only the owner can see or change the team", async () => {
    const mgr = await t.adminClient("team-manager@example.test", "manager");
    assert.equal((await mgr.get("/api/admin/team")).status, 403);
    assert.equal((await mgr.post("/api/admin/team", { email: "x@example.test", role: "manager" })).status, 403);
    assert.equal((await createClient(t.base).get("/api/admin/team")).status, 401);
    const r = await t.owner.get("/api/admin/team");
    assert.equal(r.status, 200);
    assert.ok(r.body.members.find((m) => m.email === "team-owner@example.test").isYou);
  });

  test("add a registered person as manager; they get admin access straight away", async () => {
    const c = await customer("new-staff@example.test");
    assert.equal((await c.get("/api/admin/me")).status, 403, "not an admin yet");
    assert.equal((await t.owner.post("/api/admin/team", { email: "nobody@example.test", role: "manager" })).body.error, "account_not_found");
    assert.equal((await t.owner.post("/api/admin/team", { email: "new-staff@example.test", role: "boss" })).status, 400);
    const add = await t.owner.post("/api/admin/team", { email: "New-Staff@Example.test ", role: "manager" });
    assert.equal(add.status, 201);
    assert.equal(add.body.members.find((m) => m.email === "new-staff@example.test").role, "manager");
    assert.equal((await c.get("/api/admin/me")).body.admin.role, "manager");
    assert.equal((await t.owner.post("/api/admin/team", { email: "new-staff@example.test", role: "owner" })).body.error, "already_admin");
  });

  test("change role and remove; removal revokes access immediately", async () => {
    const c = await customer("temp-staff@example.test");
    const { members } = (await t.owner.post("/api/admin/team", { email: "temp-staff@example.test", role: "manager" })).body;
    const id = idOf(members, "temp-staff@example.test");
    assert.equal((await t.owner.put(`/api/admin/team/${id}`, { role: "owner" })).status, 200);
    assert.equal((await c.get("/api/admin/me")).body.admin.role, "owner");
    assert.equal((await t.owner.del(`/api/admin/team/${id}`)).status, 200);
    assert.equal((await c.get("/api/admin/me")).status, 403, "access gone");
    assert.equal((await c.get("/api/auth/me")).body.user.email, "temp-staff@example.test", "customer account kept");
    const actions = (await t.db.pg.query("SELECT action FROM admin_audit_log WHERE action LIKE 'team.%' ORDER BY created_at")).rows.map((r) => r.action);
    assert.ok(["team.added", "team.role_changed", "team.removed"].every((a) => actions.includes(a)));
  });

  test("owners can't remove or demote themselves, and the last owner can't be removed", async () => {
    const { members } = (await t.owner.get("/api/admin/team")).body;
    const me = members.find((m) => m.isYou).userId;
    assert.equal((await t.owner.del(`/api/admin/team/${me}`)).body.error, "cannot_remove_self");
    assert.equal((await t.owner.put(`/api/admin/team/${me}`, { role: "manager" })).body.error, "cannot_change_self");
    // A second owner tries to demote the first while they're the only other owner: allowed while two owners exist…
    const other = await customer("co-owner@example.test");
    await t.owner.post("/api/admin/team", { email: "co-owner@example.test", role: "owner" });
    await other.post("/api/auth/login", { email: "co-owner@example.test", password: "team test password" });
    assert.equal((await other.put(`/api/admin/team/${me}`, { role: "manager" })).status, 200);
    // …but now the co-owner is the last owner and can't be removed or demoted by anyone.
    const coId = idOf((await other.get("/api/admin/team")).body.members, "co-owner@example.test");
    assert.equal((await other.del(`/api/admin/team/${coId}`)).body.error, "cannot_remove_self");
    const row = await t.db.rpc("api_admin_team_remove", { p_user_id: coId, p_actor: { id: me } }).catch((e) => e.code);
    assert.equal(row, "last_owner");
    // restore for other tests
    await other.put(`/api/admin/team/${me}`, { role: "owner" });
  });

  test("bad ids are rejected", async () => {
    assert.equal((await t.owner.del("/api/admin/team/not-a-uuid")).status, 404);
    assert.equal((await t.owner.put("/api/admin/team/00000000-0000-0000-0000-000000000000", { role: "manager" })).body.error, "not_admin");
  });
});
