CREATE TABLE IF NOT EXISTS agent_run_grant_uses (
  grant_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  issued_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_run_grant_expiry_idx
  ON agent_run_grant_uses (expires_at);
ALTER TABLE agent_run_grant_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_grant_uses FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_run_grant_uses_tenant_policy ON agent_run_grant_uses
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
