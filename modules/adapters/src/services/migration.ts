import type {
	DatabaseMigration,
	DatabaseSession,
	ExistingMigrationState,
} from '@flowdular/database';
import { postgresTenantTableState } from '@flowdular/database';

/* Mirrors migrations/0001_adapters_core.up.sql byte for byte;
   tests/migrations.test.ts fails on drift. */
export const ADAPTERS_MIGRATION_001 = `-- One row per workspace and registered adapter: the connector instance an
-- owner bound, the switch, the mapping and schedule overrides, and the next
-- scheduled time the schedule runner claims with a compare and swap.
CREATE TABLE IF NOT EXISTS adapter_bindings (
  tenant_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL CHECK (length(adapter_id) BETWEEN 3 AND 96),
  instance_id TEXT CHECK (instance_id IS NULL OR length(instance_id) BETWEEN 1 AND 128),
  enabled SMALLINT NOT NULL CHECK (enabled IN (0, 1)),
  mapping_json TEXT CHECK (mapping_json IS NULL OR (length(mapping_json) <= 32768 AND mapping_json::jsonb IS NOT NULL)),
  schedule TEXT CHECK (schedule IS NULL OR length(schedule) <= 100),
  next_run_at BIGINT,
  updated_by TEXT CHECK (updated_by IS NULL OR length(updated_by) BETWEEN 1 AND 128),
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, adapter_id)
);
CREATE INDEX IF NOT EXISTS adapter_bindings_due_idx
  ON adapter_bindings (next_run_at, tenant_id, adapter_id)
  WHERE enabled = 1 AND next_run_at IS NOT NULL;
ALTER TABLE adapter_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE adapter_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY adapter_bindings_tenant_policy ON adapter_bindings
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- One pull or push. The claim is a lease the job runner renews; the cursor and
-- the counts move together once per committed page, so a reclaimed run
-- continues from the page after the last one it committed.
CREATE TABLE IF NOT EXISTS adapter_runs (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  adapter_id TEXT NOT NULL CHECK (length(adapter_id) BETWEEN 3 AND 96),
  direction TEXT NOT NULL CHECK (direction IN ('source', 'sink')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'schedule', 'resume')),
  resumed_from TEXT CHECK (resumed_from IS NULL OR length(resumed_from) BETWEEN 1 AND 64),
  cursor TEXT CHECK (cursor IS NULL OR length(cursor) <= 2048),
  pages BIGINT NOT NULL CHECK (pages >= 0),
  rows_read BIGINT NOT NULL CHECK (rows_read >= 0),
  rows_created BIGINT NOT NULL CHECK (rows_created >= 0),
  rows_updated BIGINT NOT NULL CHECK (rows_updated >= 0),
  rows_skipped BIGINT NOT NULL CHECK (rows_skipped >= 0),
  rows_failed BIGINT NOT NULL CHECK (rows_failed >= 0),
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  claimed_by TEXT CHECK (claimed_by IS NULL OR length(claimed_by) BETWEEN 1 AND 64),
  lease_until BIGINT,
  queued_at BIGINT NOT NULL,
  started_at BIGINT,
  finished_at BIGINT,
  started_by TEXT CHECK (started_by IS NULL OR length(started_by) BETWEEN 1 AND 128),
  PRIMARY KEY (tenant_id, id),
  CHECK ((status IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL))
);
-- One queued or running run per adapter, whoever starts it.
CREATE UNIQUE INDEX IF NOT EXISTS adapter_runs_active_idx
  ON adapter_runs (tenant_id, adapter_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS adapter_runs_tenant_queued_idx
  ON adapter_runs (tenant_id, queued_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS adapter_runs_tenant_adapter_queued_idx
  ON adapter_runs (tenant_id, adapter_id, queued_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS adapter_runs_tenant_finished_idx
  ON adapter_runs (tenant_id, finished_at, id)
  WHERE finished_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS adapter_runs_routing_idx
  ON adapter_runs (status, queued_at, tenant_id, id);
ALTER TABLE adapter_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE adapter_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY adapter_runs_tenant_policy ON adapter_runs
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- The outcome of one record a run handled, keyed by its index in the run so a
-- page written again after a reclaim replaces its own rows.
CREATE TABLE IF NOT EXISTS adapter_run_rows (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  row_index BIGINT NOT NULL CHECK (row_index >= 1),
  natural_key TEXT CHECK (natural_key IS NULL OR length(natural_key) BETWEEN 1 AND 200),
  outcome TEXT NOT NULL CHECK (outcome IN ('created', 'updated', 'skipped', 'invalid', 'failed', 'pushed')),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
  message TEXT CHECK (message IS NULL OR length(message) BETWEEN 1 AND 200),
  PRIMARY KEY (tenant_id, run_id, row_index),
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES adapter_runs (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE adapter_run_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE adapter_run_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY adapter_run_rows_tenant_policy ON adapter_run_rows
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

CREATE TABLE IF NOT EXISTS adapter_audit_events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  adapter_id TEXT NOT NULL CHECK (length(adapter_id) BETWEEN 3 AND 96),
  run_id TEXT CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 64),
  action TEXT NOT NULL CHECK (action IN ('binding-saved', 'binding-enabled', 'binding-disabled', 'run-started', 'run-resumed', 'run-cancelled', 'schedule-skipped')),
  actor_id TEXT CHECK (actor_id IS NULL OR length(actor_id) BETWEEN 1 AND 128),
  metadata_json TEXT NOT NULL CHECK (length(metadata_json) <= 2048 AND metadata_json::jsonb IS NOT NULL),
  occurred_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS adapter_audit_events_tenant_time_idx
  ON adapter_audit_events (tenant_id, occurred_at, id);
ALTER TABLE adapter_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE adapter_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY adapter_audit_events_tenant_policy ON adapter_audit_events
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- The two poll loops find work across workspaces before they know whose it
-- is, so they read routing columns alone on the background role, and every
-- claim runs again under the workspace the routing row named. PostgreSQL
-- checks column privileges in WHERE too, so every filtered column is granted.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY adapter_runs_background_policy ON adapter_runs
  FOR SELECT TO coreloom_background
  USING (status IN ('queued', 'running'));
REVOKE SELECT ON adapter_runs FROM coreloom_background;
GRANT SELECT (tenant_id, id, status, queued_at, lease_until) ON adapter_runs TO coreloom_background;
CREATE POLICY adapter_bindings_background_policy ON adapter_bindings
  FOR SELECT TO coreloom_background
  USING (enabled = 1 AND next_run_at IS NOT NULL);
REVOKE SELECT ON adapter_bindings FROM coreloom_background;
GRANT SELECT (tenant_id, adapter_id, enabled, next_run_at) ON adapter_bindings TO coreloom_background;
`;

/** Every tenant table of this module, children before the table they reference. */
export const ADAPTERS_TENANT_TABLES = [
	'adapter_run_rows',
	'adapter_runs',
	'adapter_bindings',
	'adapter_audit_events',
] as const;

async function combined(
	states: readonly Promise<ExistingMigrationState>[],
): Promise<ExistingMigrationState> {
	const resolved: ExistingMigrationState[] = [];
	for (const state of states) resolved.push(await state);
	if (resolved.every((state) => state === 'complete')) return 'complete';
	if (resolved.every((state) => state === 'absent')) return 'absent';
	return 'partial';
}

/* A policy and a column grant leave no schema object behind, so the privilege
   itself is what proves the routing part ran. */
async function routingGranted(
	database: DatabaseSession,
): Promise<ExistingMigrationState> {
	const result = await database.query<{ granted: boolean }>({
		text: `SELECT CASE WHEN to_regclass('adapter_runs') IS NOT NULL
		              AND to_regclass('adapter_bindings') IS NOT NULL THEN
		  has_column_privilege('coreloom_background', 'adapter_runs', 'lease_until', 'SELECT')
		  AND has_column_privilege('coreloom_background', 'adapter_bindings', 'next_run_at', 'SELECT')
		ELSE false END AS granted`,
	});
	return result.rows[0]?.granted ? 'complete' : 'absent';
}

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_adapters_core',
		sql: { postgresql: ADAPTERS_MIGRATION_001 },
		inspectExisting: async (database) => {
			const tables = await combined([
				postgresTenantTableState(
					database,
					'adapter_bindings',
					'adapter_bindings_tenant_policy',
					[() => database.schema.hasIndex('adapter_bindings_due_idx')],
				),
				postgresTenantTableState(
					database,
					'adapter_runs',
					'adapter_runs_tenant_policy',
					[
						() => database.schema.hasIndex('adapter_runs_active_idx'),
						() => database.schema.hasIndex('adapter_runs_tenant_queued_idx'),
						() =>
							database.schema.hasIndex(
								'adapter_runs_tenant_adapter_queued_idx',
							),
						() => database.schema.hasIndex('adapter_runs_tenant_finished_idx'),
						() => database.schema.hasIndex('adapter_runs_routing_idx'),
					],
				),
				postgresTenantTableState(
					database,
					'adapter_run_rows',
					'adapter_run_rows_tenant_policy',
				),
				postgresTenantTableState(
					database,
					'adapter_audit_events',
					'adapter_audit_events_tenant_policy',
					[
						() =>
							database.schema.hasIndex('adapter_audit_events_tenant_time_idx'),
					],
				),
			]);
			if (tables !== 'complete') return tables;
			return (await routingGranted(database)) === 'complete'
				? 'complete'
				: 'partial';
		},
	},
];
