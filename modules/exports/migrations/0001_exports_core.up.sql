CREATE TABLE IF NOT EXISTS exports_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  list_id TEXT NOT NULL CHECK (length(list_id) BETWEEN 3 AND 96),
  status TEXT NOT NULL CHECK (status IN ('requested', 'running', 'completed', 'failed')),
  row_count BIGINT NOT NULL CHECK (row_count >= 0),
  byte_count BIGINT NOT NULL CHECK (byte_count >= 0),
  object_id TEXT CHECK (object_id IS NULL OR length(object_id) BETWEEN 1 AND 128),
  requester_account_id TEXT NOT NULL CHECK (length(requester_account_id) BETWEEN 1 AND 128),
  requester_json TEXT NOT NULL CHECK (length(requester_json) <= 8192 AND requester_json::jsonb IS NOT NULL),
  failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 64),
  claimed_at BIGINT,
  started_at BIGINT NOT NULL,
  completed_at BIGINT,
  UNIQUE (tenant_id, object_id),
  CHECK ((status IN ('completed', 'failed')) = (completed_at IS NOT NULL)),
  CHECK ((failure_code IS NOT NULL) = (status = 'failed')),
  CHECK (object_id IS NULL OR status = 'completed')
);
CREATE INDEX IF NOT EXISTS exports_jobs_tenant_started_idx
  ON exports_jobs (tenant_id, started_at DESC, id);
CREATE INDEX IF NOT EXISTS exports_jobs_tenant_export_idx
  ON exports_jobs (tenant_id, started_at, id);
ALTER TABLE exports_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE exports_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY exports_jobs_tenant_policy ON exports_jobs
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
