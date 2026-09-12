-- One row per workspace and declared class, materialised from the registry the
-- first time the workspace reads it and refreshed on every read afterwards. The
-- registry stays the truth about what a class is; this row carries only what
-- the workspace owns: its period and when the sweep last ran.
--
-- retention_mode separates the two absent states the period has: 'default'
-- follows the declaring module, 'none' keeps the rows until a person deletes
-- them, and 'days' is the workspace's own number. A single nullable integer
-- could not tell the first two apart.
CREATE TABLE IF NOT EXISTS audit_data_classes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  label TEXT NOT NULL,
  exportable SMALLINT NOT NULL CHECK (exportable IN (0, 1)),
  sweepable SMALLINT NOT NULL CHECK (sweepable IN (0, 1)),
  default_retention_days BIGINT,
  retention_mode TEXT NOT NULL CHECK (retention_mode IN ('default', 'days', 'none')),
  retention_days BIGINT CHECK (retention_days IS NULL OR retention_days > 0),
  last_swept_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK ((retention_mode = 'days') = (retention_days IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS audit_data_classes_tenant_class_idx
  ON audit_data_classes (tenant_id, class_id);
-- The sweep walks this index across tenants on the routing role. Ordering by
-- last_swept_at first makes the walk start at the classes waiting longest.
CREATE INDEX IF NOT EXISTS audit_data_classes_due_idx
  ON audit_data_classes (sweepable, last_swept_at, tenant_id, class_id);
ALTER TABLE audit_data_classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_data_classes FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_data_classes_tenant_policy ON audit_data_classes
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

CREATE TABLE IF NOT EXISTS audit_sweep_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  cutoff BIGINT NOT NULL,
  removed BIGINT NOT NULL CHECK (removed >= 0),
  status TEXT NOT NULL CHECK (status IN ('completed', 'partial', 'refused')),
  reason TEXT,
  occurred_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_sweep_runs_tenant_time_idx
  ON audit_sweep_runs (tenant_id, occurred_at DESC, id);
-- A refusal stands until it is answered, so the loop asks for the newest run of
-- one class instead of appending the same refusal every interval.
CREATE INDEX IF NOT EXISTS audit_sweep_runs_tenant_class_time_idx
  ON audit_sweep_runs (tenant_id, class_id, occurred_at DESC, id);
ALTER TABLE audit_sweep_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_sweep_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_sweep_runs_tenant_policy ON audit_sweep_runs
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- row_count rather than "rows": ROWS is a PostgreSQL keyword and an unquoted
-- column of that name would have to be quoted at every use site.
CREATE TABLE IF NOT EXISTS audit_export_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  format_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  classes BIGINT NOT NULL CHECK (classes >= 0),
  row_count BIGINT NOT NULL CHECK (row_count >= 0),
  archive_digest TEXT,
  requested_by TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  completed_at BIGINT
);
CREATE INDEX IF NOT EXISTS audit_export_runs_tenant_time_idx
  ON audit_export_runs (tenant_id, started_at DESC, id);
ALTER TABLE audit_export_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_export_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_export_runs_tenant_policy ON audit_export_runs
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- auth.core keeps its trail private to its own service, and it registers no
-- public capability, so a module cannot append to it. This is audit.core's own
-- tamper-evident trail: one chain per workspace, each event sealing the hash of
-- the one before it, so a removed or edited row breaks every hash after it.
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('data-class', 'sweep-run', 'export-run')),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, event_hash)
);
CREATE INDEX IF NOT EXISTS audit_events_tenant_time_idx
  ON audit_events (tenant_id, occurred_at DESC, sequence DESC);
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_tenant_policy ON audit_events
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
