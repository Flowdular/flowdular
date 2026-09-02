import type { ModuleMigration } from '@coreloom/kernel';

/* Mirrors migrations/0001_automations_core.up.sql byte for byte. */
export const AUTOMATIONS_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS automations_schedules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  label TEXT NOT NULL,
  input_template TEXT NOT NULL,
  cadence TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  disabled_reason TEXT,
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  last_run_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS automations_schedules_tenant_label_idx
  ON automations_schedules (tenant_id, label, id);
CREATE INDEX IF NOT EXISTS automations_schedules_due_idx
  ON automations_schedules (enabled, next_run_at, id);

CREATE TABLE IF NOT EXISTS automations_triggers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  label TEXT NOT NULL,
  secret_key_id TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  secret_tag TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  secret_revision INTEGER NOT NULL CHECK (secret_revision > 0),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  last_fired_at INTEGER,
  accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0)
) STRICT;
CREATE INDEX IF NOT EXISTS automations_triggers_tenant_label_idx
  ON automations_triggers (tenant_id, label, id);

CREATE TABLE IF NOT EXISTS automations_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (
    subject_type IN ('automation-schedule', 'automation-trigger')
  ),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence)
) STRICT;
CREATE INDEX IF NOT EXISTS automations_audit_tenant_time_idx
  ON automations_audit_events (tenant_id, occurred_at DESC, sequence DESC);
`;

/* Mirrors migrations/0002_automations_targets.up.sql byte for byte. */
export const AUTOMATIONS_MIGRATION_002 = `ALTER TABLE automations_schedules
  ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE automations_schedules
  ADD COLUMN target_key TEXT;
ALTER TABLE automations_schedules
  ADD COLUMN configured_by_json TEXT;
ALTER TABLE automations_schedules
  ADD COLUMN permission_snapshot_json TEXT NOT NULL DEFAULT '[]';
UPDATE automations_schedules
SET target_key = agent_id
WHERE target_key IS NULL;
UPDATE automations_schedules
SET configured_by_json = json_object(
  'kind', 'user',
  'id', created_by,
  'label', created_by
)
WHERE configured_by_json IS NULL;

ALTER TABLE automations_triggers
  ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE automations_triggers
  ADD COLUMN target_key TEXT;
ALTER TABLE automations_triggers
  ADD COLUMN configured_by_json TEXT;
ALTER TABLE automations_triggers
  ADD COLUMN permission_snapshot_json TEXT NOT NULL DEFAULT '[]';
UPDATE automations_triggers
SET target_key = agent_id
WHERE target_key IS NULL;
UPDATE automations_triggers
SET configured_by_json = json_object(
  'kind', 'user',
  'id', created_by,
  'label', created_by
)
WHERE configured_by_json IS NULL;
`;

export const migrations: readonly ModuleMigration[] = [
	{ id: '0001_automations_core', statements: AUTOMATIONS_MIGRATION_001 },
	{ id: '0002_automations_targets', statements: AUTOMATIONS_MIGRATION_002 },
];
