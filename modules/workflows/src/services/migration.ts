import type { ModuleMigration } from '@coreloom/kernel';

/* Mirrors migrations/0001_workflows_core.up.sql byte for byte. */
export const WORKFLOWS_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS workflow_definitions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workflow_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  current_draft_revision INTEGER NOT NULL CHECK (current_draft_revision >= 1),
  published_revision INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, workflow_key)
) STRICT;
CREATE INDEX IF NOT EXISTS workflow_definitions_tenant_name_idx
  ON workflow_definitions (tenant_id, name, id);
CREATE TABLE IF NOT EXISTS workflow_revisions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  graph_schema_version INTEGER NOT NULL CHECK (graph_schema_version = 1),
  graph_json TEXT NOT NULL,
  graph_checksum TEXT NOT NULL,
  compiler_version INTEGER NOT NULL CHECK (compiler_version = 1),
  compiled_order_json TEXT NOT NULL,
  published_at INTEGER,
  published_actor_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, workflow_id, revision)
) STRICT;
CREATE INDEX IF NOT EXISTS workflow_revisions_tenant_workflow_idx
  ON workflow_revisions (tenant_id, workflow_id, revision, id);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_key TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  workflow_revision INTEGER,
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
  lease_expires_at INTEGER,
  completed_nodes INTEGER NOT NULL DEFAULT 0,
  total_nodes INTEGER NOT NULL,
  usage_json TEXT NOT NULL,
  cost_json TEXT NOT NULL,
  failure_code TEXT,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  cancellation_requested_at INTEGER,
  UNIQUE (tenant_id, idempotency_key)
) STRICT;
CREATE INDEX IF NOT EXISTS workflow_runs_tenant_queue_idx
  ON workflow_runs (tenant_id, queued_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS workflow_runs_tenant_status_lease_idx
  ON workflow_runs (tenant_id, status, lease_expires_at, id);
CREATE TABLE IF NOT EXISTS workflow_node_states (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'running', 'waiting-child', 'waiting-retry', 'succeeded', 'failed', 'refused', 'skipped', 'cancelled')),
  latest_attempt INTEGER NOT NULL DEFAULT 0,
  selected_outcome_port TEXT,
  next_attempt_at INTEGER,
  ready_at INTEGER,
  started_at INTEGER,
  settled_at INTEGER,
  PRIMARY KEY (tenant_id, run_id, node_id)
) STRICT;
CREATE INDEX IF NOT EXISTS workflow_node_states_tenant_run_idx
  ON workflow_node_states (tenant_id, run_id, node_id);
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
  child_observation_deadline_at INTEGER,
  failure_code TEXT,
  retry_classification TEXT CHECK (retry_classification IN ('retryable', 'permanent')),
  selected_backoff_ms INTEGER,
  next_attempt_at INTEGER,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  duration_ms INTEGER,
  PRIMARY KEY (tenant_id, run_id, node_id, attempt)
) STRICT;
CREATE INDEX IF NOT EXISTS workflow_node_attempts_tenant_run_idx
  ON workflow_node_attempts (tenant_id, run_id, node_id, attempt);
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
  settled_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, run_id, edge_id)
) STRICT;
CREATE INDEX IF NOT EXISTS workflow_edge_transfers_tenant_run_idx
  ON workflow_edge_transfers (tenant_id, run_id, edge_id);
CREATE TABLE IF NOT EXISTS workflow_run_events (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  virtual_offset_ms INTEGER,
  UNIQUE (tenant_id, run_id, sequence)
) STRICT;
CREATE INDEX IF NOT EXISTS workflow_run_events_tenant_run_idx
  ON workflow_run_events (tenant_id, run_id, sequence, event_id);
CREATE TABLE IF NOT EXISTS workflow_payloads (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('execution', 'evidence')),
  schema_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  original_byte_size INTEGER NOT NULL CHECK (original_byte_size >= 0),
  ciphertext TEXT,
  encryption_key_id TEXT,
  evidence_state TEXT CHECK (evidence_state IN ('available', 'redacted', 'truncated', 'expired', 'absent')),
  preview_json TEXT,
  redaction_reason TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK ((kind = 'execution' AND ciphertext IS NOT NULL AND preview_json IS NULL) OR (kind = 'evidence' AND ciphertext IS NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS workflow_payloads_tenant_run_idx
  ON workflow_payloads (tenant_id, run_id, id);
CREATE TABLE IF NOT EXISTS workflow_audit_events (
  tenant_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  actor_json TEXT NOT NULL,
  origin_json TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('workflow', 'workflow-run', 'workflow-node')),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  PRIMARY KEY (tenant_id, sequence)
) STRICT;
CREATE INDEX IF NOT EXISTS workflow_audit_events_tenant_time_idx
  ON workflow_audit_events (tenant_id, occurred_at DESC, sequence DESC);
`;

/* Mirrors migrations/0002_workflows_authorization_subject.up.sql byte for byte. */
export const WORKFLOWS_MIGRATION_002 = `ALTER TABLE workflow_runs
  ADD COLUMN authorization_subject_json TEXT;
UPDATE workflow_runs
SET authorization_subject_json = CASE json_extract(actor_json, '$.kind')
  WHEN 'user' THEN actor_json
  WHEN 'service' THEN json_extract(actor_json, '$.configuredBy')
  ELSE NULL
END
WHERE authorization_subject_json IS NULL;
`;

export const migrations: readonly ModuleMigration[] = [
	{ id: '0001_workflows_core', statements: WORKFLOWS_MIGRATION_001 },
	{
		id: '0002_workflows_authorization_subject',
		statements: WORKFLOWS_MIGRATION_002,
	},
];
