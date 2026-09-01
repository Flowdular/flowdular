export const AGENTS_MIGRATION_001 = `
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
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 250 AND 300000),
  temperature_milli INTEGER NOT NULL CHECK (temperature_milli BETWEEN 0 AND 2000),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, agent_key)
) STRICT;
CREATE INDEX IF NOT EXISTS agent_definitions_tenant_name_idx
  ON agent_definitions (tenant_id, name, id);

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
  timeout_ms INTEGER NOT NULL,
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
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  FOREIGN KEY (agent_id) REFERENCES agent_definitions(id),
  UNIQUE (tenant_id, idempotency_key)
) STRICT;
CREATE INDEX IF NOT EXISTS agent_runs_tenant_queued_idx
  ON agent_runs (tenant_id, queued_at DESC, id);
CREATE INDEX IF NOT EXISTS agent_runs_recovery_idx
  ON agent_runs (status, lease_expires_at, queued_at);

CREATE TABLE IF NOT EXISTS agent_run_events (
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, sequence)
) STRICT;

CREATE TABLE IF NOT EXISTS agent_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('agent', 'agent-run')),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, event_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS agent_audit_tenant_time_idx
  ON agent_audit_events (tenant_id, occurred_at DESC, sequence DESC);
`;

export const AGENTS_MIGRATION_002 = `
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
  readiness_latency_ms INTEGER,
  readiness_error_code TEXT,
  readiness_checked_at INTEGER,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, provider_key)
) STRICT;
CREATE INDEX IF NOT EXISTS agent_provider_connections_tenant_name_idx
  ON agent_provider_connections (tenant_id, name, id);
`;

export const AGENTS_MIGRATION_003 = `
CREATE TABLE IF NOT EXISTS agent_audit_events_v2 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('agent', 'agent-run', 'agent-provider', 'agent-skill')),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, event_hash)
) STRICT;
INSERT OR IGNORE INTO agent_audit_events_v2
  SELECT * FROM agent_audit_events ORDER BY tenant_id, sequence;
CREATE INDEX IF NOT EXISTS agent_audit_v2_tenant_time_idx
  ON agent_audit_events_v2 (tenant_id, occurred_at DESC, sequence DESC);
`;

export const AGENTS_MIGRATION_004 = `
CREATE TABLE IF NOT EXISTS agent_run_grant_uses (
  grant_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS agent_run_grant_expiry_idx
  ON agent_run_grant_uses (expires_at);
`;

export const AGENTS_MIGRATION_005 = `
CREATE TABLE IF NOT EXISTS agent_definition_execution_limits (
  agent_id TEXT PRIMARY KEY REFERENCES agent_definitions(id) ON DELETE CASCADE,
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 250 AND 86400000)
) STRICT;
INSERT OR IGNORE INTO agent_definition_execution_limits (agent_id, timeout_ms)
  SELECT id, timeout_ms FROM agent_definitions;
CREATE TABLE IF NOT EXISTS agent_run_execution_limits (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 250 AND 86400000)
) STRICT;
INSERT OR IGNORE INTO agent_run_execution_limits (run_id, timeout_ms)
  SELECT id, timeout_ms FROM agent_runs;
`;

export const AGENTS_MIGRATION_006 = `
CREATE TABLE IF NOT EXISTS agent_skills (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  skill_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  required_tools_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, skill_key),
  UNIQUE (id, tenant_id)
) STRICT;
CREATE INDEX IF NOT EXISTS agent_skills_tenant_name_idx
  ON agent_skills (tenant_id, name, id);
CREATE TABLE IF NOT EXISTS agent_skill_assignments (
  agent_id TEXT NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  PRIMARY KEY (agent_id, skill_id),
  FOREIGN KEY (skill_id, tenant_id) REFERENCES agent_skills(id, tenant_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS agent_run_skill_snapshots (
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  skill_key TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  skill_revision INTEGER NOT NULL,
  required_tools_json TEXT NOT NULL,
  PRIMARY KEY (run_id, skill_id)
) STRICT;
`;

/* Readiness moves from the connection to the model that was actually proven.
   The connection columns stay as the last probe and seed this table once. */
export const AGENTS_MIGRATION_007 = `
CREATE TABLE IF NOT EXISTS agent_provider_model_readiness (
  provider_id TEXT NOT NULL REFERENCES agent_provider_connections(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'unhealthy')),
  latency_ms INTEGER,
  error_code TEXT,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model_id)
) STRICT;
INSERT OR IGNORE INTO agent_provider_model_readiness
  (provider_id, model_id, status, latency_ms, error_code, checked_at)
  SELECT id, readiness_model, readiness_status, readiness_latency_ms,
         readiness_error_code, readiness_checked_at
  FROM agent_provider_connections
  WHERE readiness_model IS NOT NULL
    AND readiness_checked_at IS NOT NULL
    AND readiness_status IN ('healthy', 'unhealthy');
`;

/* The provider default of 4096 output tokens was fixed in code. Absent rows
   keep that default; the tables follow the 005 side-table pattern because
   the runner cannot alter existing tables. */
export const AGENTS_MIGRATION_008 = `
CREATE TABLE IF NOT EXISTS agent_definition_output_limits (
  agent_id TEXT PRIMARY KEY REFERENCES agent_definitions(id) ON DELETE CASCADE,
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens BETWEEN 256 AND 65536)
) STRICT;
CREATE TABLE IF NOT EXISTS agent_run_output_limits (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens BETWEEN 256 AND 65536)
) STRICT;
`;
