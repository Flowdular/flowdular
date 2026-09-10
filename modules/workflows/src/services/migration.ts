import {
	migrationObjectState,
	postgresTenantTableState,
	type DatabaseMigration,
} from '@flowdular/database';

/* Mirrors migrations/0001_workflows_core.up.sql byte for byte. */
export const WORKFLOWS_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS workflow_definitions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workflow_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  current_draft_revision BIGINT NOT NULL CHECK (current_draft_revision >= 1),
  published_revision BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, workflow_key)
);
CREATE INDEX IF NOT EXISTS workflow_definitions_tenant_name_idx
  ON workflow_definitions (tenant_id, name, id);
ALTER TABLE workflow_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_definitions_tenant_policy ON workflow_definitions
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
CREATE TABLE IF NOT EXISTS workflow_revisions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision >= 1),
  graph_schema_version INTEGER NOT NULL CHECK (graph_schema_version = 1),
  graph_json TEXT NOT NULL,
  graph_checksum TEXT NOT NULL,
  compiler_version INTEGER NOT NULL CHECK (compiler_version = 1),
  compiled_order_json TEXT NOT NULL,
  published_at BIGINT,
  published_actor_json TEXT,
  created_at BIGINT NOT NULL,
  UNIQUE (tenant_id, workflow_id, revision)
);
CREATE INDEX IF NOT EXISTS workflow_revisions_tenant_workflow_idx
  ON workflow_revisions (tenant_id, workflow_id, revision, id);
ALTER TABLE workflow_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_revisions_tenant_policy ON workflow_revisions
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_key TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  workflow_revision BIGINT,
  graph_checksum TEXT NOT NULL,
  compiler_version INTEGER NOT NULL CHECK (compiler_version = 1),
  graph_json TEXT NOT NULL,
  compiled_order_json TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('simulate', 'live')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting-agent', 'waiting-retry', 'cancel-requested', 'succeeded', 'failed', 'refused', 'cancelled')),
  actor_json TEXT NOT NULL,
  origin_json TEXT NOT NULL,
  permission_snapshot_json TEXT NOT NULL,
  permission_digest TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  input_payload_id TEXT NOT NULL,
  input_evidence_json TEXT NOT NULL,
  output_evidence_json TEXT,
  idempotency_key TEXT,
  limits_json TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at BIGINT,
  completed_nodes INTEGER NOT NULL DEFAULT 0,
  total_nodes INTEGER NOT NULL,
  usage_json TEXT NOT NULL,
  cost_json TEXT NOT NULL,
  failure_code TEXT,
  queued_at BIGINT NOT NULL,
  started_at BIGINT,
  completed_at BIGINT,
  cancellation_requested_at BIGINT,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS workflow_runs_tenant_queue_idx
  ON workflow_runs (tenant_id, queued_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS workflow_runs_tenant_status_lease_idx
  ON workflow_runs (tenant_id, status, lease_expires_at, id);
ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_runs_tenant_policy ON workflow_runs
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
CREATE TABLE IF NOT EXISTS workflow_node_states (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'running', 'waiting-child', 'waiting-retry', 'succeeded', 'failed', 'refused', 'skipped', 'cancelled')),
  latest_attempt INTEGER NOT NULL DEFAULT 0,
  selected_outcome_port TEXT,
  next_attempt_at BIGINT,
  ready_at BIGINT,
  started_at BIGINT,
  settled_at BIGINT,
  PRIMARY KEY (tenant_id, run_id, node_id)
);
CREATE INDEX IF NOT EXISTS workflow_node_states_tenant_run_idx
  ON workflow_node_states (tenant_id, run_id, node_id);
ALTER TABLE workflow_node_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_node_states FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_node_states_tenant_policy ON workflow_node_states
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
CREATE TABLE IF NOT EXISTS workflow_node_attempts (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  node_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'waiting-child', 'succeeded', 'failed', 'refused', 'cancelled')),
  outcome_port TEXT,
  semantic_group TEXT NOT NULL,
  side_effect_idempotency_key TEXT NOT NULL,
  input_payload_id TEXT,
  output_payload_id TEXT,
  input_evidence_json TEXT NOT NULL,
  output_evidence_json TEXT NOT NULL,
  child_kind TEXT CHECK (child_kind IN ('agent', 'action')),
  child_id TEXT,
  child_observation_deadline_at BIGINT,
  failure_code TEXT,
  retry_classification TEXT CHECK (retry_classification IN ('retryable', 'permanent')),
  selected_backoff_ms BIGINT,
  next_attempt_at BIGINT,
  started_at BIGINT NOT NULL,
  completed_at BIGINT,
  duration_ms BIGINT,
  PRIMARY KEY (tenant_id, run_id, node_id, attempt)
);
CREATE INDEX IF NOT EXISTS workflow_node_attempts_tenant_run_idx
  ON workflow_node_attempts (tenant_id, run_id, node_id, attempt);
ALTER TABLE workflow_node_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_node_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_node_attempts_tenant_policy ON workflow_node_attempts
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
CREATE TABLE IF NOT EXISTS workflow_edge_transfers (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  source_port TEXT NOT NULL,
  source_attempt INTEGER,
  target_node_id TEXT NOT NULL,
  target_port TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('emitted', 'closed', 'skipped')),
  reason TEXT,
  schema_id TEXT NOT NULL,
  payload_id TEXT,
  evidence_json TEXT NOT NULL,
  settled_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, run_id, edge_id)
);
CREATE INDEX IF NOT EXISTS workflow_edge_transfers_tenant_run_idx
  ON workflow_edge_transfers (tenant_id, run_id, edge_id);
ALTER TABLE workflow_edge_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_edge_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_edge_transfers_tenant_policy ON workflow_edge_transfers
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
CREATE TABLE IF NOT EXISTS workflow_run_events (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence >= 1),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  recorded_at BIGINT NOT NULL,
  virtual_offset_ms BIGINT,
  UNIQUE (tenant_id, run_id, sequence)
);
CREATE INDEX IF NOT EXISTS workflow_run_events_tenant_run_idx
  ON workflow_run_events (tenant_id, run_id, sequence, event_id);
ALTER TABLE workflow_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_run_events FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_run_events_tenant_policy ON workflow_run_events
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
CREATE TABLE IF NOT EXISTS workflow_payloads (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('execution', 'evidence')),
  schema_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  original_byte_size BIGINT NOT NULL CHECK (original_byte_size >= 0),
  ciphertext TEXT,
  encryption_key_id TEXT,
  evidence_state TEXT CHECK (evidence_state IN ('available', 'redacted', 'truncated', 'expired', 'absent')),
  preview_json TEXT,
  redaction_reason TEXT,
  expires_at BIGINT,
  created_at BIGINT NOT NULL,
  CHECK ((kind = 'execution' AND ciphertext IS NOT NULL AND preview_json IS NULL) OR (kind = 'evidence' AND ciphertext IS NULL))
);
CREATE INDEX IF NOT EXISTS workflow_payloads_tenant_run_idx
  ON workflow_payloads (tenant_id, run_id, id);
ALTER TABLE workflow_payloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_payloads FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_payloads_tenant_policy ON workflow_payloads
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
CREATE TABLE IF NOT EXISTS workflow_audit_events (
  tenant_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence >= 1),
  actor_json TEXT NOT NULL,
  origin_json TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('workflow', 'workflow-run', 'workflow-node')),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  PRIMARY KEY (tenant_id, sequence)
);
CREATE INDEX IF NOT EXISTS workflow_audit_events_tenant_time_idx
  ON workflow_audit_events (tenant_id, occurred_at DESC, sequence DESC);
ALTER TABLE workflow_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_audit_events_tenant_policy ON workflow_audit_events
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/* Mirrors migrations/0002_workflows_authorization_subject.up.sql byte for byte. */
export const WORKFLOWS_MIGRATION_002 = `ALTER TABLE workflow_runs
  ADD COLUMN authorization_subject_json TEXT;
UPDATE workflow_runs
SET authorization_subject_json = CASE actor_json::jsonb ->> 'kind'
  WHEN 'user' THEN actor_json
  WHEN 'service' THEN actor_json::jsonb -> 'configuredBy' #>> '{}'
  ELSE NULL
END
WHERE authorization_subject_json IS NULL;
`;

/* Mirrors migrations/0003_workflows_worker_role.up.sql byte for byte. */
export const WORKFLOWS_MIGRATION_003 = `CREATE INDEX IF NOT EXISTS workflow_runs_claim_idx
  ON workflow_runs (mode, status, lease_expires_at, queued_at, id);
CREATE INDEX IF NOT EXISTS workflow_payloads_retention_idx
  ON workflow_payloads (kind, expires_at, id);
-- The worker has to find due work before it knows whose it is, and retention
-- sweeps every tenant. Both are granted exactly the columns that route the
-- work and nothing else: graphs, inputs, actors, permission snapshots and
-- payload ciphertext stay unreadable on this connection. Whatever acts on a
-- row reads it again under the tenant that row named.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY workflow_runs_background_policy ON workflow_runs
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON workflow_runs FROM coreloom_background;
GRANT SELECT (tenant_id, id, mode, status, lease_expires_at, queued_at)
  ON workflow_runs TO coreloom_background;
CREATE POLICY workflow_node_states_background_policy ON workflow_node_states
  FOR SELECT TO coreloom_background
  USING (status = 'waiting-retry');
REVOKE SELECT ON workflow_node_states FROM coreloom_background;
GRANT SELECT (tenant_id, run_id, status, next_attempt_at)
  ON workflow_node_states TO coreloom_background;
CREATE POLICY workflow_payloads_background_policy ON workflow_payloads
  FOR SELECT TO coreloom_background
  USING (kind = 'execution' AND expires_at IS NOT NULL);
REVOKE SELECT ON workflow_payloads FROM coreloom_background;
GRANT SELECT (tenant_id, id, run_id, kind, payload_hash, expires_at)
  ON workflow_payloads TO coreloom_background;
`;

const TENANT_TABLES: readonly (readonly [string, string, string])[] = [
	[
		'workflow_definitions',
		'workflow_definitions_tenant_policy',
		'workflow_definitions_tenant_name_idx',
	],
	[
		'workflow_revisions',
		'workflow_revisions_tenant_policy',
		'workflow_revisions_tenant_workflow_idx',
	],
	[
		'workflow_runs',
		'workflow_runs_tenant_policy',
		'workflow_runs_tenant_queue_idx',
	],
	[
		'workflow_node_states',
		'workflow_node_states_tenant_policy',
		'workflow_node_states_tenant_run_idx',
	],
	[
		'workflow_node_attempts',
		'workflow_node_attempts_tenant_policy',
		'workflow_node_attempts_tenant_run_idx',
	],
	[
		'workflow_edge_transfers',
		'workflow_edge_transfers_tenant_policy',
		'workflow_edge_transfers_tenant_run_idx',
	],
	[
		'workflow_run_events',
		'workflow_run_events_tenant_policy',
		'workflow_run_events_tenant_run_idx',
	],
	[
		'workflow_payloads',
		'workflow_payloads_tenant_policy',
		'workflow_payloads_tenant_run_idx',
	],
	[
		'workflow_audit_events',
		'workflow_audit_events_tenant_policy',
		'workflow_audit_events_tenant_time_idx',
	],
];

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_workflows_core',
		sql: { postgresql: WORKFLOWS_MIGRATION_001 },
		/* The migration creates nine tenant tables in one script, so adoption
		   holds only when every one of them, and its policy, is already there. */
		inspectExisting: async (database) => {
			const states = [];
			for (const [table, policy, index] of TENANT_TABLES) {
				states.push(
					await postgresTenantTableState(database, table, policy, [
						() => database.schema.hasIndex(index),
					]),
				);
			}
			if (states.every((state) => state === 'complete')) return 'complete';
			return states.every((state) => state === 'absent') ? 'absent' : 'partial';
		},
	},
	{
		id: '0002_workflows_authorization_subject',
		sql: { postgresql: WORKFLOWS_MIGRATION_002 },
		inspectExisting: (database) =>
			migrationObjectState([
				() =>
					database.schema.hasColumn(
						'workflow_runs',
						'authorization_subject_json',
					),
			]),
	},
	{
		id: '0003_workflows_worker_role',
		sql: { postgresql: WORKFLOWS_MIGRATION_003 },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasIndex('workflow_runs_claim_idx'),
				() => database.schema.hasIndex('workflow_payloads_retention_idx'),
			]),
	},
];
