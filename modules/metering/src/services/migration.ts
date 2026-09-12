import type {
	DatabaseMigration,
	DatabaseSession,
	ExistingMigrationState,
} from '@flowdular/database';
import {
	migrationObjectState,
	postgresTenantTableState,
} from '@flowdular/database';

/* Mirrors migrations/0001_metering_core.up.sql byte for byte;
   tests/migrations.test.ts fails on drift. */
export const METERING_MIGRATION_001 = `-- Meters as one workspace recorded them. The declaration itself lives in the
-- composed process; a row appears the first time a module reports a fact for
-- this workspace, which is what makes the registry readable under the tenant
-- policy like every other row metering.core owns.
CREATE TABLE IF NOT EXISTS metering_meters (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  meter_key TEXT NOT NULL CHECK (length(meter_key) BETWEEN 1 AND 96),
  module_id TEXT NOT NULL CHECK (length(module_id) BETWEEN 1 AND 64),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  unit TEXT NOT NULL CHECK (length(unit) BETWEEN 1 AND 32),
  kind TEXT NOT NULL CHECK (kind IN ('cumulative', 'gauge')),
  created_at BIGINT NOT NULL,
  UNIQUE (tenant_id, meter_key)
);
ALTER TABLE metering_meters ENABLE ROW LEVEL SECURITY;
ALTER TABLE metering_meters FORCE ROW LEVEL SECURITY;
CREATE POLICY metering_meters_tenant_policy ON metering_meters
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- One row per meter per UTC day. The unique key is also the index every read
-- and every accumulating write uses, so a fact costs one upsert and a month
-- total is a range scan over ordered days.
CREATE TABLE IF NOT EXISTS metering_buckets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  meter_key TEXT NOT NULL CHECK (length(meter_key) BETWEEN 1 AND 96),
  day TEXT NOT NULL CHECK (length(day) = 10),
  amount BIGINT NOT NULL CHECK (amount >= 0),
  events BIGINT NOT NULL CHECK (events >= 0),
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, meter_key, day)
);
CREATE INDEX IF NOT EXISTS metering_buckets_tenant_day_idx
  ON metering_buckets (tenant_id, day, meter_key);
ALTER TABLE metering_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE metering_buckets FORCE ROW LEVEL SECURITY;
CREATE POLICY metering_buckets_tenant_policy ON metering_buckets
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- What makes a fact idempotent. The unique key is the whole mechanism: a
-- repeat of a source reference inserts nothing and the bucket is left alone.
-- The day column is carried so a retention sweep of the bucket class removes
-- these rows on the same cutoff and the same index.
CREATE TABLE IF NOT EXISTS metering_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  meter_key TEXT NOT NULL CHECK (length(meter_key) BETWEEN 1 AND 96),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 200),
  day TEXT NOT NULL CHECK (length(day) = 10),
  amount BIGINT NOT NULL CHECK (amount >= 0),
  recorded_at BIGINT NOT NULL,
  UNIQUE (tenant_id, meter_key, source_ref)
);
CREATE INDEX IF NOT EXISTS metering_records_tenant_day_idx
  ON metering_records (tenant_id, day, id);
ALTER TABLE metering_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE metering_records FORCE ROW LEVEL SECURITY;
CREATE POLICY metering_records_tenant_policy ON metering_records
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- The operator's ceiling. No foreign key to metering_meters: a limit is set
-- before the workspace has reported its first fact for that meter, which is
-- the point of setting one.
CREATE TABLE IF NOT EXISTS metering_limits (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  meter_key TEXT NOT NULL CHECK (length(meter_key) BETWEEN 1 AND 96),
  monthly_limit BIGINT NOT NULL CHECK (monthly_limit >= 0),
  set_by TEXT NOT NULL CHECK (length(set_by) BETWEEN 1 AND 128),
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, meter_key)
);
ALTER TABLE metering_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE metering_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY metering_limits_tenant_policy ON metering_limits
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- Every limit the operator set, in order, with the label the CLI derived. The
-- limit row carries the current value; this is the evidence of how it got
-- there and it is never rewritten.
CREATE TABLE IF NOT EXISTS metering_limit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  meter_key TEXT NOT NULL CHECK (length(meter_key) BETWEEN 1 AND 96),
  monthly_limit BIGINT NOT NULL CHECK (monthly_limit >= 0),
  previous_limit BIGINT CHECK (previous_limit IS NULL OR previous_limit >= 0),
  set_by TEXT NOT NULL CHECK (length(set_by) BETWEEN 1 AND 128),
  occurred_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS metering_limit_events_tenant_occurred_idx
  ON metering_limit_events (tenant_id, occurred_at DESC, id);
ALTER TABLE metering_limit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE metering_limit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY metering_limit_events_tenant_policy ON metering_limit_events
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- One row per meter per month per threshold. The unique key is what makes a
-- threshold notification happen once: the row is claimed inside the recording
-- transaction and only a claim that inserted publishes.
CREATE TABLE IF NOT EXISTS metering_threshold_notices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  meter_key TEXT NOT NULL CHECK (length(meter_key) BETWEEN 1 AND 96),
  month TEXT NOT NULL CHECK (length(month) = 7),
  threshold TEXT NOT NULL CHECK (threshold IN ('warning', 'exhausted')),
  sent_at BIGINT NOT NULL,
  UNIQUE (tenant_id, meter_key, month, threshold)
);
ALTER TABLE metering_threshold_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE metering_threshold_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY metering_threshold_notices_tenant_policy ON metering_threshold_notices
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/* Mirrors migrations/0002_metering_bucket_export.up.sql byte for byte. */
export const METERING_MIGRATION_002 = `-- The data class export walks a workspace's buckets by id, ascending. The
-- retention index leads with the day, so it cannot serve that walk and a large
-- workspace paged through a sequential scan per page.
CREATE INDEX IF NOT EXISTS metering_buckets_tenant_export_idx
  ON metering_buckets (tenant_id, id);
`;

/** Every tenant table of this module, with the policy each one must carry. */
export const METERING_TENANT_TABLES = [
	'metering_meters',
	'metering_buckets',
	'metering_records',
	'metering_limits',
	'metering_limit_events',
	'metering_threshold_notices',
] as const;

/* One migration creates every table, so adoption is the conjunction: a schema
   carrying only some of them is partial and the runner refuses it rather than
   trusting a half-built one. */
async function tenantTablesState(
	database: DatabaseSession,
): Promise<ExistingMigrationState> {
	const states: ExistingMigrationState[] = [];
	for (const table of METERING_TENANT_TABLES) {
		states.push(
			await postgresTenantTableState(database, table, `${table}_tenant_policy`),
		);
	}
	if (states.every((state) => state === 'complete')) return 'complete';
	if (states.every((state) => state === 'absent')) return 'absent';
	return 'partial';
}

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_metering_core',
		sql: { postgresql: METERING_MIGRATION_001 },
		inspectExisting: (database) => tenantTablesState(database),
	},
	{
		id: '0002_metering_bucket_export',
		sql: { postgresql: METERING_MIGRATION_002 },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasIndex('metering_buckets_tenant_export_idx'),
			]),
	},
];
