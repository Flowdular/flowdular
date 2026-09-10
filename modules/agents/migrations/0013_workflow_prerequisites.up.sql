-- SQLite expresses immutability with a BEFORE trigger that aborts. PostgreSQL
-- needs a function to raise from, shared by every immutable table here.
CREATE OR REPLACE FUNCTION coreloom_reject_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '%', TG_ARGV[0];
END;
$$ LANGUAGE plpgsql;
CREATE TABLE IF NOT EXISTS agent_definition_revisions (
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  agent_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  allowed_tools_json TEXT NOT NULL,
  skills_json TEXT NOT NULL,
  max_steps INTEGER NOT NULL CHECK (max_steps BETWEEN 1 AND 32),
  timeout_ms BIGINT NOT NULL CHECK (timeout_ms BETWEEN 250 AND 86400000),
  temperature_milli INTEGER NOT NULL CHECK (temperature_milli BETWEEN 0 AND 2000),
  max_output_tokens BIGINT NOT NULL CHECK (max_output_tokens BETWEEN 256 AND 65536),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  retained_by TEXT NOT NULL,
  retained_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, agent_id, revision)
);
CREATE INDEX IF NOT EXISTS agent_definition_revisions_tenant_agent_idx
  ON agent_definition_revisions (tenant_id, agent_id, revision DESC);
CREATE TRIGGER agent_definition_revisions_no_update
  BEFORE UPDATE ON agent_definition_revisions
  FOR EACH ROW EXECUTE FUNCTION coreloom_reject_change('agent definition revisions are immutable');
CREATE TRIGGER agent_definition_revisions_no_delete
  BEFORE DELETE ON agent_definition_revisions
  FOR EACH ROW EXECUTE FUNCTION coreloom_reject_change('agent definition revisions are immutable');

CREATE TABLE IF NOT EXISTS agent_run_contracts (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  workflow_run_id TEXT,
  output_contract_json TEXT NOT NULL,
  structured_output_json TEXT,
  request_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_run_contracts_tenant_workflow_idx
  ON agent_run_contracts (tenant_id, workflow_run_id, run_id);
INSERT INTO agent_run_contracts
  (run_id, tenant_id, workflow_run_id, output_contract_json,
   structured_output_json, request_hash)
  SELECT id, tenant_id, NULL, '{"kind":"text"}', NULL,
         encode(sha256(gen_random_uuid()::text::bytea), 'hex')
  FROM agent_runs
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS agent_action_invocations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  node_run_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL CHECK (contract_version >= 1),
  actor_json TEXT NOT NULL,
  permission_snapshot_json TEXT NOT NULL,
  input_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  output_json TEXT,
  failure_code TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  queued_at BIGINT NOT NULL,
  started_at BIGINT,
  completed_at BIGINT,
  lease_owner TEXT,
  lease_expires_at BIGINT,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS agent_actions_tenant_workflow_idx
  ON agent_action_invocations (tenant_id, workflow_run_id, queued_at DESC, id);
CREATE INDEX IF NOT EXISTS agent_actions_recovery_idx
  ON agent_action_invocations (status, lease_expires_at, queued_at);
ALTER TABLE agent_definition_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_definition_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_definition_revisions_tenant_policy ON agent_definition_revisions
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE agent_run_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_contracts FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_run_contracts_tenant_policy ON agent_run_contracts
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE agent_action_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_action_invocations FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_action_invocations_tenant_policy ON agent_action_invocations
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
