export const PROFILE_MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS profile_records (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, account_id)
) STRICT;
CREATE INDEX IF NOT EXISTS profile_records_tenant_account_idx ON profile_records (tenant_id, account_id);
`;
