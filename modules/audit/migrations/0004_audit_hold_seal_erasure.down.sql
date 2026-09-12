REVOKE SELECT (tenant_id, id, status, started_at) ON audit_erasure_runs FROM coreloom_background;
DROP POLICY IF EXISTS audit_erasure_runs_background_policy ON audit_erasure_runs;
REVOKE SELECT (tenant_id, id, key_id) ON audit_anchors FROM coreloom_background;
DROP POLICY IF EXISTS audit_anchors_background_policy ON audit_anchors;
ALTER TABLE audit_sweep_runs DROP CONSTRAINT IF EXISTS audit_sweep_runs_held_back_check;
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_sealed_check;
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_subject_type_check;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_subject_type_check
  CHECK (subject_type IN ('data-class', 'sweep-run', 'export-run'));
ALTER TABLE audit_sweep_runs DROP COLUMN IF EXISTS held_back;
ALTER TABLE audit_events DROP COLUMN IF EXISTS sealed_payload;
ALTER TABLE audit_events DROP COLUMN IF EXISTS subject_key_id;
DROP TABLE IF EXISTS audit_erasure_runs;
DROP TABLE IF EXISTS audit_subject_keys;
DROP TABLE IF EXISTS audit_legal_holds;
DROP TABLE IF EXISTS audit_anchors;
