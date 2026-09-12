CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  target TEXT NOT NULL CHECK (length(target) BETWEEN 3 AND 96),
  document_id TEXT NOT NULL CHECK (length(document_id) BETWEEN 1 AND 128),
  document_ref TEXT NOT NULL CHECK (length(document_ref) BETWEEN 1 AND 200),
  mode TEXT NOT NULL CHECK (mode IN ('create-only', 'update-existing', 'skip-existing')),
  dry_run SMALLINT NOT NULL CHECK (dry_run IN (0, 1)),
  valid_only SMALLINT NOT NULL CHECK (valid_only IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('parsing', 'validated', 'writing', 'completed', 'failed', 'cancelled')),
  total_rows BIGINT NOT NULL CHECK (total_rows >= 0),
  valid_rows BIGINT NOT NULL CHECK (valid_rows >= 0),
  written_rows BIGINT NOT NULL CHECK (written_rows >= 0),
  failed_rows BIGINT NOT NULL CHECK (failed_rows >= 0),
  requester_account_id TEXT NOT NULL CHECK (length(requester_account_id) BETWEEN 1 AND 128),
  requester_json TEXT NOT NULL CHECK (length(requester_json) <= 8192 AND requester_json::jsonb IS NOT NULL),
  columns_json TEXT NOT NULL CHECK (length(columns_json) <= 8192 AND columns_json::jsonb IS NOT NULL),
  failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 64),
  claimed_at BIGINT,
  started_at BIGINT NOT NULL,
  completed_at BIGINT,
  CHECK ((status IN ('completed', 'failed', 'cancelled')) = (completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS import_jobs_tenant_started_idx
  ON import_jobs (tenant_id, started_at DESC, id);
ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY import_jobs_tenant_policy ON import_jobs
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

CREATE TABLE IF NOT EXISTS import_job_rows (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  row_number BIGINT NOT NULL CHECK (row_number >= 1),
  outcome TEXT NOT NULL CHECK (outcome IN ('valid', 'invalid', 'created', 'updated', 'skipped', 'failed')),
  field TEXT CHECK (field IS NULL OR length(field) BETWEEN 1 AND 64),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 200),
  record_ref TEXT CHECK (record_ref IS NULL OR length(record_ref) BETWEEN 1 AND 200),
  UNIQUE (tenant_id, job_id, row_number)
);
ALTER TABLE import_job_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_job_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY import_job_rows_tenant_policy ON import_job_rows
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

CREATE TABLE IF NOT EXISTS import_mappings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  target TEXT NOT NULL CHECK (length(target) BETWEEN 3 AND 96),
  columns_json TEXT NOT NULL CHECK (length(columns_json) <= 8192 AND columns_json::jsonb IS NOT NULL),
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, target)
);
ALTER TABLE import_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY import_mappings_tenant_policy ON import_mappings
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
