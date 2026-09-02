import type { MigrationDatabase, ModuleMigration } from '@coreloom/kernel';

/* Every constant mirrors its migrations/<id>.up.sql file byte for byte;
   tests/migrations.test.ts fails on drift. */

export const CATALOG_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS catalog_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  sku_normalized TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('product', 'service')),
  unit TEXT NOT NULL,
  base_price_minor INTEGER NOT NULL CHECK (base_price_minor >= 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, sku_normalized)
) STRICT;
CREATE INDEX IF NOT EXISTS catalog_items_tenant_sku_idx
  ON catalog_items (tenant_id, sku_normalized, id);
`;

export const CATALOG_MIGRATION_002_HISTORY = `CREATE TABLE IF NOT EXISTS catalog_items_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 32),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  actor_label TEXT NOT NULL CHECK (length(actor_label) BETWEEN 1 AND 160),
  run_id TEXT CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 128),
  changes_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS catalog_items_history_tenant_record_version_idx
  ON catalog_items_history (tenant_id, record_id, version DESC);
`;

export const CATALOG_MIGRATION_003_HISTORY_SERVICE_ACTORS = `CREATE TABLE IF NOT EXISTS catalog_items_history_v2 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 32),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent', 'service')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  actor_label TEXT NOT NULL CHECK (length(actor_label) BETWEEN 1 AND 160),
  run_id TEXT CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 128),
  configured_by_json TEXT CHECK (configured_by_json IS NULL OR json_valid(configured_by_json)),
  changes_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  CHECK (
    (actor_kind = 'agent' AND run_id IS NOT NULL)
    OR (actor_kind IN ('user', 'service') AND run_id IS NULL)
  ),
  CHECK (
    (actor_kind = 'service' AND configured_by_json IS NOT NULL)
    OR (actor_kind IN ('user', 'agent') AND configured_by_json IS NULL)
  )
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS catalog_items_history_v2_tenant_record_version_idx
  ON catalog_items_history_v2 (tenant_id, record_id, version DESC);
INSERT OR IGNORE INTO catalog_items_history_v2
  (id, tenant_id, record_id, version, action, actor_kind, actor_id,
   actor_label, run_id, configured_by_json, changes_json, occurred_at)
SELECT id, tenant_id, record_id, version, action, actor_kind, actor_id,
       actor_label, run_id, NULL, changes_json, occurred_at
FROM catalog_items_history;
`;

export const CATALOG_MIGRATION_004_IDEMPOTENCY_LEDGER = `CREATE TABLE IF NOT EXISTS catalog_idempotency_ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 3 AND 160),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 71),
  outcome TEXT NOT NULL CHECK (outcome = 'succeeded'),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  result_digest TEXT NOT NULL CHECK (length(result_digest) = 71),
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
) STRICT;
CREATE INDEX IF NOT EXISTS catalog_idempotency_ledger_tenant_operation_idx
  ON catalog_idempotency_ledger (tenant_id, operation_id, created_at, id);
`;

function serviceHistoryAdopted(database: MigrationDatabase): boolean {
	const objects = database
		.prepare(
			`SELECT name FROM sqlite_master
			 WHERE (type = 'table' AND name = 'catalog_items_history_v2')
			    OR (type = 'index' AND name = 'catalog_items_history_v2_tenant_record_version_idx')`,
		)
		.all() as readonly { readonly name: string }[];
	if (objects.length !== 2) return false;
	const configuredBy = database
		.prepare(
			`SELECT 1 AS present FROM pragma_table_info('catalog_items_history_v2')
			 WHERE name = 'configured_by_json'`,
		)
		.get();
	if (configuredBy === undefined) return false;
	return (
		database
			.prepare(
				`SELECT 1 AS missing FROM catalog_items_history AS source
				 LEFT JOIN catalog_items_history_v2 AS target ON target.id = source.id
				 WHERE target.id IS NULL LIMIT 1`,
			)
			.get() === undefined
	);
}

export const migrations: readonly ModuleMigration[] = [
	{ id: '0001_catalog_core', statements: CATALOG_MIGRATION_001 },
	{ id: '0002_catalog_history', statements: CATALOG_MIGRATION_002_HISTORY },
	{
		id: '0003_catalog_history_service_actors',
		statements: CATALOG_MIGRATION_003_HISTORY_SERVICE_ACTORS,
		adoptWhen: serviceHistoryAdopted,
	},
	{
		id: '0004_catalog_idempotency_ledger',
		statements: CATALOG_MIGRATION_004_IDEMPOTENCY_LEDGER,
	},
];
