import {
	migrationObjectState,
	postgresTenantTableState,
	type DatabaseMigration,
	type DatabaseSession,
} from '@flowdular/database';

/* A grants-only migration leaves no table or column behind, so adoption of a
   pre-ledger schema is decided by the policy it installs. */
async function policyPresent(
	database: DatabaseSession,
	table: string,
	policy: string,
): Promise<boolean> {
	const result = await database.query<{ present: boolean }>({
		text: `SELECT EXISTS (
		         SELECT 1 FROM pg_policy
		         JOIN pg_class ON pg_class.oid = pg_policy.polrelid
		         JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
		         WHERE pg_namespace.nspname = current_schema()
		           AND pg_class.relname = $1 AND pg_policy.polname = $2
		       ) AS present`,
		parameters: [table, policy],
	});
	return result.rows[0]?.present === true;
}

/* Every constant mirrors its migrations/<id>.up.sql file byte for byte;
   tests/migrations.test.ts fails on drift. */

/* Mirrors migrations/0001_agents_core.up.sql byte for byte. */
export const AGENTS_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS agent_definitions (
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
`;

/* Mirrors migrations/0002_provider_connections.up.sql byte for byte. */
export const AGENTS_MIGRATION_002 = `CREATE TABLE IF NOT EXISTS agent_provider_connections (
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
`;

/* Mirrors migrations/0003_resource_audit.up.sql byte for byte. */
export const AGENTS_MIGRATION_003 = `CREATE TABLE IF NOT EXISTS agent_audit_events_v2 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('agent', 'agent-run', 'agent-provider', 'agent-skill')),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, event_hash)
);
INSERT INTO agent_audit_events_v2
  SELECT * FROM agent_audit_events ORDER BY tenant_id, sequence
ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS agent_audit_v2_tenant_time_idx
  ON agent_audit_events_v2 (tenant_id, occurred_at DESC, sequence DESC);
ALTER TABLE agent_audit_events_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_audit_events_v2 FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_audit_events_v2_tenant_policy ON agent_audit_events_v2
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/* Mirrors migrations/0004_run_grants.up.sql byte for byte. */
export const AGENTS_MIGRATION_004 = `CREATE TABLE IF NOT EXISTS agent_run_grant_uses (
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
`;

/* Mirrors migrations/0005_long_running_limits.up.sql byte for byte. */
export const AGENTS_MIGRATION_005 = `CREATE TABLE IF NOT EXISTS agent_definition_execution_limits (
  agent_id TEXT PRIMARY KEY REFERENCES agent_definitions(id) ON DELETE CASCADE,
  timeout_ms BIGINT NOT NULL CHECK (timeout_ms BETWEEN 250 AND 86400000)
);
INSERT INTO agent_definition_execution_limits (agent_id, timeout_ms)
  SELECT id, timeout_ms FROM agent_definitions
ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS agent_run_execution_limits (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  timeout_ms BIGINT NOT NULL CHECK (timeout_ms BETWEEN 250 AND 86400000)
);
INSERT INTO agent_run_execution_limits (run_id, timeout_ms)
  SELECT id, timeout_ms FROM agent_runs
ON CONFLICT DO NOTHING;
`;

/* Mirrors migrations/0006_agent_skills.up.sql byte for byte. */
export const AGENTS_MIGRATION_006 = `CREATE TABLE IF NOT EXISTS agent_skills (
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
  created_at BIGINT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, skill_key),
  UNIQUE (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS agent_skills_tenant_name_idx ON agent_skills (tenant_id, name, id);
CREATE TABLE IF NOT EXISTS agent_skill_assignments (
  agent_id TEXT NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  PRIMARY KEY (agent_id, skill_id),
  FOREIGN KEY (skill_id, tenant_id) REFERENCES agent_skills(id, tenant_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS agent_run_skill_snapshots (
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  skill_key TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  skill_revision INTEGER NOT NULL,
  required_tools_json TEXT NOT NULL,
  PRIMARY KEY (run_id, skill_id)
);
ALTER TABLE agent_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_skills FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_skills_tenant_policy ON agent_skills
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE agent_skill_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_skill_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_skill_assignments_tenant_policy ON agent_skill_assignments
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/* Mirrors migrations/0007_model_readiness.up.sql byte for byte. */
export const AGENTS_MIGRATION_007 = `CREATE TABLE IF NOT EXISTS agent_provider_model_readiness (
  provider_id TEXT NOT NULL REFERENCES agent_provider_connections(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'unhealthy')),
  latency_ms BIGINT,
  error_code TEXT,
  checked_at BIGINT NOT NULL,
  PRIMARY KEY (provider_id, model_id)
);
INSERT INTO agent_provider_model_readiness
  (provider_id, model_id, status, latency_ms, error_code, checked_at)
  SELECT id, readiness_model, readiness_status, readiness_latency_ms,
         readiness_error_code, readiness_checked_at
  FROM agent_provider_connections
  WHERE readiness_model IS NOT NULL
    AND readiness_checked_at IS NOT NULL
    AND readiness_status IN ('healthy', 'unhealthy')
ON CONFLICT DO NOTHING;
`;

/* Mirrors migrations/0008_output_limits.up.sql byte for byte. */
export const AGENTS_MIGRATION_008 = `CREATE TABLE IF NOT EXISTS agent_definition_output_limits (
  agent_id TEXT PRIMARY KEY REFERENCES agent_definitions(id) ON DELETE CASCADE,
  max_output_tokens BIGINT NOT NULL CHECK (max_output_tokens BETWEEN 256 AND 65536)
);
CREATE TABLE IF NOT EXISTS agent_run_output_limits (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  max_output_tokens BIGINT NOT NULL CHECK (max_output_tokens BETWEEN 256 AND 65536)
);
`;

/* Mirrors migrations/0009_agent_audit_v3.up.sql byte for byte. */
export const AGENTS_MIGRATION_009 = `CREATE TABLE IF NOT EXISTS agent_audit_events_v3 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('agent', 'agent-run', 'agent-provider', 'agent-skill', 'agent-schedule', 'agent-trigger')),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, event_hash)
);
INSERT INTO agent_audit_events_v3
  SELECT * FROM agent_audit_events_v2 ORDER BY tenant_id, sequence
ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS agent_audit_v3_tenant_time_idx
  ON agent_audit_events_v3 (tenant_id, occurred_at DESC, sequence DESC);
ALTER TABLE agent_audit_events_v3 ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_audit_events_v3 FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_audit_events_v3_tenant_policy ON agent_audit_events_v3
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/* Mirrors migrations/0012_agent_run_costs.up.sql byte for byte. */
export const AGENTS_MIGRATION_012 = `CREATE TABLE IF NOT EXISTS agent_run_costs (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  model TEXT NOT NULL,
  day TEXT NOT NULL,
  input_tokens BIGINT NOT NULL,
  output_tokens BIGINT NOT NULL,
  cost_micro_usd BIGINT,
  completed_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_run_costs_tenant_day_idx
  ON agent_run_costs (tenant_id, day);
CREATE INDEX IF NOT EXISTS agent_run_costs_tenant_agent_idx
  ON agent_run_costs (tenant_id, agent_id, day);
INSERT INTO agent_run_costs
  (run_id, tenant_id, agent_id, agent_name, model, day, input_tokens,
   output_tokens, cost_micro_usd, completed_at)
  SELECT id, tenant_id, agent_id, agent_name, model,
         to_char(to_timestamp(completed_at / 1000), 'YYYY-MM-DD'),
         COALESCE((usage_json::jsonb ->> 'inputTokens')::bigint, 0),
         COALESCE((usage_json::jsonb ->> 'outputTokens')::bigint, 0),
         NULL, completed_at
  FROM agent_runs
  WHERE status = 'succeeded' AND usage_json IS NOT NULL AND completed_at IS NOT NULL
ON CONFLICT DO NOTHING;
ALTER TABLE agent_run_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_costs FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_run_costs_tenant_policy ON agent_run_costs
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/* Mirrors migrations/0013_workflow_prerequisites.up.sql byte for byte. */
export const AGENTS_MIGRATION_013 = `-- SQLite expresses immutability with a BEFORE trigger that aborts. PostgreSQL
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
`;

/* Mirrors migrations/0014_agent_action_audit.up.sql byte for byte. */
export const AGENTS_MIGRATION_014 = `CREATE TABLE IF NOT EXISTS agent_audit_events_v4 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('agent', 'agent-run', 'agent-provider', 'agent-skill', 'agent-schedule', 'agent-trigger', 'agent-action')),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, event_hash)
);
INSERT INTO agent_audit_events_v4
  SELECT * FROM agent_audit_events_v3 ORDER BY tenant_id, sequence
ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS agent_audit_v4_tenant_time_idx
  ON agent_audit_events_v4 (tenant_id, occurred_at DESC, sequence DESC);
ALTER TABLE agent_audit_events_v4 ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_audit_events_v4 FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_audit_events_v4_tenant_policy ON agent_audit_events_v4
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/* Mirrors migrations/0015_agent_run_actors.up.sql byte for byte. */
export const AGENTS_MIGRATION_015 = `CREATE TABLE IF NOT EXISTS agent_run_actors (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  actor_json TEXT NOT NULL CHECK (actor_json IS JSON OBJECT)
);
CREATE INDEX IF NOT EXISTS agent_run_actors_tenant_idx
  ON agent_run_actors (tenant_id, run_id);
INSERT INTO agent_run_actors (run_id, tenant_id, actor_json)
  SELECT id, tenant_id,
         jsonb_build_object('kind', 'user', 'id', requested_by, 'label', requested_by)::text
  FROM agent_runs
ON CONFLICT DO NOTHING;
ALTER TABLE agent_run_actors ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_actors FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_run_actors_tenant_policy ON agent_run_actors
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/* Mirrors migrations/0016_module_owned_agents.up.sql byte for byte. */
export const AGENTS_MIGRATION_016 = `-- SQLite expresses immutability with a BEFORE trigger that aborts. PostgreSQL
-- needs a function to raise from, shared by every immutable table here.
CREATE OR REPLACE FUNCTION coreloom_reject_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '%', TG_ARGV[0];
END;
$$ LANGUAGE plpgsql;
CREATE TABLE IF NOT EXISTS module_agent_definitions (
  agent_id TEXT PRIMARY KEY REFERENCES agent_definitions(id),
  module_id TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  definition_revision INTEGER NOT NULL CHECK (definition_revision >= 1),
  content_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  allowed_tools_json TEXT NOT NULL,
  max_steps INTEGER NOT NULL CHECK (max_steps BETWEEN 1 AND 32),
  timeout_ms BIGINT NOT NULL CHECK (timeout_ms BETWEEN 250 AND 86400000),
  temperature_milli INTEGER NOT NULL CHECK (temperature_milli BETWEEN 0 AND 2000),
  max_output_tokens BIGINT NOT NULL CHECK (max_output_tokens BETWEEN 256 AND 65536),
  registered_at BIGINT NOT NULL,
  UNIQUE (module_id, agent_key)
);

CREATE TABLE IF NOT EXISTS module_agent_bindings (
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES module_agent_definitions(agent_id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  enabled_tools_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
  module_definition_revision INTEGER NOT NULL CHECK (module_definition_revision >= 1),
  executable_revision INTEGER NOT NULL CHECK (executable_revision >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_by TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, agent_id)
);
CREATE INDEX IF NOT EXISTS module_agent_bindings_tenant_status_idx
  ON module_agent_bindings (tenant_id, status, agent_id);

CREATE TABLE IF NOT EXISTS agent_revision_ownership (
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  module_id TEXT NOT NULL,
  module_definition_revision INTEGER NOT NULL CHECK (module_definition_revision >= 1),
  PRIMARY KEY (tenant_id, agent_id, revision),
  FOREIGN KEY (tenant_id, agent_id, revision)
    REFERENCES agent_definition_revisions (tenant_id, agent_id, revision)
);
CREATE TRIGGER agent_revision_ownership_no_update
  BEFORE UPDATE ON agent_revision_ownership
  FOR EACH ROW EXECUTE FUNCTION coreloom_reject_change('agent revision ownership is immutable');
CREATE TRIGGER agent_revision_ownership_no_delete
  BEFORE DELETE ON agent_revision_ownership
  FOR EACH ROW EXECUTE FUNCTION coreloom_reject_change('agent revision ownership is immutable');
ALTER TABLE module_agent_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_agent_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY module_agent_bindings_tenant_policy ON module_agent_bindings
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE agent_revision_ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_revision_ownership FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_revision_ownership_tenant_policy ON agent_revision_ownership
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/* Mirrors migrations/0017_agent_authorization_subjects.up.sql byte for byte. */
export const AGENTS_MIGRATION_017 = `ALTER TABLE agent_run_actors
  ADD COLUMN authorization_subject_json TEXT CHECK (authorization_subject_json IS NULL OR (authorization_subject_json IS JSON AND authorization_subject_json::jsonb ->> 'kind' = 'user'));
UPDATE agent_run_actors
SET authorization_subject_json = CASE actor_json::jsonb ->> 'kind'
  WHEN 'user' THEN actor_json
  WHEN 'service' THEN actor_json::jsonb ->> 'configuredBy'
  ELSE NULL
END
WHERE authorization_subject_json IS NULL;
ALTER TABLE agent_action_invocations
  ADD COLUMN authorization_subject_json TEXT CHECK (authorization_subject_json IS NULL OR (authorization_subject_json IS JSON AND authorization_subject_json::jsonb ->> 'kind' = 'user'));
UPDATE agent_action_invocations
SET authorization_subject_json = CASE actor_json::jsonb ->> 'kind'
  WHEN 'user' THEN actor_json
  WHEN 'service' THEN actor_json::jsonb ->> 'configuredBy'
  ELSE NULL
END
WHERE authorization_subject_json IS NULL;
`;

/* Mirrors migrations/0019_background_recovery_grants.up.sql byte for byte. */
export const AGENTS_MIGRATION_019 = `-- The worker recovery polls have to find interrupted work before they know
-- whose it is, so they read on the background role. That role gets no table
-- privilege by default: each table it may poll grants the routing columns it
-- needs and nothing else, under a policy of its own. Every claim that follows
-- runs on the tenant-scoped runtime role, under the tenant the row named.
CREATE POLICY agent_runs_background_policy ON agent_runs
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON agent_runs FROM coreloom_background;
GRANT SELECT (id, tenant_id, status, queued_at, lease_expires_at)
  ON agent_runs TO coreloom_background;
CREATE POLICY agent_action_invocations_background_policy ON agent_action_invocations
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON agent_action_invocations FROM coreloom_background;
GRANT SELECT (id, tenant_id, status, queued_at, lease_expires_at)
  ON agent_action_invocations TO coreloom_background;
`;

/* Mirrors migrations/0018_agent_child_tenant_isolation.up.sql byte for byte. */
export const AGENTS_MIGRATION_0018 = `-- These tables hang off a tenant-owned parent and were protected only by it.
-- A read by a caller-supplied parent id therefore crossed tenants with nothing
-- but application code in the way. Each one now carries its own tenant and the
-- same forced row security every other tenant table has, so a mistake in a
-- query cannot reach another workspace.
ALTER TABLE agent_definition_execution_limits ADD COLUMN tenant_id TEXT;
UPDATE agent_definition_execution_limits AS child
SET tenant_id = parent.tenant_id
FROM agent_definitions AS parent
WHERE parent.id = child.agent_id AND child.tenant_id IS NULL;
DELETE FROM agent_definition_execution_limits WHERE tenant_id IS NULL;
ALTER TABLE agent_definition_execution_limits ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE agent_definition_execution_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_definition_execution_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_definition_execution_limits_tenant_policy
  ON agent_definition_execution_limits
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

ALTER TABLE agent_definition_output_limits ADD COLUMN tenant_id TEXT;
UPDATE agent_definition_output_limits AS child
SET tenant_id = parent.tenant_id
FROM agent_definitions AS parent
WHERE parent.id = child.agent_id AND child.tenant_id IS NULL;
DELETE FROM agent_definition_output_limits WHERE tenant_id IS NULL;
ALTER TABLE agent_definition_output_limits ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE agent_definition_output_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_definition_output_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_definition_output_limits_tenant_policy
  ON agent_definition_output_limits
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

ALTER TABLE agent_run_execution_limits ADD COLUMN tenant_id TEXT;
UPDATE agent_run_execution_limits AS child
SET tenant_id = parent.tenant_id
FROM agent_runs AS parent
WHERE parent.id = child.run_id AND child.tenant_id IS NULL;
DELETE FROM agent_run_execution_limits WHERE tenant_id IS NULL;
ALTER TABLE agent_run_execution_limits ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE agent_run_execution_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_execution_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_run_execution_limits_tenant_policy
  ON agent_run_execution_limits
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

ALTER TABLE agent_run_output_limits ADD COLUMN tenant_id TEXT;
UPDATE agent_run_output_limits AS child
SET tenant_id = parent.tenant_id
FROM agent_runs AS parent
WHERE parent.id = child.run_id AND child.tenant_id IS NULL;
DELETE FROM agent_run_output_limits WHERE tenant_id IS NULL;
ALTER TABLE agent_run_output_limits ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE agent_run_output_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_output_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_run_output_limits_tenant_policy
  ON agent_run_output_limits
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

ALTER TABLE agent_run_skill_snapshots ADD COLUMN tenant_id TEXT;
UPDATE agent_run_skill_snapshots AS child
SET tenant_id = parent.tenant_id
FROM agent_runs AS parent
WHERE parent.id = child.run_id AND child.tenant_id IS NULL;
DELETE FROM agent_run_skill_snapshots WHERE tenant_id IS NULL;
ALTER TABLE agent_run_skill_snapshots ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE agent_run_skill_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_skill_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_run_skill_snapshots_tenant_policy
  ON agent_run_skill_snapshots
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

ALTER TABLE agent_provider_model_readiness ADD COLUMN tenant_id TEXT;
UPDATE agent_provider_model_readiness AS child
SET tenant_id = parent.tenant_id
FROM agent_provider_connections AS parent
WHERE parent.id = child.provider_id AND child.tenant_id IS NULL;
DELETE FROM agent_provider_model_readiness WHERE tenant_id IS NULL;
ALTER TABLE agent_provider_model_readiness ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE agent_provider_model_readiness ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_provider_model_readiness FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_provider_model_readiness_tenant_policy
  ON agent_provider_model_readiness
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/* Mirrors migrations/0020_provider_summary_role.up.sql byte for byte. */
export const AGENTS_MIGRATION_0020 = `-- The operator status command counts provider connections across the whole
-- deployment, which the tenant-scoped runtime role cannot do and should not.
-- It reads the one flag the count needs, under a policy of this table's own,
-- and never sees a name, a base URL or an encrypted credential.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY agent_provider_connections_background_policy
  ON agent_provider_connections
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON agent_provider_connections FROM coreloom_background;
GRANT SELECT (id, enabled) ON agent_provider_connections TO coreloom_background;
`;

export const AGENTS_MIGRATION_0021 = `-- Discover only tenant routing keys; boot-time writes still use tenant transactions.
CREATE POLICY agent_definitions_reconciliation_policy ON agent_definitions
  FOR SELECT TO coreloom_background USING (true);
GRANT SELECT (tenant_id) ON agent_definitions TO coreloom_background;
CREATE POLICY module_agent_bindings_reconciliation_policy ON module_agent_bindings
  FOR SELECT TO coreloom_background USING (true);
GRANT SELECT (tenant_id, agent_id) ON module_agent_bindings TO coreloom_background;
`;

export const AGENTS_MIGRATION_0022 = `-- The rotation command has to find the connections still sealed with a retired
-- key before it knows whose they are. It is granted the routing columns and the
-- key id alone: the nonce, the tag and the ciphertext stay unreadable on this
-- connection, and every row it re-seals is read again under the tenant that row
-- named.
GRANT SELECT (tenant_id, credential_key_id)
  ON agent_provider_connections TO coreloom_background;
`;

/* Mirrors migrations/0023_agents_retention_indexes.up.sql byte for byte. */
export const AGENTS_MIGRATION_0023 = `-- The retention sweep of agents.core.runs asks one workspace for its oldest
-- settled runs, and a subject erasure asks it for the runs one account
-- requested. Both are bounded batches, so both need a range scan rather than a
-- pass over the workspace's runs; the export walks the order
-- agent_runs_tenant_queued_idx already carries and needs no index of its own.
CREATE INDEX IF NOT EXISTS agent_runs_tenant_settled_idx
  ON agent_runs (tenant_id, completed_at);
CREATE INDEX IF NOT EXISTS agent_runs_tenant_requested_idx
  ON agent_runs (tenant_id, requested_by, id);
`;

/* Mirrors migrations/0024_agent_meter_refusals.up.sql byte for byte. */
export const AGENTS_MIGRATION_0024 = `-- A meter refusal stands until the workspace's month turns or its limit is
-- raised, so recording it on every refused enqueue wrote the same fact to the
-- hash-chained trail as fast as a caller could retry. This row is the claim
-- that the refusal has already been recorded: the first refusal of a workspace,
-- a meter and a month takes it and writes the audit event, and every refusal
-- behind it is answered without touching the trail.
--
-- One row per workspace and meter at a time. The claim removes the rows of
-- earlier months for that workspace and meter in the same transaction, so the
-- table is bounded by the meters agents.core declares rather than by time.
CREATE TABLE IF NOT EXISTS agent_meter_refusals (
  tenant_id TEXT NOT NULL,
  meter TEXT NOT NULL,
  period TEXT NOT NULL,
  first_refused_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, meter, period)
);
ALTER TABLE agent_meter_refusals ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_meter_refusals FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_meter_refusals_tenant_policy ON agent_meter_refusals
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_agents_core',
		sql: { postgresql: AGENTS_MIGRATION_001 },
		inspectExisting: async (database) => {
			const states = [
				await postgresTenantTableState(
					database,
					'agent_definitions',
					'agent_definitions_tenant_policy',
					[],
				),
				await postgresTenantTableState(
					database,
					'agent_runs',
					'agent_runs_tenant_policy',
					[],
				),
				await postgresTenantTableState(
					database,
					'agent_run_events',
					'agent_run_events_tenant_policy',
					[],
				),
				await postgresTenantTableState(
					database,
					'agent_audit_events',
					'agent_audit_events_tenant_policy',
					[],
				),
				await migrationObjectState([
					() => database.schema.hasIndex('agent_audit_tenant_time_idx'),
					() => database.schema.hasIndex('agent_definitions_tenant_name_idx'),
					() => database.schema.hasIndex('agent_runs_recovery_idx'),
					() => database.schema.hasIndex('agent_runs_tenant_queued_idx'),
				]),
			];
			if (states.every((state) => state === 'complete')) return 'complete';
			return states.every((state) => state === 'absent') ? 'absent' : 'partial';
		},
	},
	{
		id: '0002_provider_connections',
		sql: { postgresql: AGENTS_MIGRATION_002 },
		inspectExisting: async (database) => {
			const states = [
				await postgresTenantTableState(
					database,
					'agent_provider_connections',
					'agent_provider_connections_tenant_policy',
					[],
				),
				await migrationObjectState([
					() =>
						database.schema.hasIndex(
							'agent_provider_connections_tenant_name_idx',
						),
				]),
			];
			if (states.every((state) => state === 'complete')) return 'complete';
			return states.every((state) => state === 'absent') ? 'absent' : 'partial';
		},
	},
	{
		id: '0003_resource_audit',
		sql: { postgresql: AGENTS_MIGRATION_003 },
		inspectExisting: async (database) => {
			const states = [
				await postgresTenantTableState(
					database,
					'agent_audit_events_v2',
					'agent_audit_events_v2_tenant_policy',
					[],
				),
				await migrationObjectState([
					() => database.schema.hasIndex('agent_audit_v2_tenant_time_idx'),
				]),
			];
			if (states.every((state) => state === 'complete')) return 'complete';
			return states.every((state) => state === 'absent') ? 'absent' : 'partial';
		},
	},
	{
		id: '0004_run_grants',
		sql: { postgresql: AGENTS_MIGRATION_004 },
		inspectExisting: async (database) => {
			const states = [
				await postgresTenantTableState(
					database,
					'agent_run_grant_uses',
					'agent_run_grant_uses_tenant_policy',
					[],
				),
				await migrationObjectState([
					() => database.schema.hasIndex('agent_run_grant_expiry_idx'),
				]),
			];
			if (states.every((state) => state === 'complete')) return 'complete';
			return states.every((state) => state === 'absent') ? 'absent' : 'partial';
		},
	},
	{
		id: '0005_long_running_limits',
		sql: { postgresql: AGENTS_MIGRATION_005 },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasTable('agent_definition_execution_limits'),
				() => database.schema.hasTable('agent_run_execution_limits'),
			]),
	},
	{
		id: '0006_agent_skills',
		sql: { postgresql: AGENTS_MIGRATION_006 },
		inspectExisting: async (database) => {
			const states = [
				await postgresTenantTableState(
					database,
					'agent_skills',
					'agent_skills_tenant_policy',
					[],
				),
				await postgresTenantTableState(
					database,
					'agent_skill_assignments',
					'agent_skill_assignments_tenant_policy',
					[],
				),
				await migrationObjectState([
					() => database.schema.hasTable('agent_run_skill_snapshots'),
					() => database.schema.hasIndex('agent_skills_tenant_name_idx'),
				]),
			];
			if (states.every((state) => state === 'complete')) return 'complete';
			return states.every((state) => state === 'absent') ? 'absent' : 'partial';
		},
	},
	{
		id: '0007_model_readiness',
		sql: { postgresql: AGENTS_MIGRATION_007 },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasTable('agent_provider_model_readiness'),
			]),
	},
	{
		id: '0008_output_limits',
		sql: { postgresql: AGENTS_MIGRATION_008 },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasTable('agent_definition_output_limits'),
				() => database.schema.hasTable('agent_run_output_limits'),
			]),
	},
	{
		id: '0009_agent_audit_v3',
		sql: { postgresql: AGENTS_MIGRATION_009 },
		inspectExisting: async (database) => {
			const states = [
				await postgresTenantTableState(
					database,
					'agent_audit_events_v3',
					'agent_audit_events_v3_tenant_policy',
					[],
				),
				await migrationObjectState([
					() => database.schema.hasIndex('agent_audit_v3_tenant_time_idx'),
				]),
			];
			if (states.every((state) => state === 'complete')) return 'complete';
			return states.every((state) => state === 'absent') ? 'absent' : 'partial';
		},
	},
	{
		id: '0012_agent_run_costs',
		sql: { postgresql: AGENTS_MIGRATION_012 },
		inspectExisting: async (database) => {
			const states = [
				await postgresTenantTableState(
					database,
					'agent_run_costs',
					'agent_run_costs_tenant_policy',
					[],
				),
				await migrationObjectState([
					() => database.schema.hasIndex('agent_run_costs_tenant_agent_idx'),
					() => database.schema.hasIndex('agent_run_costs_tenant_day_idx'),
				]),
			];
			if (states.every((state) => state === 'complete')) return 'complete';
			return states.every((state) => state === 'absent') ? 'absent' : 'partial';
		},
	},
	{
		id: '0013_workflow_prerequisites',
		sql: { postgresql: AGENTS_MIGRATION_013 },
		inspectExisting: async (database) => {
			const states = [
				await postgresTenantTableState(
					database,
					'agent_definition_revisions',
					'agent_definition_revisions_tenant_policy',
					[],
				),
				await postgresTenantTableState(
					database,
					'agent_run_contracts',
					'agent_run_contracts_tenant_policy',
					[],
				),
				await postgresTenantTableState(
					database,
					'agent_action_invocations',
					'agent_action_invocations_tenant_policy',
					[],
				),
				await migrationObjectState([
					() => database.schema.hasIndex('agent_actions_recovery_idx'),
					() => database.schema.hasIndex('agent_actions_tenant_workflow_idx'),
					() =>
						database.schema.hasIndex(
							'agent_definition_revisions_tenant_agent_idx',
						),
					() =>
						database.schema.hasIndex('agent_run_contracts_tenant_workflow_idx'),
				]),
			];
			if (states.every((state) => state === 'complete')) return 'complete';
			return states.every((state) => state === 'absent') ? 'absent' : 'partial';
		},
	},
	{
		id: '0014_agent_action_audit',
		sql: { postgresql: AGENTS_MIGRATION_014 },
		inspectExisting: async (database) => {
			const states = [
				await postgresTenantTableState(
					database,
					'agent_audit_events_v4',
					'agent_audit_events_v4_tenant_policy',
					[],
				),
				await migrationObjectState([
					() => database.schema.hasIndex('agent_audit_v4_tenant_time_idx'),
				]),
			];
			if (states.every((state) => state === 'complete')) return 'complete';
			return states.every((state) => state === 'absent') ? 'absent' : 'partial';
		},
	},
	{
		id: '0015_agent_run_actors',
		sql: { postgresql: AGENTS_MIGRATION_015 },
		inspectExisting: async (database) => {
			const states = [
				await postgresTenantTableState(
					database,
					'agent_run_actors',
					'agent_run_actors_tenant_policy',
					[],
				),
				await migrationObjectState([
					() => database.schema.hasIndex('agent_run_actors_tenant_idx'),
				]),
			];
			if (states.every((state) => state === 'complete')) return 'complete';
			return states.every((state) => state === 'absent') ? 'absent' : 'partial';
		},
	},
	{
		id: '0016_module_owned_agents',
		sql: { postgresql: AGENTS_MIGRATION_016 },
		inspectExisting: async (database) => {
			const states = [
				await postgresTenantTableState(
					database,
					'module_agent_bindings',
					'module_agent_bindings_tenant_policy',
					[],
				),
				await postgresTenantTableState(
					database,
					'agent_revision_ownership',
					'agent_revision_ownership_tenant_policy',
					[],
				),
				await migrationObjectState([
					() => database.schema.hasTable('module_agent_definitions'),
					() =>
						database.schema.hasIndex('module_agent_bindings_tenant_status_idx'),
				]),
			];
			if (states.every((state) => state === 'complete')) return 'complete';
			return states.every((state) => state === 'absent') ? 'absent' : 'partial';
		},
	},
	{
		id: '0017_agent_authorization_subjects',
		sql: { postgresql: AGENTS_MIGRATION_017 },
		inspectExisting: (database) =>
			migrationObjectState([
				() =>
					database.schema.hasColumn(
						'agent_run_actors',
						'authorization_subject_json',
					),
				() =>
					database.schema.hasColumn(
						'agent_action_invocations',
						'authorization_subject_json',
					),
			]),
	},
	{
		id: '0018_agent_child_tenant_isolation',
		sql: { postgresql: AGENTS_MIGRATION_0018 },
		inspectExisting: (database) =>
			migrationObjectState([
				() =>
					database.schema.hasColumn('agent_run_skill_snapshots', 'tenant_id'),
				() =>
					database.schema.hasColumn(
						'agent_provider_model_readiness',
						'tenant_id',
					),
			]),
	},
	{
		id: '0019_background_recovery_grants',
		sql: { postgresql: AGENTS_MIGRATION_019 },
		inspectExisting: (database) =>
			migrationObjectState([
				() =>
					policyPresent(database, 'agent_runs', 'agent_runs_background_policy'),
				() =>
					policyPresent(
						database,
						'agent_action_invocations',
						'agent_action_invocations_background_policy',
					),
			]),
	},
	{
		id: '0020_provider_summary_role',
		sql: { postgresql: AGENTS_MIGRATION_0020 },
		/* Only the policy proves this migration ran; it creates no object the
		   schema reader can see. */
		inspectExisting: (database) =>
			migrationObjectState([
				() =>
					policyPresent(
						database,
						'agent_provider_connections',
						'agent_provider_connections_background_policy',
					),
			]),
	},
	{
		id: '0021_agents_agent_reconciliation_role',
		sql: { postgresql: AGENTS_MIGRATION_0021 },
		inspectExisting: (database) =>
			migrationObjectState([
				() =>
					policyPresent(
						database,
						'agent_definitions',
						'agent_definitions_reconciliation_policy',
					),
				() =>
					policyPresent(
						database,
						'module_agent_bindings',
						'module_agent_bindings_reconciliation_policy',
					),
				async () => {
					const result = await database.query<{ granted: boolean }>({
						text: `SELECT CASE WHEN to_regclass('agent_definitions') IS NOT NULL
						AND to_regclass('module_agent_bindings') IS NOT NULL THEN
						  has_column_privilege('coreloom_background', 'agent_definitions', 'tenant_id', 'SELECT')
						  AND has_column_privilege('coreloom_background', 'module_agent_bindings', 'tenant_id', 'SELECT')
						  AND has_column_privilege('coreloom_background', 'module_agent_bindings', 'agent_id', 'SELECT')
						ELSE false END AS granted`,
					});
					return result.rows[0]?.granted === true;
				},
			]),
	},
	{
		id: '0022_credential_rotation_inventory',
		sql: { postgresql: AGENTS_MIGRATION_0022 },
		/* A grant leaves no object behind, so the column privilege itself is what
		   proves this migration ran. */
		inspectExisting: (database) =>
			migrationObjectState([
				async () => {
					const result = await database.query<{ granted: boolean }>({
						text: `SELECT CASE WHEN to_regclass('agent_provider_connections') IS NOT NULL THEN
						  has_column_privilege('coreloom_background', 'agent_provider_connections', 'tenant_id', 'SELECT')
						  AND has_column_privilege('coreloom_background', 'agent_provider_connections', 'credential_key_id', 'SELECT')
						ELSE false END AS granted`,
					});
					return result.rows[0]?.granted === true;
				},
			]),
	},
	{
		id: '0023_agents_retention_indexes',
		sql: { postgresql: AGENTS_MIGRATION_0023 },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasIndex('agent_runs_tenant_settled_idx'),
				() => database.schema.hasIndex('agent_runs_tenant_requested_idx'),
			]),
	},

	{
		id: '0024_agent_meter_refusals',
		sql: { postgresql: AGENTS_MIGRATION_0024 },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'agent_meter_refusals',
				'agent_meter_refusals_tenant_policy',
				[],
			),
	},
];
