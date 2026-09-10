CREATE TABLE IF NOT EXISTS profile_records (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, account_id)
);
CREATE INDEX IF NOT EXISTS profile_records_tenant_account_idx ON profile_records (tenant_id, account_id);
ALTER TABLE profile_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_records FORCE ROW LEVEL SECURITY;
CREATE POLICY profile_records_tenant_policy ON profile_records
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
