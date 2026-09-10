CREATE TABLE IF NOT EXISTS agent_definitions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  allowed_tools_json TEXT NOT NULL,
  max_steps INTEGER NOT NULL CHECK (max_steps BETWEEN 1 AND 32),
  timeout_ms BIGINT NOT NULL CHECK (timeout_ms BETWEEN 250 AND 300000),
  temperature_milli INTEGER NOT NULL CHECK (temperature_milli BETWEEN 0 AND 2000),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, agent_key)
);
CREATE INDEX IF NOT EXISTS agent_definitions_tenant_name_idx ON agent_definitions (tenant_id, name, id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agent_revision INTEGER NOT NULL,
  instructions_snapshot TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  allowed_tools_json TEXT NOT NULL,
  max_steps INTEGER NOT NULL,
  timeout_ms BIGINT NOT NULL,
  temperature_milli INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('playground', 'workflow', 'service', 'schedule')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  input TEXT NOT NULL,
  output TEXT,
  requested_by TEXT NOT NULL,
  permission_snapshot_json TEXT NOT NULL,
  tool_grants_json TEXT NOT NULL,
  usage_json TEXT,
  failure_code TEXT,
  failure_message TEXT,
  idempotency_key TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  queued_at BIGINT NOT NULL,
  started_at BIGINT,
  completed_at BIGINT,
  lease_owner TEXT,
  lease_expires_at BIGINT,
  FOREIGN KEY (agent_id) REFERENCES agent_definitions(id),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS agent_runs_tenant_queued_idx ON agent_runs (tenant_id, queued_at DESC, id);
CREATE INDEX IF NOT EXISTS agent_runs_recovery_idx ON agent_runs (status, lease_expires_at, queued_at);

CREATE TABLE IF NOT EXISTS agent_run_events (
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  PRIMARY KEY (run_id, sequence)
);

CREATE TABLE IF NOT EXISTS agent_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('agent', 'agent-run')),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, event_hash)
);
CREATE INDEX IF NOT EXISTS agent_audit_tenant_time_idx ON agent_audit_events (tenant_id, occurred_at DESC, sequence DESC);
ALTER TABLE agent_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_definitions_tenant_policy ON agent_definitions
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_runs_tenant_policy ON agent_runs
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE agent_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_events FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_run_events_tenant_policy ON agent_run_events
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE agent_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_audit_events_tenant_policy ON agent_audit_events
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
