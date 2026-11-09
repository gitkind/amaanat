-- ============================================================
-- AMAANAT — 005 service_role table grants (grants only, re-runnable)
--
-- Why: the backend calls the store functions (SECURITY INVOKER) as
-- service_role. This Supabase project does not grant table privileges
-- to service_role automatically, so every function failed with
-- "permission denied for table …" (SQLSTATE 42501).
--
-- What it does:
--   * lets service_role use the public schema and read/write the
--     existing public tables (SELECT, INSERT, UPDATE, DELETE only);
--   * makes tables (and any sequences) created later by the role that
--     runs this file grant the same to service_role;
--   * records itself in schema_migrations.
--
-- What it does NOT do:
--   * grant anything to anon or authenticated (browser roles stay blocked);
--   * change RLS, policies, functions, data, or the rls_auto_enable trigger.
--
-- Sequences: no existing table uses a sequence or identity column
-- (keys are UUID / TEXT / fixed INTEGER), so no sequence grants are needed now.
--
-- Run once in the Supabase SQL Editor, as the same role that ran 001–004
-- (the SQL Editor's default role), after 004.
-- ============================================================

BEGIN;

-- 1. Schema access
GRANT USAGE ON SCHEMA public TO service_role;

-- 2. Existing tables: data access only (no TRUNCATE, REFERENCES, TRIGGER)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;

-- 3. Future objects created in public by the role running this migration
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO service_role;

-- 4. Bookkeeping
INSERT INTO schema_migrations (version) VALUES ('005_service_role_grants') ON CONFLICT DO NOTHING;

COMMIT;
