import type { DatabaseMigration } from '@flowdular/database';
import { postgresTenantTableState } from '@flowdular/database';

/* Every constant mirrors its migrations/<id>.up.sql file byte for byte;
   tests/migrations.test.ts fails on drift. */

export const PROFILE_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS profile_records (
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
`;

export const PROFILE_MIGRATION_002 = `CREATE TABLE IF NOT EXISTS profile_language_preferences (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (length(locale) BETWEEN 2 AND 16),
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, account_id)
);
ALTER TABLE profile_language_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_language_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY profile_language_preferences_tenant_policy ON profile_language_preferences
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_profile_core',
		sql: { postgresql: PROFILE_MIGRATION_001 },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'profile_records',
				'profile_records_tenant_policy',
				[() => database.schema.hasIndex('profile_records_tenant_account_idx')],
			),
	},
	{
		id: '0002_profile_language',
		sql: { postgresql: PROFILE_MIGRATION_002 },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'profile_language_preferences',
				'profile_language_preferences_tenant_policy',
			),
	},
];
