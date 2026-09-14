import type { DatabaseMigration } from '@flowdular/database';
import {
	migrationObjectState,
	postgresTenantTableState,
} from '@flowdular/database';

/* Mirrors migrations/0001_documents_core.up.sql byte for byte;
   tests/migrations.test.ts fails on drift. */
export const DOCUMENTS_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS documents_files (
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
`;

/* Mirrors migrations/0002_documents_files_page.up.sql byte for byte. */
export const DOCUMENTS_MIGRATION_002 = `-- A page of documents is keyed on (created_at, id) in one direction, so the
-- index carries both columns descending. The index shipped with 0001 orders id
-- ascending under a descending created_at, which no scan direction turns into
-- the order a keyset page walks.
CREATE INDEX IF NOT EXISTS documents_files_page_idx
  ON documents_files (tenant_id, created_at DESC, id DESC);
`;

/* Mirrors migrations/0003_documents_rotation_inventory.up.sql byte for byte. */
export const DOCUMENTS_MIGRATION_003 = `-- The storage key rotation has to find the workspaces that still hold objects
-- before it knows which objects those are, so the cross-tenant role may count
-- stored rows by workspace and nothing else: the storage key, the record and
-- the file name stay invisible to it, and every object it names is read again
-- under the workspace that row named. PostgreSQL checks column privileges in
-- WHERE too, so \`status\` is part of the grant.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY documents_files_background_policy ON documents_files
  FOR SELECT TO coreloom_background
  USING (status = 'stored');
REVOKE SELECT ON documents_files FROM coreloom_background;
GRANT SELECT (tenant_id, status) ON documents_files TO coreloom_background;
`;

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_documents_core',
		sql: { postgresql: DOCUMENTS_MIGRATION_001 },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'documents_files',
				'documents_files_tenant_policy',
				[
					() => database.schema.hasIndex('documents_files_tenant_created_idx'),
					() => database.schema.hasIndex('documents_files_record_idx'),
					() => database.schema.hasIndex('documents_files_storage_key_idx'),
					() => database.schema.hasIndex('documents_files_usage_idx'),
				],
			),
	},
	{
		id: '0002_documents_files_page',
		sql: { postgresql: DOCUMENTS_MIGRATION_002 },
		/* The table is 0001's; this migration owns one index, so a database that
		   already carries it is adopted and one that does not runs it. */
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasIndex('documents_files_page_idx'),
			]),
	},
	{
		id: '0003_documents_rotation_inventory',
		sql: { postgresql: DOCUMENTS_MIGRATION_003 },
		/* A policy and a column grant leave no schema object behind, so the
		   privilege itself is what proves this migration ran. */
		inspectExisting: async (database) => {
			const result = await database.query<{ granted: boolean }>({
				text: `SELECT CASE WHEN to_regclass('documents_files') IS NOT NULL THEN
				  has_column_privilege('coreloom_background', 'documents_files', 'status', 'SELECT')
				ELSE false END AS granted`,
			});
			return result.rows[0]?.granted === true ? 'complete' : 'absent';
		},
	},
];
