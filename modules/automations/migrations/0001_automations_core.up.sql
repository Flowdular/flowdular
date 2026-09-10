CREATE TABLE IF NOT EXISTS automations_schedules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  label TEXT NOT NULL,
  input_template TEXT NOT NULL,
  cadence TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  disabled_reason TEXT,
  next_run_at BIGINT NOT NULL,
  last_run_at BIGINT,
  last_run_id TEXT,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  created_by TEXT NOT NULL
);
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
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  created_by TEXT NOT NULL,
  last_fired_at BIGINT,
  accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0)
);
CREATE INDEX IF NOT EXISTS automations_triggers_tenant_label_idx
  ON automations_triggers (tenant_id, label, id);

CREATE TABLE IF NOT EXISTS automations_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (
    subject_type IN ('automation-schedule', 'automation-trigger')
  ),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence)
);
CREATE INDEX IF NOT EXISTS automations_audit_tenant_time_idx
  ON automations_audit_events (tenant_id, occurred_at DESC, sequence DESC);
ALTER TABLE automations_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY automations_schedules_tenant_policy ON automations_schedules
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE automations_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations_triggers FORCE ROW LEVEL SECURITY;
CREATE POLICY automations_triggers_tenant_policy ON automations_triggers
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE automations_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY automations_audit_events_tenant_policy ON automations_audit_events
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
