import type { DatabaseMigration } from '@flowdular/sdk/database';
import { postgresTenantTableState } from '@flowdular/sdk/database';

/* Every constant mirrors its migrations/<id>.up.sql file byte for byte;
   tests/migrations.test.ts fails on drift. */

export const EXAMPLE_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS example_notes (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS example_notes_tenant_created_idx ON example_notes (tenant_id, created_at DESC);
ALTER TABLE example_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE example_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY example_notes_tenant_policy ON example_notes
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_example_core',
		sql: { postgresql: EXAMPLE_MIGRATION_001 },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'example_notes',
				'example_notes_tenant_policy',
				[() => database.schema.hasIndex('example_notes_tenant_created_idx')],
			),
	},
];
