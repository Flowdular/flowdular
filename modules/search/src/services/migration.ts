import type { DatabaseMigration } from '@flowdular/database';
import {
	migrationObjectState,
	postgresTenantTableState,
} from '@flowdular/database';

/* Mirrors migrations/0001_search_core.up.sql byte for byte. */
export const SEARCH_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS search_recent_queries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  query TEXT NOT NULL,
  ran_at BIGINT NOT NULL
);
-- One row per member and query text. Re-running a query moves it to the top
-- instead of filling the member's recall list with the same words, so the
-- bound of 50 counts distinct queries rather than keystrokes.
CREATE UNIQUE INDEX IF NOT EXISTS search_recent_queries_member_query_idx
  ON search_recent_queries (tenant_id, account_id, lower(query));
CREATE INDEX IF NOT EXISTS search_recent_queries_member_idx
  ON search_recent_queries (tenant_id, account_id, ran_at DESC, id DESC);
-- Retention sweeps the workspace, not one member, so it needs its own order.
CREATE INDEX IF NOT EXISTS search_recent_queries_retention_idx
  ON search_recent_queries (tenant_id, ran_at, id);
ALTER TABLE search_recent_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_recent_queries FORCE ROW LEVEL SECURITY;
CREATE POLICY search_recent_queries_tenant_policy ON search_recent_queries
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/* Mirrors migrations/0002_search_recent_export.up.sql byte for byte. */
export const SEARCH_MIGRATION_002 = `-- The export walk pages on the immutable key. Re-running a query rewrites its
-- ran_at, so a keyset on the timestamp hands the walk the same row again; the
-- retention index orders by ran_at and cannot serve the id order.
CREATE INDEX IF NOT EXISTS search_recent_queries_export_idx
  ON search_recent_queries (tenant_id, id);
`;

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_search_core',
		sql: { postgresql: SEARCH_MIGRATION_001 },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'search_recent_queries',
				'search_recent_queries_tenant_policy',
				[
					() =>
						database.schema.hasIndex('search_recent_queries_member_query_idx'),
					() => database.schema.hasIndex('search_recent_queries_member_idx'),
					() => database.schema.hasIndex('search_recent_queries_retention_idx'),
				],
			),
	},
	{
		id: '0002_search_recent_export',
		sql: { postgresql: SEARCH_MIGRATION_002 },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasIndex('search_recent_queries_export_idx'),
			]),
	},
];
