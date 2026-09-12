CREATE INDEX IF NOT EXISTS audit_data_classes_due_idx
  ON audit_data_classes (sweepable, last_swept_at, tenant_id, class_id);
DROP INDEX IF EXISTS audit_data_classes_due_nulls_first_idx;
DROP INDEX IF EXISTS audit_anchors_key_id_idx;
DROP INDEX IF EXISTS audit_export_runs_tenant_id_idx;
DROP INDEX IF EXISTS audit_sweep_runs_tenant_id_idx;
DROP INDEX IF EXISTS audit_events_tenant_id_idx;
ALTER TABLE audit_subject_keys DROP CONSTRAINT IF EXISTS audit_subject_keys_marker_check;
ALTER TABLE audit_erasure_runs DROP CONSTRAINT IF EXISTS audit_erasure_runs_status_check;
-- A run recorded partial has no place in the constraint this restores, so the
-- reverse fails while one exists rather than rewriting the ledger.
ALTER TABLE audit_erasure_runs
  ADD CONSTRAINT audit_erasure_runs_status_check
  CHECK (status IN ('requested', 'completed', 'failed'));
DROP INDEX IF EXISTS audit_subject_keys_tenant_marker_idx;
ALTER TABLE audit_subject_keys DROP COLUMN IF EXISTS subject_marker;
ALTER TABLE audit_events DROP COLUMN IF EXISTS seal_format;
