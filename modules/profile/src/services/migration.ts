import type { ModuleMigration } from '@coreloom/kernel';

/* Every constant mirrors its migrations/<id>.up.sql file byte for byte;
   tests/migrations.test.ts fails on drift. */

export const PROFILE_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS profile_records (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, account_id)
) STRICT;
CREATE INDEX IF NOT EXISTS profile_records_tenant_account_idx ON profile_records (tenant_id, account_id);
`;

export const PROFILE_MIGRATION_002 = `CREATE TABLE IF NOT EXISTS profile_language_preferences (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (length(locale) BETWEEN 2 AND 16),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, account_id)
) STRICT;
`;

export const migrations: readonly ModuleMigration[] = [
	{ id: '0001_profile_core', statements: PROFILE_MIGRATION_001 },
	{ id: '0002_profile_language', statements: PROFILE_MIGRATION_002 },
];
