import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createPgliteDb } from "../lib/db/pglite.js";

let db;
before(async () => {
  db = await createPgliteDb();
});
after(() => db.close());

test("migrations keep the 7 existing products and their IDs, prices and unconfirmed stock", async () => {
  const { rows } = await db.pg.query("SELECT id, price_paise, stock_quantity, inventory_confirmed, images FROM products ORDER BY id");
  assert.deepEqual(rows.map((r) => r.id), ["p01", "p02", "p03", "p04", "p05", "p06", "p07"]);
  assert.deepEqual(rows.map((r) => r.price_paise), [19900, 37900, 37900, 44900, 47900, 49900, 39900]);
  for (const r of rows) {
    assert.equal(r.stock_quantity, null);
    assert.equal(r.inventory_confirmed, false);
    assert.equal(r.images.length, 1);
  }
  const s = (await db.pg.query("SELECT * FROM site_settings")).rows[0];
  assert.equal(s.shipping_confirmed, false);
  assert.equal(s.shipping_paise, null);
});

test("browser roles cannot execute any store function", async () => {
  const { rows } = await db.pg.query(`
    SELECT p.proname, has_function_privilege('anon', p.oid, 'execute') AS anon,
           has_function_privilege('authenticated', p.oid, 'execute') AS authd,
           has_function_privilege('service_role', p.oid, 'execute') AS svc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND (p.proname LIKE 'api\\_%' OR p.proname LIKE 'am\\_%' OR p.proname = 'set_product_stock')`);
  assert.ok(rows.length >= 25, `expected functions, got ${rows.length}`);
  for (const r of rows) {
    assert.equal(r.anon, false, `${r.proname} executable by anon`);
    assert.equal(r.authd, false, `${r.proname} executable by authenticated`);
    assert.equal(r.svc, true, `${r.proname} not executable by service_role`);
  }
  const old = await db.pg.query("SELECT 1 FROM pg_proc WHERE proname IN ('finalize_paid_order','create_checkout_order','release_checkout_order')");
  assert.equal(old.rows.length, 0, "vulnerable 001 functions should be dropped");
});

test("RLS is enabled on every public table", async () => {
  const { rows } = await db.pg.query(`
    SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'`);
  for (const r of rows) assert.equal(r.relrowsecurity, true, `RLS off on ${r.relname}`);
});

test("stock can never go negative at the database level", async () => {
  await assert.rejects(db.pg.query("UPDATE products SET stock_quantity = -1 WHERE id = 'p01'"), /products_stock_nonnegative/);
});

test("migration 002 is re-runnable", async () => {
  const { readFile } = await import("node:fs/promises");
  const { MIGRATIONS_DIR } = await import("../lib/db/pglite.js");
  const sql = await readFile(`${MIGRATIONS_DIR}/002_ecommerce_core.sql`, "utf8");
  await db.pg.exec(sql);
  const { rows } = await db.pg.query("SELECT count(*)::int AS n FROM products");
  assert.equal(rows[0].n, 7);
});
