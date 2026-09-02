import {
	MigrationError,
	normalizeActor,
	type Actor,
	type MigrationDatabase,
	type ModuleMigration,
} from '@coreloom/kernel';

/* Every constant mirrors its migrations/<id>.up.sql file byte for byte;
   tests/migrations.test.ts fails on drift. */

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
CREATE INDEX IF NOT EXISTS agent_runs_tenant_queued_idx ON agent_runs (tenant_id, queued_at DESC, id);
CREATE INDEX IF NOT EXISTS agent_runs_recovery_idx ON agent_runs (status, lease_expires_at, queued_at);

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
CREATE INDEX IF NOT EXISTS agent_audit_tenant_time_idx ON agent_audit_events (tenant_id, occurred_at DESC, sequence DESC);
`;

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

export const AGENTS_MIGRATION_003 = `CREATE TABLE IF NOT EXISTS agent_audit_events_v2 (
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

export const AGENTS_MIGRATION_004 = `CREATE TABLE IF NOT EXISTS agent_run_grant_uses (
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

export const AGENTS_MIGRATION_005 = `CREATE TABLE IF NOT EXISTS agent_definition_execution_limits (
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
  created_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, skill_key),
  UNIQUE (id, tenant_id)
) STRICT;
CREATE INDEX IF NOT EXISTS agent_skills_tenant_name_idx ON agent_skills (tenant_id, name, id);
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
export const AGENTS_MIGRATION_007 = `CREATE TABLE IF NOT EXISTS agent_provider_model_readiness (
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
export const AGENTS_MIGRATION_008 = `CREATE TABLE IF NOT EXISTS agent_definition_output_limits (
  agent_id TEXT PRIMARY KEY REFERENCES agent_definitions(id) ON DELETE CASCADE,
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens BETWEEN 256 AND 65536)
) STRICT;
CREATE TABLE IF NOT EXISTS agent_run_output_limits (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens BETWEEN 256 AND 65536)
) STRICT;
`;

const AGENT_AUDIT_V3_TABLE_SQL = `CREATE TABLE agent_audit_events_v3 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('agent', 'agent-run', 'agent-provider', 'agent-skill', 'agent-schedule', 'agent-trigger')),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, event_hash)
) STRICT`;

const AGENT_AUDIT_V3_INDEX_SQL = `CREATE INDEX agent_audit_v3_tenant_time_idx
  ON agent_audit_events_v3 (tenant_id, occurred_at DESC, sequence DESC)`;

export const AGENTS_MIGRATION_009 = `CREATE TABLE IF NOT EXISTS agent_audit_events_v3 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('agent', 'agent-run', 'agent-provider', 'agent-skill', 'agent-schedule', 'agent-trigger')),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, event_hash)
) STRICT;
INSERT OR IGNORE INTO agent_audit_events_v3
  SELECT * FROM agent_audit_events_v2 ORDER BY tenant_id, sequence;
CREATE INDEX IF NOT EXISTS agent_audit_v3_tenant_time_idx
  ON agent_audit_events_v3 (tenant_id, occurred_at DESC, sequence DESC);
`;

/* A projection of the usage a finished run reported, written once when the run
   completes. Aggregates read integer columns and a precomputed UTC day, so a
   tenant rollup is an index scan instead of a JSON parse per row. Runs that
   completed before this migration keep their tokens and stay unpriced. */
export const AGENTS_MIGRATION_012 = `CREATE TABLE IF NOT EXISTS agent_run_costs (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  model TEXT NOT NULL,
  day TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_micro_usd INTEGER,
  completed_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS agent_run_costs_tenant_day_idx
  ON agent_run_costs (tenant_id, day);
CREATE INDEX IF NOT EXISTS agent_run_costs_tenant_agent_idx
  ON agent_run_costs (tenant_id, agent_id, day);
INSERT OR IGNORE INTO agent_run_costs
  (run_id, tenant_id, agent_id, agent_name, model, day, input_tokens,
   output_tokens, cost_micro_usd, completed_at)
  SELECT id, tenant_id, agent_id, agent_name, model,
         strftime('%Y-%m-%d', completed_at / 1000, 'unixepoch'),
         CAST(COALESCE(json_extract(usage_json, '$.inputTokens'), 0) AS INTEGER),
         CAST(COALESCE(json_extract(usage_json, '$.outputTokens'), 0) AS INTEGER),
         NULL, completed_at
  FROM agent_runs
  WHERE status = 'succeeded' AND usage_json IS NOT NULL AND completed_at IS NOT NULL;
`;

export const AGENTS_MIGRATION_013 = `CREATE TABLE IF NOT EXISTS agent_definition_revisions (
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
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 250 AND 86400000),
  temperature_milli INTEGER NOT NULL CHECK (temperature_milli BETWEEN 0 AND 2000),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens BETWEEN 256 AND 65536),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  retained_by TEXT NOT NULL,
  retained_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, agent_id, revision)
) STRICT;
CREATE INDEX IF NOT EXISTS agent_definition_revisions_tenant_agent_idx
  ON agent_definition_revisions (tenant_id, agent_id, revision DESC);
CREATE TRIGGER IF NOT EXISTS agent_definition_revisions_no_update
  BEFORE UPDATE ON agent_definition_revisions
  BEGIN SELECT RAISE(ABORT, 'agent definition revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS agent_definition_revisions_no_delete
  BEFORE DELETE ON agent_definition_revisions
  BEGIN SELECT RAISE(ABORT, 'agent definition revisions are immutable'); END;

CREATE TABLE IF NOT EXISTS agent_run_contracts (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  workflow_run_id TEXT,
  output_contract_json TEXT NOT NULL,
  structured_output_json TEXT,
  request_hash TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS agent_run_contracts_tenant_workflow_idx
  ON agent_run_contracts (tenant_id, workflow_run_id, run_id);
INSERT OR IGNORE INTO agent_run_contracts
  (run_id, tenant_id, workflow_run_id, output_contract_json,
   structured_output_json, request_hash)
  SELECT id, tenant_id, NULL, '{"kind":"text"}', NULL,
         lower(hex(randomblob(32)))
  FROM agent_runs;

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
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  UNIQUE (tenant_id, idempotency_key)
) STRICT;
CREATE INDEX IF NOT EXISTS agent_actions_tenant_workflow_idx
  ON agent_action_invocations (tenant_id, workflow_run_id, queued_at DESC, id);
CREATE INDEX IF NOT EXISTS agent_actions_recovery_idx
  ON agent_action_invocations (status, lease_expires_at, queued_at);
`;

const AGENT_AUDIT_V4_TABLE_SQL = `CREATE TABLE agent_audit_events_v4 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('agent', 'agent-run', 'agent-provider', 'agent-skill', 'agent-schedule', 'agent-trigger', 'agent-action')),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, event_hash)
) STRICT`;

const AGENT_AUDIT_V4_INDEX_SQL = `CREATE INDEX agent_audit_v4_tenant_time_idx
  ON agent_audit_events_v4 (tenant_id, occurred_at DESC, sequence DESC)`;

export const AGENTS_MIGRATION_014 = `CREATE TABLE IF NOT EXISTS agent_audit_events_v4 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('agent', 'agent-run', 'agent-provider', 'agent-skill', 'agent-schedule', 'agent-trigger', 'agent-action')),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, event_hash)
) STRICT;
INSERT OR IGNORE INTO agent_audit_events_v4
  SELECT * FROM agent_audit_events_v3 ORDER BY tenant_id, sequence;
CREATE INDEX IF NOT EXISTS agent_audit_v4_tenant_time_idx
  ON agent_audit_events_v4 (tenant_id, occurred_at DESC, sequence DESC);
`;

const AGENT_RUN_ACTORS_TABLE_SQL = `CREATE TABLE agent_run_actors (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  actor_json TEXT NOT NULL CHECK (json_valid(actor_json) AND json_type(actor_json) = 'object')
) STRICT`;

const AGENT_RUN_ACTORS_INDEX_SQL = `CREATE INDEX agent_run_actors_tenant_idx
  ON agent_run_actors (tenant_id, run_id)`;

/* SQLite appends an ALTER TABLE column immediately before STRICT. Keep the
   exact post-0017 projection accepted when 0015 has no legacy ledger row. */
const AGENT_RUN_ACTORS_WITH_AUTHORIZATION_TABLE_SQL = `CREATE TABLE agent_run_actors (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  actor_json TEXT NOT NULL CHECK (json_valid(actor_json) AND json_type(actor_json) = 'object')
, authorization_subject_json TEXT CHECK (authorization_subject_json IS NULL OR (json_valid(authorization_subject_json) AND json_extract(authorization_subject_json, '$.kind') = 'user'))) STRICT`;

export const AGENTS_MIGRATION_015 = `CREATE TABLE IF NOT EXISTS agent_run_actors (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  actor_json TEXT NOT NULL CHECK (json_valid(actor_json) AND json_type(actor_json) = 'object')
) STRICT;
CREATE INDEX IF NOT EXISTS agent_run_actors_tenant_idx
  ON agent_run_actors (tenant_id, run_id);
INSERT OR IGNORE INTO agent_run_actors (run_id, tenant_id, actor_json)
  SELECT id, tenant_id,
         json_object('kind', 'user', 'id', requested_by, 'label', requested_by)
  FROM agent_runs;
`;

export const AGENTS_MIGRATION_016 = `CREATE TABLE IF NOT EXISTS module_agent_definitions (
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
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 250 AND 86400000),
  temperature_milli INTEGER NOT NULL CHECK (temperature_milli BETWEEN 0 AND 2000),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens BETWEEN 256 AND 65536),
  registered_at INTEGER NOT NULL,
  UNIQUE (module_id, agent_key)
) STRICT;

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
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, agent_id)
) STRICT;
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
) STRICT;
CREATE TRIGGER IF NOT EXISTS agent_revision_ownership_no_update
  BEFORE UPDATE ON agent_revision_ownership
  BEGIN SELECT RAISE(ABORT, 'agent revision ownership is immutable'); END;
CREATE TRIGGER IF NOT EXISTS agent_revision_ownership_no_delete
  BEFORE DELETE ON agent_revision_ownership
  BEGIN SELECT RAISE(ABORT, 'agent revision ownership is immutable'); END;
`;

/* Mirrors migrations/0017_agent_authorization_subjects.up.sql byte for byte. */
export const AGENTS_MIGRATION_017 = `ALTER TABLE agent_run_actors
  ADD COLUMN authorization_subject_json TEXT CHECK (authorization_subject_json IS NULL OR (json_valid(authorization_subject_json) AND json_extract(authorization_subject_json, '$.kind') = 'user'));
UPDATE agent_run_actors
SET authorization_subject_json = CASE json_extract(actor_json, '$.kind')
  WHEN 'user' THEN actor_json
  WHEN 'service' THEN json_extract(actor_json, '$.configuredBy')
  ELSE NULL
END
WHERE authorization_subject_json IS NULL;
ALTER TABLE agent_action_invocations
  ADD COLUMN authorization_subject_json TEXT CHECK (authorization_subject_json IS NULL OR (json_valid(authorization_subject_json) AND json_extract(authorization_subject_json, '$.kind') = 'user'));
UPDATE agent_action_invocations
SET authorization_subject_json = CASE json_extract(actor_json, '$.kind')
  WHEN 'user' THEN actor_json
  WHEN 'service' THEN json_extract(actor_json, '$.configuredBy')
  ELSE NULL
END
WHERE authorization_subject_json IS NULL;
`;

function normalizedSchema(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

function validateAuditProjection(
	database: MigrationDatabase,
	options: {
		readonly migrationId: string;
		readonly table: string;
		readonly index: string;
		readonly source: string;
		readonly expectedTableSql: string;
		readonly expectedIndexSql: string;
	},
): void {
	const table = database
		.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
		.get('table', options.table) as { readonly sql: string } | undefined;
	const index = database
		.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
		.get('index', options.index) as { readonly sql: string } | undefined;
	if (!table && !index) return;
	if (
		!table ||
		!index ||
		normalizedSchema(table.sql) !==
			normalizedSchema(options.expectedTableSql) ||
		normalizedSchema(index.sql) !== normalizedSchema(options.expectedIndexSql)
	) {
		throw new MigrationError(
			'PARTIAL_OBJECTS',
			options.migrationId,
			`Migration "${options.migrationId}" found an incompatible pre-ledger audit projection.`,
		);
	}
	const missingSourceRow = database
		.prepare(
			`SELECT 1 AS mismatch FROM (
			 SELECT * FROM ${options.source}
			 EXCEPT SELECT * FROM ${options.table}
			) LIMIT 1`,
		)
		.get();
	if (missingSourceRow) {
		throw new MigrationError(
			'PARTIAL_OBJECTS',
			options.migrationId,
			`Migration "${options.migrationId}" found an incomplete pre-ledger audit projection.`,
		);
	}
}

function validateAuditV3(database: MigrationDatabase): void {
	validateAuditProjection(database, {
		migrationId: '0009_agent_audit_v3',
		table: 'agent_audit_events_v3',
		index: 'agent_audit_v3_tenant_time_idx',
		source: 'agent_audit_events_v2',
		expectedTableSql: AGENT_AUDIT_V3_TABLE_SQL,
		expectedIndexSql: AGENT_AUDIT_V3_INDEX_SQL,
	});
}

function validateAuditV4(database: MigrationDatabase): void {
	validateAuditProjection(database, {
		migrationId: '0014_agent_action_audit',
		table: 'agent_audit_events_v4',
		index: 'agent_audit_v4_tenant_time_idx',
		source: 'agent_audit_events_v3',
		expectedTableSql: AGENT_AUDIT_V4_TABLE_SQL,
		expectedIndexSql: AGENT_AUDIT_V4_INDEX_SQL,
	});
}

/* 0015 contains a data backfill as well as DDL. An exact pre-ledger table may
   be completed by replaying the INSERT, but an incompatible or corrupt actor
   projection must never be silently adopted. */
function validateRunActors(database: MigrationDatabase): void {
	const table = database
		.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
		.get('table', 'agent_run_actors') as { readonly sql: string } | undefined;
	const index = database
		.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
		.get('index', 'agent_run_actors_tenant_idx') as
		| { readonly sql: string }
		| undefined;
	if (!table && !index) return;
	const tableSchema = table ? normalizedSchema(table.sql) : '';
	if (
		!table ||
		!index ||
		(tableSchema !== normalizedSchema(AGENT_RUN_ACTORS_TABLE_SQL) &&
			tableSchema !==
				normalizedSchema(AGENT_RUN_ACTORS_WITH_AUTHORIZATION_TABLE_SQL)) ||
		normalizedSchema(index.sql) !== normalizedSchema(AGENT_RUN_ACTORS_INDEX_SQL)
	) {
		throw new MigrationError(
			'PARTIAL_OBJECTS',
			'0015_agent_run_actors',
			'Migration "0015_agent_run_actors" found an incompatible pre-ledger actor projection.',
		);
	}
	const rows = database
		.prepare(
			`SELECT actors.run_id, actors.tenant_id, actors.actor_json,
			        runs.tenant_id AS run_tenant_id, runs.requested_by
			 FROM agent_run_actors AS actors
			 LEFT JOIN agent_runs AS runs ON runs.id = actors.run_id`,
		)
		.all() as readonly {
		readonly run_id: string;
		readonly tenant_id: string;
		readonly actor_json: string;
		readonly run_tenant_id: string | null;
		readonly requested_by: string | null;
	}[];
	for (const row of rows) {
		let actor: Actor | null = null;
		try {
			actor = normalizeActor(JSON.parse(row.actor_json) as Actor);
		} catch {
			/* Report every malformed JSON shape through the migration boundary. */
		}
		if (
			!actor ||
			row.run_tenant_id === null ||
			row.tenant_id !== row.run_tenant_id ||
			actor.id !== row.requested_by
		) {
			throw new MigrationError(
				'PARTIAL_OBJECTS',
				'0015_agent_run_actors',
				'Migration "0015_agent_run_actors" found an invalid pre-ledger actor row.',
			);
		}
	}
}

function hasCompleteRunActorBackfill(database: MigrationDatabase): boolean {
	return (
		database
			.prepare(
				`SELECT 1 AS missing
				 FROM agent_runs AS runs
				 LEFT JOIN agent_run_actors AS actors
				   ON actors.run_id = runs.id AND actors.tenant_id = runs.tenant_id
				 WHERE actors.run_id IS NULL
				 LIMIT 1`,
			)
			.get() === undefined
	);
}

export const migrations: readonly ModuleMigration[] = [
	{ id: '0001_agents_core', statements: AGENTS_MIGRATION_001 },
	{ id: '0002_provider_connections', statements: AGENTS_MIGRATION_002 },
	{ id: '0003_resource_audit', statements: AGENTS_MIGRATION_003 },
	{ id: '0004_run_grants', statements: AGENTS_MIGRATION_004 },
	{ id: '0005_long_running_limits', statements: AGENTS_MIGRATION_005 },
	{ id: '0006_agent_skills', statements: AGENTS_MIGRATION_006 },
	{ id: '0007_model_readiness', statements: AGENTS_MIGRATION_007 },
	{ id: '0008_output_limits', statements: AGENTS_MIGRATION_008 },
	{
		id: '0009_agent_audit_v3',
		statements: AGENTS_MIGRATION_009,
		validateExisting: validateAuditV3,
	},
	{ id: '0012_agent_run_costs', statements: AGENTS_MIGRATION_012 },
	{ id: '0013_workflow_prerequisites', statements: AGENTS_MIGRATION_013 },
	{
		id: '0014_agent_action_audit',
		statements: AGENTS_MIGRATION_014,
		validateExisting: validateAuditV4,
	},
	{
		id: '0015_agent_run_actors',
		statements: AGENTS_MIGRATION_015,
		validateExisting: validateRunActors,
		adoptWhen: hasCompleteRunActorBackfill,
	},
	{
		id: '0016_module_owned_agents',
		statements: AGENTS_MIGRATION_016,
	},
	{
		id: '0017_agent_authorization_subjects',
		statements: AGENTS_MIGRATION_017,
	},
];
