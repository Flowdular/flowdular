-- Templates a module registers are defaults in code. A workspace gains a row
-- here once it renders or edits one, naming the current of its immutable
-- versions below.
CREATE TABLE IF NOT EXISTS document_templates (
  tenant_id TEXT NOT NULL,
  template_key TEXT NOT NULL CHECK (length(template_key) BETWEEN 3 AND 128),
  owner_module TEXT NOT NULL,
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  updated_by TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, template_key)
);
CREATE TABLE IF NOT EXISTS document_template_versions (
  tenant_id TEXT NOT NULL,
  template_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  origin TEXT NOT NULL CHECK (origin IN ('module', 'edit', 'revert')),
  body TEXT NOT NULL CHECK (length(body) <= 65536),
  layout TEXT NOT NULL,
  input_schema TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('en', 'pl')),
  format TEXT NOT NULL CHECK (format IN ('pdf', 'docx')),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, template_key, version)
);
-- A render is the job that produces one document. The input is kept only until
-- the render settles.
CREATE TABLE IF NOT EXISTS document_renders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  template_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  owner_module TEXT NOT NULL,
  record_ref TEXT NOT NULL,
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  input TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL CHECK (format IN ('pdf', 'docx')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  document_id TEXT,
  error_code TEXT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  requested_by TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at BIGINT,
  created_at BIGINT NOT NULL,
  finished_at BIGINT
);
-- A retried tool call carries the key its caller derived for that call, and
-- the key answers the render it first reached, even after the template gained
-- a version; the request digest refuses a key reused for another request.
CREATE TABLE IF NOT EXISTS document_render_keys (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  render_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS document_render_keys_render_idx
  ON document_render_keys (tenant_id, render_id);
-- The render tuple is the key ledger: the same version, record, format and
-- input answer the render that already exists.
CREATE UNIQUE INDEX IF NOT EXISTS document_renders_tuple_idx
  ON document_renders (tenant_id, template_key, version, owner_module, record_ref, format, input_digest);
-- The runner's routing read walks queued and running renders in request order.
CREATE INDEX IF NOT EXISTS document_renders_pending_idx
  ON document_renders (created_at, tenant_id, id) WHERE status IN ('queued', 'running');
-- The retention sweep removes settled renders of one workspace by age.
CREATE INDEX IF NOT EXISTS document_renders_settled_idx
  ON document_renders (tenant_id, created_at, id) WHERE status IN ('succeeded', 'failed');
ALTER TABLE document_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY document_templates_tenant_policy ON document_templates
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE document_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_template_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY document_template_versions_tenant_policy ON document_template_versions
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE document_renders ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_renders FORCE ROW LEVEL SECURITY;
CREATE POLICY document_renders_tenant_policy ON document_renders
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE document_render_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_render_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY document_render_keys_tenant_policy ON document_render_keys
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
-- The runner finds renders across workspaces before it knows whose they are,
-- so the cross-tenant role reads the routing columns of queued and running
-- renders and nothing else; every claim and write runs under the workspace.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY document_renders_background_policy ON document_renders
  FOR SELECT TO coreloom_background
  USING (status IN ('queued', 'running'));
REVOKE SELECT ON document_renders FROM coreloom_background;
GRANT SELECT (id, tenant_id, status, created_at, claimed_at) ON document_renders TO coreloom_background;
