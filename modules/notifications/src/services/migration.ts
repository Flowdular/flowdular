import type { DatabaseMigration } from '@flowdular/database';
import {
	migrationObjectState,
	postgresTenantTableState,
} from '@flowdular/database';

/* Mirrors migrations/0001_notifications_core.up.sql byte for byte. */
export const NOTIFICATIONS_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS notifications_inbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  recipient_account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent-run-completed', 'agent-run-failed', 'workflow-run-completed', 'workflow-run-failed', 'webhook-dead-letter')),
  title TEXT NOT NULL,
  body TEXT,
  source_module TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unread', 'read', 'archived')),
  read_at TIMESTAMPTZ,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_inbox_tenant_recipient_account_id_idx
  ON notifications_inbox (tenant_id, recipient_account_id, id);
-- Publishing is idempotent on the source reference. The capability checks first,
-- but this index is what actually guarantees one item per member per event.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_inbox_source_idx
  ON notifications_inbox (tenant_id, recipient_account_id, kind, source_ref);
CREATE INDEX IF NOT EXISTS notifications_inbox_member_status_idx
  ON notifications_inbox (tenant_id, recipient_account_id, status, created_at DESC, id);
ALTER TABLE notifications_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_inbox_tenant_policy ON notifications_inbox
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/* Mirrors migrations/0002_notifications_preferences.up.sql byte for byte. */
export const NOTIFICATIONS_MIGRATION_002_PREFERENCES = `CREATE TABLE IF NOT EXISTS notifications_preferences (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  recipient_account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent-run-completed', 'agent-run-failed', 'workflow-run-completed', 'workflow-run-failed', 'webhook-dead-letter')),
  enabled SMALLINT NOT NULL CHECK (enabled IN (0, 1)),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
-- An absent row means enabled, so one row per member and kind is the whole rule.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_preferences_member_kind_idx
  ON notifications_preferences (tenant_id, recipient_account_id, kind);
ALTER TABLE notifications_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_preferences_tenant_policy ON notifications_preferences
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/* Mirrors migrations/0003_notifications_webhook_subscriptions.up.sql byte for byte. */
export const NOTIFICATIONS_MIGRATION_003_WEBHOOK_SUBSCRIPTIONS = `CREATE TABLE IF NOT EXISTS notifications_webhook_subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events_json TEXT NOT NULL,
  secret_key_id TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  secret_tag TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  secret_fingerprint TEXT NOT NULL,
  secret_revision BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'disabled')),
  description TEXT,
  last_delivery_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  created_by TEXT NOT NULL
);
-- The name is compared normalized, so the index has to normalize too or a
-- duplicate would only be caught by the service it is meant to back up.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_webhook_subscriptions_name_idx
  ON notifications_webhook_subscriptions (tenant_id, lower(name));
CREATE INDEX IF NOT EXISTS notifications_webhook_subscriptions_status_idx
  ON notifications_webhook_subscriptions (tenant_id, status, lower(name), id);
ALTER TABLE notifications_webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications_webhook_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_webhook_subscriptions_tenant_policy ON notifications_webhook_subscriptions
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/* Mirrors migrations/0004_notifications_deliveries.up.sql byte for byte. */
export const NOTIFICATIONS_MIGRATION_004_DELIVERIES = `CREATE TABLE IF NOT EXISTS notifications_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent-run-completed', 'agent-run-failed', 'workflow-run-completed', 'workflow-run-failed', 'webhook-dead-letter')),
  source_module TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  attempt_number BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'dead-letter')),
  scheduled_for BIGINT NOT NULL,
  completed_at BIGINT,
  response_status BIGINT,
  error_class TEXT,
  payload_digest TEXT NOT NULL,
  payload_bytes BIGINT NOT NULL,
  occurred_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
-- One row per attempt. The sequence separates the original attempt run from the
-- ones a replay starts, so publishing the same event twice collides on attempt
-- one of sequence one while a replay still numbers its own attempts from one.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_deliveries_attempt_idx
  ON notifications_deliveries (tenant_id, subscription_id, kind, source_ref, sequence, attempt_number);
CREATE INDEX IF NOT EXISTS notifications_deliveries_routing_idx
  ON notifications_deliveries (status, scheduled_for, tenant_id, id);
CREATE INDEX IF NOT EXISTS notifications_deliveries_tenant_status_idx
  ON notifications_deliveries (tenant_id, status, scheduled_for DESC, id);
CREATE INDEX IF NOT EXISTS notifications_deliveries_retention_idx
  ON notifications_deliveries (tenant_id, completed_at);
ALTER TABLE notifications_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_deliveries_tenant_policy ON notifications_deliveries
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/* Mirrors migrations/0005_notifications_delivery_routing_role.up.sql byte for byte. */
export const NOTIFICATIONS_MIGRATION_005_DELIVERY_ROUTING_ROLE = `-- The delivery loop must find due attempts across tenants, and retention must
-- find the tenants that still hold attempts at all. It is granted exactly the
-- four routing columns: the subscription, the source reference, the digest and
-- the ledger outcome stay invisible to it, and every attempt is read again under
-- the tenant the routing row named before any request leaves the process.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY notifications_deliveries_background_policy ON notifications_deliveries
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON notifications_deliveries FROM coreloom_background;
GRANT SELECT (tenant_id, id, scheduled_for, status) ON notifications_deliveries TO coreloom_background;
`;

/* Mirrors migrations/0006_notifications_delivery_title.up.sql byte for byte. */
export const NOTIFICATIONS_MIGRATION_006_DELIVERY_TITLE = `-- The payload carries the published title so a customer system can show the
-- event without calling back into the source module. It is part of the signed
-- body, so it has to live on the attempt row: a retry and a replay rebuild the
-- payload from the row alone and must produce the same bytes.
--
-- The default is empty rather than absent because the column is NOT NULL and a
-- deployment may already hold attempt rows. Such a row carries no title, so an
-- attempt left pending across this upgrade sends a body with an empty title
-- while the digest on it was taken before the field existed; the retry that
-- attempt schedules is digested from the row again and matches.
ALTER TABLE notifications_deliveries ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
`;

/* Mirrors migrations/0007_notifications_secret_rotation_inventory.up.sql byte for byte. */
export const NOTIFICATIONS_MIGRATION_007_SECRET_ROTATION_INVENTORY = `-- The rotation command has to find the subscriptions still sealed with a
-- retired key before it knows whose they are, and the subscriptions table is
-- invisible to the cross-tenant role: it carries no background policy and the
-- role holds no default table grant. This adds the tenant id and the key id and
-- nothing else. The nonce, the tag, the ciphertext, the URL and the fingerprint
-- stay unreadable on this connection, and every row it re-seals is read again
-- under the tenant that row named.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY notifications_webhook_subscriptions_background_policy ON notifications_webhook_subscriptions
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON notifications_webhook_subscriptions FROM coreloom_background;
GRANT SELECT (tenant_id, secret_key_id) ON notifications_webhook_subscriptions TO coreloom_background;
`;

/* Mirrors migrations/0008_notifications_delivery_claim.up.sql byte for byte. */
export const NOTIFICATIONS_MIGRATION_008_DELIVERY_CLAIM = `-- Two processes drain the same queue during a rolling update, and both see the
-- same due row. The row is claimed under its own tenant before the request
-- leaves: the winner moves it to 'sending' and stamps the claim, the loser's
-- update matches nothing and it moves on, so one pending attempt is one request.
--
-- The claim is a lease, not a ledger outcome. It leaves the attempt number, the
-- response and the error class untouched, and a claim older than the request
-- timeout plus its grace is taken over again so a process that died mid-send
-- strands nothing. 'sending' is why the routing page advances instead of
-- returning the rows another process is already holding.
--
-- The cross-tenant poll is the one that has to find a stranded claim, so
-- claimed_at joins the routing columns the background role may read. It carries
-- a clock reading and nothing about the tenant, the subscription or the payload.
ALTER TABLE notifications_deliveries ADD COLUMN IF NOT EXISTS claimed_at BIGINT;
ALTER TABLE notifications_deliveries DROP CONSTRAINT IF EXISTS notifications_deliveries_status_check;
ALTER TABLE notifications_deliveries ADD CONSTRAINT notifications_deliveries_status_check
  CHECK (status IN ('pending', 'sending', 'succeeded', 'failed', 'dead-letter'));
GRANT SELECT (claimed_at) ON notifications_deliveries TO coreloom_background;
`;

/* Mirrors migrations/0009_notifications_kind_approvals.up.sql byte for byte. */
export const NOTIFICATIONS_MIGRATION_009_KIND_APPROVALS = `-- approvals.core publishes two kinds, so the closed set the inbox, the
-- preferences and the ledger all key off gains approval-requested and
-- approval-decided. Each check was written inline with its column, so it
-- carries the name PostgreSQL derived from it and is replaced under that name.
-- Widening a check reads no row and rewrites none.
--
-- A subscription's selected events are JSON text with no check behind them, so
-- an older subscription keeps exactly the kinds it was saved with and the
-- service is the only thing that decides which ones may be selected next.
ALTER TABLE notifications_inbox DROP CONSTRAINT IF EXISTS notifications_inbox_kind_check;
ALTER TABLE notifications_inbox ADD CONSTRAINT notifications_inbox_kind_check
  CHECK (kind IN ('agent-run-completed', 'agent-run-failed', 'workflow-run-completed', 'workflow-run-failed', 'webhook-dead-letter', 'approval-requested', 'approval-decided'));
ALTER TABLE notifications_preferences DROP CONSTRAINT IF EXISTS notifications_preferences_kind_check;
ALTER TABLE notifications_preferences ADD CONSTRAINT notifications_preferences_kind_check
  CHECK (kind IN ('agent-run-completed', 'agent-run-failed', 'workflow-run-completed', 'workflow-run-failed', 'webhook-dead-letter', 'approval-requested', 'approval-decided'));
ALTER TABLE notifications_deliveries DROP CONSTRAINT IF EXISTS notifications_deliveries_kind_check;
ALTER TABLE notifications_deliveries ADD CONSTRAINT notifications_deliveries_kind_check
  CHECK (kind IN ('agent-run-completed', 'agent-run-failed', 'workflow-run-completed', 'workflow-run-failed', 'webhook-dead-letter', 'approval-requested', 'approval-decided'));
`;

/* Mirrors migrations/0010_notifications_kind_meter_threshold.up.sql byte for byte. */
export const NOTIFICATIONS_MIGRATION_010_KIND_METER_THRESHOLD = `-- metering.core publishes one kind, so the closed set the inbox, the
-- preferences and the ledger all key off gains meter-threshold. Each check was
-- written inline with its column, so it carries the name PostgreSQL derived
-- from it and is replaced under that name. Widening a check reads no row and
-- rewrites none.
--
-- A subscription's selected events are JSON text with no check behind them, so
-- an older subscription keeps exactly the kinds it was saved with and the
-- service is the only thing that decides which ones may be selected next.
ALTER TABLE notifications_inbox DROP CONSTRAINT IF EXISTS notifications_inbox_kind_check;
ALTER TABLE notifications_inbox ADD CONSTRAINT notifications_inbox_kind_check
  CHECK (kind IN ('agent-run-completed', 'agent-run-failed', 'workflow-run-completed', 'workflow-run-failed', 'webhook-dead-letter', 'approval-requested', 'approval-decided', 'meter-threshold'));
ALTER TABLE notifications_preferences DROP CONSTRAINT IF EXISTS notifications_preferences_kind_check;
ALTER TABLE notifications_preferences ADD CONSTRAINT notifications_preferences_kind_check
  CHECK (kind IN ('agent-run-completed', 'agent-run-failed', 'workflow-run-completed', 'workflow-run-failed', 'webhook-dead-letter', 'approval-requested', 'approval-decided', 'meter-threshold'));
ALTER TABLE notifications_deliveries DROP CONSTRAINT IF EXISTS notifications_deliveries_kind_check;
ALTER TABLE notifications_deliveries ADD CONSTRAINT notifications_deliveries_kind_check
  CHECK (kind IN ('agent-run-completed', 'agent-run-failed', 'workflow-run-completed', 'workflow-run-failed', 'webhook-dead-letter', 'approval-requested', 'approval-decided', 'meter-threshold'));
`;

export const NOTIFICATIONS_MIGRATION_011_RETENTION_KEYSET = `-- The workspace data class registry sweeps and exports what this module holds,
-- and both walks key off (tenant_id, created_at, id). Without these indexes the
-- inbox sweep would scan every row of a workspace on every bounded pass and the
-- export keyset would sort the whole table per page, so the cost of one pass
-- would grow with the history rather than with the batch.
--
-- created_at and id never change after a row is written, so a walk over them
-- cannot revisit or skip a row while the table is still being written to. The
-- deliveries ledger already carries (tenant_id, completed_at) for the delivery
-- loop's own retention pass; that key is mutable until an attempt completes and
-- serves the sweep only, so the export gets its own immutable one here.
CREATE INDEX IF NOT EXISTS notifications_inbox_retention_idx
  ON notifications_inbox (tenant_id, created_at, id);
CREATE INDEX IF NOT EXISTS notifications_deliveries_created_idx
  ON notifications_deliveries (tenant_id, created_at, id);
`;

/* The three tables whose kind check 0009 and 0010 replace. */
const KIND_CHECK_TABLES = [
	'notifications_inbox',
	'notifications_preferences',
	'notifications_deliveries',
] as const;

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_notifications_core',
		sql: { postgresql: NOTIFICATIONS_MIGRATION_001 },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'notifications_inbox',
				'notifications_inbox_tenant_policy',
				[
					() =>
						database.schema.hasIndex(
							'notifications_inbox_tenant_recipient_account_id_idx',
						),
					() => database.schema.hasIndex('notifications_inbox_source_idx'),
					() =>
						database.schema.hasIndex('notifications_inbox_member_status_idx'),
				],
			),
	},
	{
		id: '0002_notifications_preferences',
		sql: { postgresql: NOTIFICATIONS_MIGRATION_002_PREFERENCES },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'notifications_preferences',
				'notifications_preferences_tenant_policy',
				[
					() =>
						database.schema.hasIndex(
							'notifications_preferences_member_kind_idx',
						),
				],
			),
	},
	{
		id: '0003_notifications_webhook_subscriptions',
		sql: { postgresql: NOTIFICATIONS_MIGRATION_003_WEBHOOK_SUBSCRIPTIONS },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'notifications_webhook_subscriptions',
				'notifications_webhook_subscriptions_tenant_policy',
				[
					() =>
						database.schema.hasIndex(
							'notifications_webhook_subscriptions_name_idx',
						),
					() =>
						database.schema.hasIndex(
							'notifications_webhook_subscriptions_status_idx',
						),
				],
			),
	},
	{
		id: '0004_notifications_deliveries',
		sql: { postgresql: NOTIFICATIONS_MIGRATION_004_DELIVERIES },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'notifications_deliveries',
				'notifications_deliveries_tenant_policy',
				[
					() =>
						database.schema.hasIndex('notifications_deliveries_attempt_idx'),
					() =>
						database.schema.hasIndex('notifications_deliveries_routing_idx'),
					() =>
						database.schema.hasIndex(
							'notifications_deliveries_tenant_status_idx',
						),
					() =>
						database.schema.hasIndex('notifications_deliveries_retention_idx'),
				],
			),
	},
	{
		id: '0005_notifications_delivery_routing_role',
		sql: { postgresql: NOTIFICATIONS_MIGRATION_005_DELIVERY_ROUTING_ROLE },
		/* A policy and a column grant leave no schema object behind, so the
		   privilege itself is what proves this migration ran. */
		inspectExisting: async (database) => {
			const result = await database.query<{ granted: boolean }>({
				text: `SELECT CASE WHEN to_regclass('notifications_deliveries') IS NOT NULL THEN
				  has_column_privilege('coreloom_background', 'notifications_deliveries', 'scheduled_for', 'SELECT')
				ELSE false END AS granted`,
			});
			return result.rows[0]?.granted === true ? 'complete' : 'absent';
		},
	},
	{
		id: '0006_notifications_delivery_title',
		sql: { postgresql: NOTIFICATIONS_MIGRATION_006_DELIVERY_TITLE },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasColumn('notifications_deliveries', 'title'),
			]),
	},
	{
		id: '0007_notifications_secret_rotation_inventory',
		sql: { postgresql: NOTIFICATIONS_MIGRATION_007_SECRET_ROTATION_INVENTORY },
		/* A policy and a column grant leave no schema object behind, so the
		   privilege itself is what proves this migration ran. */
		inspectExisting: async (database) => {
			const result = await database.query<{ granted: boolean }>({
				text: `SELECT CASE WHEN to_regclass('notifications_webhook_subscriptions') IS NOT NULL THEN
				  has_column_privilege('coreloom_background', 'notifications_webhook_subscriptions', 'secret_key_id', 'SELECT')
				ELSE false END AS granted`,
			});
			return result.rows[0]?.granted === true ? 'complete' : 'absent';
		},
	},
	{
		id: '0008_notifications_delivery_claim',
		sql: { postgresql: NOTIFICATIONS_MIGRATION_008_DELIVERY_CLAIM },
		/* Only the column is a schema object; the widened check constraint and the
		   column grant leave none, so each is proved against the catalogue and a
		   schema carrying just some of the three is partial. */
		inspectExisting: (database) =>
			migrationObjectState([
				() =>
					database.schema.hasColumn('notifications_deliveries', 'claimed_at'),
				async () =>
					(
						await database.query<{ present: boolean }>({
							text: `SELECT EXISTS (
							  SELECT 1 FROM pg_constraint
							  WHERE conrelid = to_regclass('notifications_deliveries')
							    AND conname = 'notifications_deliveries_status_check'
							    AND pg_get_constraintdef(oid) LIKE '%sending%'
							) AS present`,
						})
					).rows[0]?.present === true,
				async () =>
					(
						await database.query<{ granted: boolean }>({
							/* The privilege probe raises on a column that is not there yet,
							   so the column has to be proved before it is asked about. */
							text: `SELECT CASE WHEN EXISTS (
							  SELECT 1 FROM pg_attribute
							  WHERE attrelid = to_regclass('notifications_deliveries')
							    AND attname = 'claimed_at' AND NOT attisdropped
							) THEN
							  has_column_privilege('coreloom_background', 'notifications_deliveries', 'claimed_at', 'SELECT')
							ELSE false END AS granted`,
						})
					).rows[0]?.granted === true,
			]),
	},
	{
		id: '0009_notifications_kind_approvals',
		sql: { postgresql: NOTIFICATIONS_MIGRATION_009_KIND_APPROVALS },
		/* A replaced check constraint leaves no new schema object behind, so each
		   of the three is proved against the catalogue and a schema carrying only
		   some of them is partial. */
		inspectExisting: (database) =>
			migrationObjectState(
				KIND_CHECK_TABLES.map(
					(table) => async () =>
						(
							await database.query<{ present: boolean }>({
								text: `SELECT EXISTS (
							  SELECT 1 FROM pg_constraint
							  WHERE conrelid = to_regclass($1)
							    AND conname = $2
							    AND pg_get_constraintdef(oid) LIKE '%approval-decided%'
							) AS present`,
								parameters: [table, `${table}_kind_check`],
							})
						).rows[0]?.present === true,
				),
			),
	},
	{
		id: '0010_notifications_kind_meter_threshold',
		sql: { postgresql: NOTIFICATIONS_MIGRATION_010_KIND_METER_THRESHOLD },
		/* A replaced check constraint leaves no new schema object behind, so each
		   of the three is proved against the catalogue and a schema carrying only
		   some of them is partial. */
		inspectExisting: (database) =>
			migrationObjectState(
				KIND_CHECK_TABLES.map(
					(table) => async () =>
						(
							await database.query<{ present: boolean }>({
								text: `SELECT EXISTS (
							  SELECT 1 FROM pg_constraint
							  WHERE conrelid = to_regclass($1)
							    AND conname = $2
							    AND pg_get_constraintdef(oid) LIKE '%meter-threshold%'
							) AS present`,
								parameters: [table, `${table}_kind_check`],
							})
						).rows[0]?.present === true,
				),
			),
	},
	{
		id: '0011_notifications_retention_keyset',
		sql: { postgresql: NOTIFICATIONS_MIGRATION_011_RETENTION_KEYSET },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasIndex('notifications_inbox_retention_idx'),
				() => database.schema.hasIndex('notifications_deliveries_created_idx'),
			]),
	},
];
