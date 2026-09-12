CREATE TABLE IF NOT EXISTS documents_files (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_module TEXT NOT NULL,
  record_ref TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes BIGINT NOT NULL CHECK (bytes >= 0),
  checksum TEXT,
  storage_key TEXT NOT NULL,
  uploader_account_id TEXT NOT NULL,
  scan TEXT NOT NULL CHECK (scan IN ('unscanned', 'clean', 'infected')),
  status TEXT NOT NULL CHECK (status IN ('stored', 'deleted')),
  description TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_files_tenant_created_idx
  ON documents_files (tenant_id, created_at DESC, id);
-- The owning module and its record reference are how another module reaches its
-- attachments, so the pair leads the index the capability reads.
CREATE INDEX IF NOT EXISTS documents_files_record_idx
  ON documents_files (tenant_id, owner_module, record_ref, created_at DESC, id);
-- One row per object. A second row on one key would double count the quota and
-- leave the delete order pointing at bytes another row still claims.
CREATE UNIQUE INDEX IF NOT EXISTS documents_files_storage_key_idx
  ON documents_files (tenant_id, storage_key);
-- The workspace quota is the sum of what is still stored, so the aggregate
-- reads this partial index instead of walking the workspace's rows.
CREATE INDEX IF NOT EXISTS documents_files_usage_idx
  ON documents_files (tenant_id, bytes) WHERE status = 'stored';
ALTER TABLE documents_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents_files FORCE ROW LEVEL SECURITY;
CREATE POLICY documents_files_tenant_policy ON documents_files
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
