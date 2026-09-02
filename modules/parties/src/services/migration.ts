import type { MigrationDatabase, ModuleMigration } from '@coreloom/kernel';

/* Every constant mirrors its migrations/<id>.up.sql file byte for byte;
   tests/migrations.test.ts fails on drift. */

export const PARTIES_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('customer', 'supplier', 'both')),
  email TEXT,
  phone TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS parties_tenant_name_idx
  ON parties (tenant_id, name, id);
`;

export const PARTIES_MIGRATION_002_VAT_ID_COLUMN = `ALTER TABLE parties ADD COLUMN vat_id TEXT
  CHECK (
    vat_id IS NULL OR (
      length(vat_id) BETWEEN 1 AND 20
      AND vat_id NOT GLOB '*[^0-9A-Za-z]*'
    )
  );
`;

export const PARTIES_MIGRATION_003_HISTORY = `CREATE TABLE IF NOT EXISTS parties_history (
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
CREATE UNIQUE INDEX IF NOT EXISTS parties_history_tenant_record_version_idx
  ON parties_history (tenant_id, record_id, version DESC);
`;

export const PARTIES_MIGRATION_004_HISTORY_SERVICE_ACTORS = `CREATE TABLE IF NOT EXISTS parties_history_v2 (
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
CREATE UNIQUE INDEX IF NOT EXISTS parties_history_v2_tenant_record_version_idx
  ON parties_history_v2 (tenant_id, record_id, version DESC);
INSERT OR IGNORE INTO parties_history_v2
  (id, tenant_id, record_id, version, action, actor_kind, actor_id,
   actor_label, run_id, configured_by_json, changes_json, occurred_at)
SELECT id, tenant_id, record_id, version, action, actor_kind, actor_id,
       actor_label, run_id, NULL, changes_json, occurred_at
FROM parties_history;
`;

export const PARTIES_MIGRATION_005_IDEMPOTENCY_LEDGER = `CREATE TABLE IF NOT EXISTS parties_idempotency_ledger (
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
CREATE INDEX IF NOT EXISTS parties_idempotency_ledger_tenant_operation_idx
  ON parties_idempotency_ledger (tenant_id, operation_id, created_at, id);
`;

function serviceHistoryAdopted(database: MigrationDatabase): boolean {
	const objects = database
		.prepare(
			`SELECT name FROM sqlite_master
			 WHERE (type = 'table' AND name = 'parties_history_v2')
			    OR (type = 'index' AND name = 'parties_history_v2_tenant_record_version_idx')`,
		)
		.all() as readonly { readonly name: string }[];
	if (objects.length !== 2) return false;
	const configuredBy = database
		.prepare(
			`SELECT 1 AS present FROM pragma_table_info('parties_history_v2')
			 WHERE name = 'configured_by_json'`,
		)
		.get();
	if (configuredBy === undefined) return false;
	return (
		database
			.prepare(
				`SELECT 1 AS missing FROM parties_history AS source
				 LEFT JOIN parties_history_v2 AS target ON target.id = source.id
				 WHERE target.id IS NULL LIMIT 1`,
			)
			.get() === undefined
	);
}

export const migrations: readonly ModuleMigration[] = [
	{ id: '0001_parties_core', statements: PARTIES_MIGRATION_001 },
	{
		id: '0002_parties_vat_id',
		statements: PARTIES_MIGRATION_002_VAT_ID_COLUMN,
	},
	{ id: '0003_parties_history', statements: PARTIES_MIGRATION_003_HISTORY },
	{
		id: '0004_parties_history_service_actors',
		statements: PARTIES_MIGRATION_004_HISTORY_SERVICE_ACTORS,
		adoptWhen: serviceHistoryAdopted,
	},
	{
		id: '0005_parties_idempotency_ledger',
		statements: PARTIES_MIGRATION_005_IDEMPOTENCY_LEDGER,
	},
];
