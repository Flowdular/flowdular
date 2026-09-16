-- The text read out of a stored document, one row per workspace and document.
-- A pending row is the job the text runner claims; every other status is the
-- settled answer a later read returns without parsing again.
CREATE TABLE IF NOT EXISTS documents_text (
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'unscanned', 'unsupported', 'too-large')),
  reason TEXT,
  text TEXT NOT NULL DEFAULT '',
  pages INTEGER NOT NULL DEFAULT 0 CHECK (pages >= 0),
  truncated BOOLEAN NOT NULL DEFAULT false,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  requested_at BIGINT NOT NULL,
  claimed_by TEXT,
  claimed_at BIGINT,
  extracted_at BIGINT,
  PRIMARY KEY (tenant_id, document_id)
);
-- A document without a row copies a settled row of the same bytes.
CREATE INDEX IF NOT EXISTS documents_text_checksum_idx
  ON documents_text (tenant_id, content_sha256) WHERE status <> 'pending';
-- The runner's routing read walks pending rows in request order.
CREATE INDEX IF NOT EXISTS documents_text_pending_idx
  ON documents_text (requested_at, tenant_id, document_id) WHERE status = 'pending';
ALTER TABLE documents_text ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents_text FORCE ROW LEVEL SECURITY;
CREATE POLICY documents_text_tenant_policy ON documents_text
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
-- The runner finds pending work across workspaces before it knows whose it is,
-- so the cross-tenant role reads the routing columns of pending rows and
-- nothing else; every claim and write runs again under the workspace named.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY documents_text_background_policy ON documents_text
  FOR SELECT TO coreloom_background
  USING (status = 'pending');
REVOKE SELECT ON documents_text FROM coreloom_background;
GRANT SELECT (tenant_id, document_id, status, requested_at) ON documents_text TO coreloom_background;
