-- ============================================================
-- AMAANAT — 007 website content (CMS): drafts, publishing, history
-- (additive, re-runnable)
--
-- One row per editable document ('home', 'about', 'founder', 'site').
-- The owner edits a draft; publishing copies it to the live version and
-- keeps a numbered copy in cms_versions so any earlier version can be
-- restored. Content is validated by the server (lib/cms.js) before it is
-- stored and is always escaped when rendered.
--
-- Browser roles (anon, authenticated) get no access: RLS is on with no
-- policies and every function is executable by service_role only.
-- Changes nothing that already exists.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS cms_documents (
  key                TEXT PRIMARY KEY CHECK (key IN ('home', 'about', 'founder', 'site')),
  draft              JSONB NOT NULL DEFAULT '{}'::jsonb,
  draft_updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  draft_updated_by   TEXT,
  published          JSONB,
  published_at       TIMESTAMPTZ,
  published_by       TEXT,
  published_version  INTEGER NOT NULL DEFAULT 0,
  CHECK (pg_column_size(draft) < 400000),
  CHECK (published IS NULL OR pg_column_size(published) < 400000)
);
ALTER TABLE cms_documents ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS cms_versions (
  doc_key      TEXT NOT NULL REFERENCES cms_documents(key) ON DELETE CASCADE,
  version      INTEGER NOT NULL CHECK (version > 0),
  content      JSONB NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by TEXT,
  PRIMARY KEY (doc_key, version)
);
ALTER TABLE cms_versions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON cms_documents, cms_versions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON cms_documents, cms_versions TO service_role;

-- Live content for the storefront: { key: published content }.
CREATE OR REPLACE FUNCTION api_cms_public()
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_object_agg(key, published), '{}'::jsonb)
    FROM cms_documents WHERE published IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION am_cms_state(p_key TEXT)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'key', p_key,
    'draft', d.draft, 'draftUpdatedAt', d.draft_updated_at, 'draftUpdatedBy', d.draft_updated_by,
    'published', d.published, 'publishedAt', d.published_at, 'publishedBy', d.published_by,
    'publishedVersion', COALESCE(d.published_version, 0),
    'hasUnpublishedChanges', d.key IS NOT NULL AND (d.published IS NULL OR d.draft IS DISTINCT FROM d.published),
    'versions', COALESCE((SELECT jsonb_agg(jsonb_build_object('version', v.version, 'publishedAt', v.published_at, 'publishedBy', v.published_by)
                                           ORDER BY v.version DESC)
                            FROM (SELECT * FROM cms_versions WHERE doc_key = p_key ORDER BY version DESC LIMIT 30) v), '[]'::jsonb))
  FROM (SELECT p_key AS k) x LEFT JOIN cms_documents d ON d.key = x.k;
$$;

CREATE OR REPLACE FUNCTION api_admin_cms_get(p_key TEXT)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT am_cms_state(p_key);
$$;

CREATE OR REPLACE FUNCTION api_admin_cms_save_draft(p_key TEXT, p_content JSONB, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO cms_documents (key, draft, draft_updated_at, draft_updated_by)
  VALUES (p_key, p_content, now(), p_actor->>'email')
  ON CONFLICT (key) DO UPDATE SET draft = EXCLUDED.draft, draft_updated_at = now(), draft_updated_by = EXCLUDED.draft_updated_by;
  PERFORM am_audit(p_actor, 'cms.draft_saved', 'cms', p_key, '{}'::jsonb);
  RETURN am_cms_state(p_key);
END $$;

CREATE OR REPLACE FUNCTION api_admin_cms_publish(p_key TEXT, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_doc cms_documents%ROWTYPE; v_next INTEGER;
BEGIN
  SELECT * INTO v_doc FROM cms_documents WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'nothing_to_publish' USING ERRCODE = 'P0001'; END IF;
  v_next := v_doc.published_version + 1;
  INSERT INTO cms_versions (doc_key, version, content, published_by) VALUES (p_key, v_next, v_doc.draft, p_actor->>'email');
  UPDATE cms_documents SET published = draft, published_at = now(), published_by = p_actor->>'email', published_version = v_next
   WHERE key = p_key;
  PERFORM am_audit(p_actor, 'cms.published', 'cms', p_key, jsonb_build_object('version', v_next));
  RETURN am_cms_state(p_key);
END $$;

-- Loads an earlier published version into the draft (publish it to make it live).
CREATE OR REPLACE FUNCTION api_admin_cms_restore(p_key TEXT, p_version INTEGER, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_content JSONB;
BEGIN
  SELECT content INTO v_content FROM cms_versions WHERE doc_key = p_key AND version = p_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'version_not_found' USING ERRCODE = 'P0001'; END IF;
  UPDATE cms_documents SET draft = v_content, draft_updated_at = now(), draft_updated_by = p_actor->>'email' WHERE key = p_key;
  PERFORM am_audit(p_actor, 'cms.version_restored', 'cms', p_key, jsonb_build_object('version', p_version));
  RETURN am_cms_state(p_key);
END $$;

-- Throws away unpublished edits (draft = live version).
CREATE OR REPLACE FUNCTION api_admin_cms_discard(p_key TEXT, p_actor JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE cms_documents SET draft = published, draft_updated_at = now(), draft_updated_by = p_actor->>'email'
   WHERE key = p_key AND published IS NOT NULL;
  DELETE FROM cms_documents WHERE key = p_key AND published IS NULL;
  PERFORM am_audit(p_actor, 'cms.draft_discarded', 'cms', p_key, '{}'::jsonb);
  RETURN am_cms_state(p_key);
END $$;

CREATE OR REPLACE FUNCTION api_admin_cms_version(p_key TEXT, p_version INTEGER)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT content FROM cms_versions WHERE doc_key = p_key AND version = p_version;
$$;

DO $$
DECLARE f RECORD;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.prokind = 'f'
              AND p.proname IN ('api_cms_public', 'am_cms_state', 'api_admin_cms_get', 'api_admin_cms_save_draft',
                                'api_admin_cms_publish', 'api_admin_cms_restore', 'api_admin_cms_discard', 'api_admin_cms_version')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;

INSERT INTO schema_migrations (version) VALUES ('007_cms') ON CONFLICT DO NOTHING;

COMMIT;
