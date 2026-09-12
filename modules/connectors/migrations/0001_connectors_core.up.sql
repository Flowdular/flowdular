CREATE TABLE IF NOT EXISTS connectors_instances (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  definition_key TEXT NOT NULL,
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  base_url TEXT NOT NULL,
  auth_kind TEXT NOT NULL CHECK (auth_kind IN ('none', 'api-key', 'bearer', 'oauth2-client-credentials')),
  credential_key_id TEXT,
  credential_iv TEXT,
  credential_tag TEXT,
  credential_ciphertext TEXT,
  credential_fingerprint TEXT,
  allowed_hosts_json TEXT NOT NULL,
  allow_workflows SMALLINT NOT NULL DEFAULT 0 CHECK (allow_workflows IN (0, 1)),
  allow_agents SMALLINT NOT NULL DEFAULT 0 CHECK (allow_agents IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  last_call_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS connectors_instances_name_normalized_idx
  ON connectors_instances (tenant_id, name_normalized);
CREATE INDEX IF NOT EXISTS connectors_instances_tenant_status_idx
  ON connectors_instances (tenant_id, status, name_normalized);
ALTER TABLE connectors_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors_instances FORCE ROW LEVEL SECURITY;
CREATE POLICY connectors_instances_tenant_policy ON connectors_instances
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

CREATE TABLE IF NOT EXISTS connectors_calls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  caller TEXT NOT NULL CHECK (caller IN ('test', 'workflow', 'agent')),
  caller_ref TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'refused')),
  status INTEGER,
  error_class TEXT,
  duration_ms INTEGER NOT NULL,
  request_bytes INTEGER NOT NULL,
  response_bytes INTEGER NOT NULL,
  occurred_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS connectors_calls_tenant_time_idx
  ON connectors_calls (tenant_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS connectors_calls_instance_idx
  ON connectors_calls (tenant_id, instance_id, occurred_at DESC);
ALTER TABLE connectors_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY connectors_calls_tenant_policy ON connectors_calls
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

CREATE TABLE IF NOT EXISTS connectors_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('instance.created', 'instance.updated', 'instance.consent-changed', 'instance.enabled', 'instance.disabled', 'instance.deleted')),
  instance_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS connectors_audit_tenant_time_idx
  ON connectors_audit (tenant_id, occurred_at DESC, id DESC);
ALTER TABLE connectors_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY connectors_audit_tenant_policy ON connectors_audit
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
