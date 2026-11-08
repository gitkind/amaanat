-- ============================================================
-- AMAANAT — 004 newsletter sign-ups (additive, re-runnable)
-- Stores only the email, when consent was given and where.
-- No emails are sent by the application; export from the admin.
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  email      TEXT PRIMARY KEY CHECK (email = lower(email) AND char_length(email) BETWEEN 5 AND 254),
  consent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source     TEXT CHECK (source IS NULL OR char_length(source) <= 40)
);
ALTER TABLE newsletter_subscribers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON newsletter_subscribers FROM anon;

CREATE OR REPLACE FUNCTION api_newsletter_subscribe(p_email TEXT, p_source TEXT)
RETURNS TEXT LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO newsletter_subscribers (email, source) VALUES (lower(p_email), left(p_source, 40))
  ON CONFLICT (email) DO NOTHING;
  RETURN CASE WHEN FOUND THEN 'subscribed' ELSE 'already' END;
END $$;

CREATE OR REPLACE FUNCTION api_admin_newsletter(p_limit INTEGER, p_offset INTEGER)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM newsletter_subscribers),
    'rows', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.consent_at DESC) FROM (
      SELECT * FROM newsletter_subscribers ORDER BY consent_at DESC
       LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000) OFFSET GREATEST(COALESCE(p_offset, 0), 0)) s), '[]'::jsonb));
$$;

DO $$
DECLARE f RECORD;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('api_newsletter_subscribe', 'api_admin_newsletter')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;

INSERT INTO schema_migrations (version) VALUES ('004_newsletter') ON CONFLICT DO NOTHING;
COMMIT;
