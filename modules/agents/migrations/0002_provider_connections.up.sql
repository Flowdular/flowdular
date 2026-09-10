CREATE TABLE IF NOT EXISTS agent_provider_connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('vercel', 'azure', 'openai', 'openai-compatible', 'anthropic')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  resource_name TEXT,
  base_url TEXT,
  models_json TEXT NOT NULL,
  credential_key_id TEXT NOT NULL,
  credential_iv TEXT NOT NULL,
  credential_tag TEXT NOT NULL,
  credential_ciphertext TEXT NOT NULL,
  credential_revision INTEGER NOT NULL CHECK (credential_revision >= 1),
  readiness_status TEXT NOT NULL CHECK (readiness_status IN ('unknown', 'healthy', 'unhealthy')),
  readiness_model TEXT,
  readiness_latency_ms BIGINT,
  readiness_error_code TEXT,
  readiness_checked_at BIGINT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, provider_key)
);
CREATE INDEX IF NOT EXISTS agent_provider_connections_tenant_name_idx
  ON agent_provider_connections (tenant_id, name, id);
ALTER TABLE agent_provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_provider_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_provider_connections_tenant_policy ON agent_provider_connections
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
