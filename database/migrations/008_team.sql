-- ============================================================
-- AMAANAT — 008 team management (additive, re-runnable)
--
-- Lets the store owner add, re-role and remove admins from the dashboard
-- (Admin → Team) instead of the SQL editor.
--
-- The functions read auth.users (to match an email to an account), which the
-- service_role cannot read directly. They are therefore SECURITY DEFINER,
-- owned by the role that runs this file, with a fixed search_path, and
-- executable by service_role only — the server calls them after checking
-- that the caller is the owner. Browser roles cannot call them.
--
-- Safety rules enforced here (not only in the UI):
--   * an owner cannot remove or demote themselves;
--   * the store always keeps at least one owner;
--   * every change is written to the audit log.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION api_admin_team_list()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id', a.user_id, 'email', u.email, 'role', a.role, 'created_at', a.created_at)
                            ORDER BY (a.role = 'owner') DESC, lower(u.email)), '[]'::jsonb)
    FROM admin_users a JOIN auth.users u ON u.id = a.user_id;
$$;

CREATE OR REPLACE FUNCTION api_admin_team_add(p_email TEXT, p_role TEXT, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user UUID;
BEGIN
  IF p_role NOT IN ('owner', 'manager') THEN RAISE EXCEPTION 'invalid_role'; END IF;
  SELECT id INTO v_user FROM auth.users WHERE lower(email) = lower(trim(p_email)) LIMIT 1;
  IF v_user IS NULL THEN RAISE EXCEPTION 'account_not_found'; END IF;
  IF EXISTS (SELECT 1 FROM admin_users WHERE user_id = v_user) THEN RAISE EXCEPTION 'already_admin'; END IF;
  INSERT INTO admin_users (user_id, role) VALUES (v_user, p_role);
  PERFORM am_audit(p_actor, 'team.added', 'admin', v_user::text, jsonb_build_object('email', lower(trim(p_email)), 'role', p_role));
  RETURN api_admin_team_list();
END $$;

CREATE OR REPLACE FUNCTION api_admin_team_set_role(p_user_id UUID, p_role TEXT, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_old TEXT;
BEGIN
  IF p_role NOT IN ('owner', 'manager') THEN RAISE EXCEPTION 'invalid_role'; END IF;
  IF p_user_id = NULLIF(p_actor->>'id', '')::uuid THEN RAISE EXCEPTION 'cannot_change_self'; END IF;
  LOCK TABLE admin_users IN SHARE ROW EXCLUSIVE MODE; -- serialises the last-owner check
  SELECT role INTO v_old FROM admin_users WHERE user_id = p_user_id;
  IF v_old IS NULL THEN RAISE EXCEPTION 'not_admin'; END IF;
  IF v_old = 'owner' AND p_role <> 'owner' AND (SELECT count(*) FROM admin_users WHERE role = 'owner') <= 1 THEN
    RAISE EXCEPTION 'last_owner';
  END IF;
  UPDATE admin_users SET role = p_role WHERE user_id = p_user_id;
  PERFORM am_audit(p_actor, 'team.role_changed', 'admin', p_user_id::text, jsonb_build_object('from', v_old, 'to', p_role));
  RETURN api_admin_team_list();
END $$;

CREATE OR REPLACE FUNCTION api_admin_team_remove(p_user_id UUID, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_old TEXT;
BEGIN
  IF p_user_id = NULLIF(p_actor->>'id', '')::uuid THEN RAISE EXCEPTION 'cannot_remove_self'; END IF;
  LOCK TABLE admin_users IN SHARE ROW EXCLUSIVE MODE;
  SELECT role INTO v_old FROM admin_users WHERE user_id = p_user_id;
  IF v_old IS NULL THEN RAISE EXCEPTION 'not_admin'; END IF;
  IF v_old = 'owner' AND (SELECT count(*) FROM admin_users WHERE role = 'owner') <= 1 THEN RAISE EXCEPTION 'last_owner'; END IF;
  DELETE FROM admin_users WHERE user_id = p_user_id;
  PERFORM am_audit(p_actor, 'team.removed', 'admin', p_user_id::text, jsonb_build_object('role', v_old));
  RETURN api_admin_team_list();
END $$;

DO $$
DECLARE f RECORD;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.prokind = 'f'
              AND p.proname IN ('api_admin_team_list', 'api_admin_team_add', 'api_admin_team_set_role', 'api_admin_team_remove')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;

INSERT INTO schema_migrations (version) VALUES ('008_team') ON CONFLICT DO NOTHING;

COMMIT;
