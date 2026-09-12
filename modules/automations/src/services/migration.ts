import type { DatabaseMigration, DatabaseSession } from '@flowdular/database';
import {
	migrationObjectState,
	postgresTenantTableState,
} from '@flowdular/database';

/* Mirrors migrations/0001_automations_core.up.sql byte for byte. */
export const AUTOMATIONS_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS automations_schedules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  label TEXT NOT NULL,
  input_template TEXT NOT NULL,
  cadence TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  disabled_reason TEXT,
  next_run_at BIGINT NOT NULL,
  last_run_at BIGINT,
  last_run_id TEXT,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS automations_schedules_tenant_label_idx
  ON automations_schedules (tenant_id, label, id);
CREATE INDEX IF NOT EXISTS automations_schedules_due_idx
  ON automations_schedules (enabled, next_run_at, id);

CREATE TABLE IF NOT EXISTS automations_triggers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  label TEXT NOT NULL,
  secret_key_id TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  secret_tag TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  secret_revision INTEGER NOT NULL CHECK (secret_revision > 0),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  created_by TEXT NOT NULL,
  last_fired_at BIGINT,
  accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0)
);
CREATE INDEX IF NOT EXISTS automations_triggers_tenant_label_idx
  ON automations_triggers (tenant_id, label, id);

CREATE TABLE IF NOT EXISTS automations_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (
    subject_type IN ('automation-schedule', 'automation-trigger')
  ),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence)
);
CREATE INDEX IF NOT EXISTS automations_audit_tenant_time_idx
  ON automations_audit_events (tenant_id, occurred_at DESC, sequence DESC);
ALTER TABLE automations_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY automations_schedules_tenant_policy ON automations_schedules
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE automations_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations_triggers FORCE ROW LEVEL SECURITY;
CREATE POLICY automations_triggers_tenant_policy ON automations_triggers
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE automations_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY automations_audit_events_tenant_policy ON automations_audit_events
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/* Mirrors migrations/0002_automations_targets.up.sql byte for byte. */
export const AUTOMATIONS_MIGRATION_002 = `ALTER TABLE automations_schedules
  ADD COLUMN IF NOT EXISTS target_kind TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE automations_schedules
  ADD COLUMN IF NOT EXISTS target_key TEXT;
ALTER TABLE automations_schedules
  ADD COLUMN IF NOT EXISTS configured_by_json TEXT;
ALTER TABLE automations_schedules
  ADD COLUMN IF NOT EXISTS permission_snapshot_json TEXT NOT NULL DEFAULT '[]';
UPDATE automations_schedules
SET target_key = agent_id
WHERE target_key IS NULL;
UPDATE automations_schedules
SET configured_by_json = json_build_object(
  'kind', 'user',
  'id', created_by,
  'label', created_by
)::text
WHERE configured_by_json IS NULL;

ALTER TABLE automations_triggers
  ADD COLUMN IF NOT EXISTS target_kind TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE automations_triggers
  ADD COLUMN IF NOT EXISTS target_key TEXT;
ALTER TABLE automations_triggers
  ADD COLUMN IF NOT EXISTS configured_by_json TEXT;
ALTER TABLE automations_triggers
  ADD COLUMN IF NOT EXISTS permission_snapshot_json TEXT NOT NULL DEFAULT '[]';
UPDATE automations_triggers
SET target_key = agent_id
WHERE target_key IS NULL;
UPDATE automations_triggers
SET configured_by_json = json_build_object(
  'kind', 'user',
  'id', created_by,
  'label', created_by
)::text
WHERE configured_by_json IS NULL;
`;

/* Mirrors migrations/0003_automations_scheduler_role.up.sql byte for byte. */
export const AUTOMATIONS_MIGRATION_003_SCHEDULER_ROLE = `CREATE INDEX IF NOT EXISTS automations_schedules_routing_idx
  ON automations_schedules (enabled, next_run_at, tenant_id, id);
-- The scheduler must find due work across tenants. It is granted exactly the
-- columns the poll reads and nothing else: labels, templates, the configuring
-- actor and the permission snapshot stay invisible to it, and the schedule is
-- read again under its own tenant before anything acts on it. PostgreSQL checks
-- column privileges in WHERE too, so \`enabled\` is part of the grant.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY automations_schedules_background_policy ON automations_schedules
  FOR SELECT TO coreloom_background
  USING (enabled = 1);
REVOKE SELECT ON automations_schedules FROM coreloom_background;
GRANT SELECT (tenant_id, id, next_run_at, enabled) ON automations_schedules TO coreloom_background;
`;

/* Mirrors migrations/0004_automations_trigger_routing_role.up.sql byte for byte. */
export const AUTOMATIONS_MIGRATION_004_TRIGGER_ROUTING_ROLE = `CREATE INDEX IF NOT EXISTS automations_triggers_routing_idx
  ON automations_triggers (id, tenant_id);
-- A webhook arrives with a trigger id and no tenant, so the lookup must cross
-- tenants. It is granted exactly the two columns that route it: the secret, the
-- label, the target and the permission snapshot are read again under the tenant
-- this returned, before anything is verified or fired.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY automations_triggers_background_policy ON automations_triggers
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON automations_triggers FROM coreloom_background;
GRANT SELECT (tenant_id, id) ON automations_triggers TO coreloom_background;
`;

export const AUTOMATIONS_MIGRATION_005_SECRET_ROTATION_INVENTORY = `-- The rotation command has to find the triggers still sealed with a retired key
-- before it knows whose they are. The cross-tenant lookup already reads the two
-- routing columns; this adds the key id and nothing else. The nonce, the tag and
-- the ciphertext stay unreadable on this connection, and every row it re-seals
-- is read again under the tenant that row named.
GRANT SELECT (secret_key_id) ON automations_triggers TO coreloom_background;
`;

/* Narrowed to this schema's relation through to_regclass and never deparsed:
   a deparse over the whole catalogue reaches relations another connection is
   dropping and fails with a cache lookup error instead of an answer. */
async function backgroundPolicyPresent(
	database: DatabaseSession,
	table: string,
	policy: string,
): Promise<boolean> {
	const result = await database.query<{ present: boolean }>({
		text: `SELECT EXISTS (
		         SELECT 1 FROM pg_policy
		         WHERE polrelid = to_regclass('${table}') AND polname = '${policy}'
		       ) AS present`,
	});
	return result.rows[0]?.present === true;
}

async function backgroundColumnGranted(
	database: DatabaseSession,
	table: string,
	column: string,
): Promise<boolean> {
	const result = await database.query<{ granted: boolean }>({
		text: `SELECT CASE WHEN to_regclass('${table}') IS NOT NULL THEN
		  has_column_privilege('coreloom_background', '${table}', '${column}', 'SELECT')
		ELSE false END AS granted`,
	});
	return result.rows[0]?.granted === true;
}

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_automations_core',
		sql: { postgresql: AUTOMATIONS_MIGRATION_001 },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'automations_schedules',
				'automations_schedules_tenant_policy',
				[
					() => database.schema.hasTable('automations_triggers'),
					() => database.schema.hasTable('automations_audit_events'),
					() => database.schema.hasIndex('automations_schedules_due_idx'),
					() => database.schema.hasIndex('automations_audit_tenant_time_idx'),
				],
			),
	},
	{
		id: '0002_automations_targets',
		sql: { postgresql: AUTOMATIONS_MIGRATION_002 },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasColumn('automations_schedules', 'target_kind'),
				() => database.schema.hasColumn('automations_schedules', 'target_key'),
				() =>
					database.schema.hasColumn(
						'automations_schedules',
						'configured_by_json',
					),
				() => database.schema.hasColumn('automations_triggers', 'target_kind'),
				() => database.schema.hasColumn('automations_triggers', 'target_key'),
				() =>
					database.schema.hasColumn(
						'automations_triggers',
						'configured_by_json',
					),
			]),
	},
	{
		id: '0003_automations_scheduler_role',
		sql: { postgresql: AUTOMATIONS_MIGRATION_003_SCHEDULER_ROLE },
		/* The index is one of three objects; the background policy and the
		   column grant leave nothing the schema reader sees, so each is proved
		   against the catalogue and a schema carrying only some is partial. */
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasIndex('automations_schedules_routing_idx'),
				() =>
					backgroundPolicyPresent(
						database,
						'automations_schedules',
						'automations_schedules_background_policy',
					),
				() =>
					backgroundColumnGranted(
						database,
						'automations_schedules',
						'next_run_at',
					),
			]),
	},
	{
		id: '0004_automations_trigger_routing_role',
		sql: { postgresql: AUTOMATIONS_MIGRATION_004_TRIGGER_ROUTING_ROLE },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasIndex('automations_triggers_routing_idx'),
				() =>
					backgroundPolicyPresent(
						database,
						'automations_triggers',
						'automations_triggers_background_policy',
					),
				() =>
					backgroundColumnGranted(
						database,
						'automations_triggers',
						'tenant_id',
					),
			]),
	},
	{
		id: '0005_secret_rotation_inventory',
		sql: { postgresql: AUTOMATIONS_MIGRATION_005_SECRET_ROTATION_INVENTORY },
		/* A grant leaves no object behind, so the column privilege itself is what
		   proves this migration ran. */
		inspectExisting: async (database) => {
			const result = await database.query<{ granted: boolean }>({
				text: `SELECT CASE WHEN to_regclass('automations_triggers') IS NOT NULL THEN
				  has_column_privilege('coreloom_background', 'automations_triggers', 'secret_key_id', 'SELECT')
				ELSE false END AS granted`,
			});
			return result.rows[0]?.granted === true ? 'complete' : 'absent';
		},
	},
];
