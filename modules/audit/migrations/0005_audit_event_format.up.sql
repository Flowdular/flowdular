-- The event format marker, the subject marker, a partial erasure run and the
-- indexes the ledger walks need.
--
-- seal_format names the writer of a row. A row without it was written before
-- audit.core recorded a format at all, which is exactly the set verify reports
-- as plaintext; a row that carries the marker and no sealed payload is an event
-- about nobody, not an unsealed person. Deriving that from sealed_payload alone
-- reported every platform event as pre-0.2.0.
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS seal_format TEXT;

-- The name a subject keeps once its key is gone. Destruction removes the
-- account the key belonged to, so without this column a destroyed key cannot be
-- found again and the next event naming that subject would create a new key and
-- put the account back in the clear. Active rows are named from the same hash
-- the certificate file already uses.
ALTER TABLE audit_subject_keys ADD COLUMN IF NOT EXISTS subject_marker TEXT;
UPDATE audit_subject_keys
  SET subject_marker = substr(encode(sha256((tenant_id || ':' || subject)::bytea), 'hex'), 1, 12)
  WHERE subject IS NOT NULL AND subject_marker IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS audit_subject_keys_tenant_marker_idx
  ON audit_subject_keys (tenant_id, subject_marker)
  WHERE subject_marker IS NOT NULL;

-- A run whose class was truncated or whose owner failed erased some of the
-- subject and not all of it. Recording that as completed would tell an operator
-- the subject is gone when a class still holds rows.
ALTER TABLE audit_erasure_runs DROP CONSTRAINT IF EXISTS audit_erasure_runs_status_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_erasure_runs_status_check') THEN
    ALTER TABLE audit_erasure_runs
      ADD CONSTRAINT audit_erasure_runs_status_check
      CHECK (status IN ('requested', 'completed', 'partial', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_subject_keys_marker_check') THEN
    ALTER TABLE audit_subject_keys
      ADD CONSTRAINT audit_subject_keys_marker_check
      CHECK (subject_marker IS NULL OR length(subject_marker) <= 32);
  END IF;
END
$$;

-- The keyset walks the export takes over the three ledgers order by the primary
-- key inside one workspace, and the anchor rotation counts and pages anchors by
-- key. Without these each walk was a scan of every row of the table.
CREATE INDEX IF NOT EXISTS audit_events_tenant_id_idx
  ON audit_events (tenant_id, id);
CREATE INDEX IF NOT EXISTS audit_sweep_runs_tenant_id_idx
  ON audit_sweep_runs (tenant_id, id);
CREATE INDEX IF NOT EXISTS audit_export_runs_tenant_id_idx
  ON audit_export_runs (tenant_id, id);
CREATE INDEX IF NOT EXISTS audit_anchors_key_id_idx
  ON audit_anchors (key_id, id);

-- The routing read starts at the classes waiting longest, so it orders by
-- last_swept_at NULLS FIRST. The index migration 0001 created sorts nulls last,
-- which is the opposite end, so the walk sorted every due class on every pass.
CREATE INDEX IF NOT EXISTS audit_data_classes_due_nulls_first_idx
  ON audit_data_classes (sweepable, last_swept_at NULLS FIRST, tenant_id, class_id);
DROP INDEX IF EXISTS audit_data_classes_due_idx;
