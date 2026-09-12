import type {
	DatabaseMigration,
	DatabaseSession,
	ExistingMigrationState,
} from '@flowdular/database';
import {
	migrationObjectState,
	postgresTenantTableState,
} from '@flowdular/database';

/* Mirrors migrations/0001_audit_core.up.sql byte for byte. */
export const AUDIT_MIGRATION_001 = `-- One row per workspace and declared class, materialised from the registry the
-- first time the workspace reads it and refreshed on every read afterwards. The
-- registry stays the truth about what a class is; this row carries only what
-- the workspace owns: its period and when the sweep last ran.
--
-- retention_mode separates the two absent states the period has: 'default'
-- follows the declaring module, 'none' keeps the rows until a person deletes
-- them, and 'days' is the workspace's own number. A single nullable integer
-- could not tell the first two apart.
CREATE TABLE IF NOT EXISTS audit_data_classes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  label TEXT NOT NULL,
  exportable SMALLINT NOT NULL CHECK (exportable IN (0, 1)),
  sweepable SMALLINT NOT NULL CHECK (sweepable IN (0, 1)),
  default_retention_days BIGINT,
  retention_mode TEXT NOT NULL CHECK (retention_mode IN ('default', 'days', 'none')),
  retention_days BIGINT CHECK (retention_days IS NULL OR retention_days > 0),
  last_swept_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK ((retention_mode = 'days') = (retention_days IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS audit_data_classes_tenant_class_idx
  ON audit_data_classes (tenant_id, class_id);
-- The sweep walks this index across tenants on the routing role. Ordering by
-- last_swept_at first makes the walk start at the classes waiting longest.
CREATE INDEX IF NOT EXISTS audit_data_classes_due_idx
  ON audit_data_classes (sweepable, last_swept_at, tenant_id, class_id);
ALTER TABLE audit_data_classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_data_classes FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_data_classes_tenant_policy ON audit_data_classes
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

CREATE TABLE IF NOT EXISTS audit_sweep_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  cutoff BIGINT NOT NULL,
  removed BIGINT NOT NULL CHECK (removed >= 0),
  status TEXT NOT NULL CHECK (status IN ('completed', 'partial', 'refused')),
  reason TEXT,
  occurred_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_sweep_runs_tenant_time_idx
  ON audit_sweep_runs (tenant_id, occurred_at DESC, id);
-- A refusal stands until it is answered, so the loop asks for the newest run of
-- one class instead of appending the same refusal every interval.
CREATE INDEX IF NOT EXISTS audit_sweep_runs_tenant_class_time_idx
  ON audit_sweep_runs (tenant_id, class_id, occurred_at DESC, id);
ALTER TABLE audit_sweep_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_sweep_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_sweep_runs_tenant_policy ON audit_sweep_runs
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- row_count rather than "rows": ROWS is a PostgreSQL keyword and an unquoted
-- column of that name would have to be quoted at every use site.
CREATE TABLE IF NOT EXISTS audit_export_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  format_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  classes BIGINT NOT NULL CHECK (classes >= 0),
  row_count BIGINT NOT NULL CHECK (row_count >= 0),
  archive_digest TEXT,
  requested_by TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  completed_at BIGINT
);
CREATE INDEX IF NOT EXISTS audit_export_runs_tenant_time_idx
  ON audit_export_runs (tenant_id, started_at DESC, id);
ALTER TABLE audit_export_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_export_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_export_runs_tenant_policy ON audit_export_runs
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- auth.core keeps its trail private to its own service, and it registers no
-- public capability, so a module cannot append to it. This is audit.core's own
-- tamper-evident trail: one chain per workspace, each event sealing the hash of
-- the one before it, so a removed or edited row breaks every hash after it.
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('data-class', 'sweep-run', 'export-run')),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, event_hash)
);
CREATE INDEX IF NOT EXISTS audit_events_tenant_time_idx
  ON audit_events (tenant_id, occurred_at DESC, sequence DESC);
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_tenant_policy ON audit_events
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/* Mirrors migrations/0002_audit_sweep_routing_role.up.sql byte for byte. */
export const AUDIT_MIGRATION_002_SWEEP_ROUTING_ROLE = `-- The retention sweep must find the classes that are due across every
-- workspace before it knows whose they are. It is granted exactly the routing
-- and policy columns of audit_data_classes: the human label and the owning
-- module id stay invisible to it, and every class it picks is read again under
-- the workspace the routing row named before a single row is removed.
--
-- The retention columns are part of the routing set on purpose. Without them
-- the cross-tenant read cannot tell a class that is kept for ever from one that
-- is due, and the loop would re-read the same never-due classes every interval.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY audit_data_classes_background_policy ON audit_data_classes
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON audit_data_classes FROM coreloom_background;
GRANT SELECT (tenant_id, class_id, sweepable, retention_mode, retention_days, default_retention_days, last_swept_at) ON audit_data_classes TO coreloom_background;
`;

/* Mirrors migrations/0003_audit_export_request.up.sql byte for byte. */
export const AUDIT_MIGRATION_003_EXPORT_REQUEST = `-- An export is a request the running platform answers. The operator command
-- records the row and waits; the platform process, the only one holding the
-- sealed data class registry with every owner port, performs the export and
-- records what it wrote. The request columns are what the operator asked for,
-- the result columns what the platform produced, and claimed_at is the lease
-- that keeps two platform processes from writing one archive twice.
ALTER TABLE audit_export_runs ADD COLUMN IF NOT EXISTS output_directory TEXT;
ALTER TABLE audit_export_runs ADD COLUMN IF NOT EXISTS dry_run SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE audit_export_runs ADD COLUMN IF NOT EXISTS workspace_slug TEXT;
ALTER TABLE audit_export_runs ADD COLUMN IF NOT EXISTS workspace_name TEXT;
ALTER TABLE audit_export_runs ADD COLUMN IF NOT EXISTS archive_path TEXT;
ALTER TABLE audit_export_runs ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE audit_export_runs ADD COLUMN IF NOT EXISTS summary_json TEXT;
ALTER TABLE audit_export_runs ADD COLUMN IF NOT EXISTS claimed_at BIGINT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_export_runs_dry_run_check') THEN
    ALTER TABLE audit_export_runs
      ADD CONSTRAINT audit_export_runs_dry_run_check CHECK (dry_run IN (0, 1));
  END IF;
END
$$;
-- The platform loop finds requested runs across workspaces before it knows
-- whose they are, so it reads the routing columns alone on the background
-- role; every run it picks is read again under the workspace the routing row
-- named before a single byte is written.
CREATE INDEX IF NOT EXISTS audit_export_runs_pending_idx
  ON audit_export_runs (status, started_at, tenant_id, id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY audit_export_runs_background_policy ON audit_export_runs
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON audit_export_runs FROM coreloom_background;
GRANT SELECT (tenant_id, id, status, started_at) ON audit_export_runs TO coreloom_background;
`;

/* Mirrors migrations/0004_audit_hold_seal_erasure.up.sql byte for byte. */
export const AUDIT_MIGRATION_004_HOLD_SEAL_ERASURE = `-- Sealing, legal hold and erasure on request. Three tables and four columns.
--
-- audit_anchors closes segments of the per-workspace event chain. An anchor
-- seals the sequence range, the row count, the time range, the hash chain over
-- the segment continuing from the anchor before it, and the hash of that anchor
-- itself; the signature is HMAC-SHA256 over the anchor hash, so re-signing
-- under a rotated key changes the signature and the key id alone and every
-- segment file already written still verifies.
CREATE TABLE IF NOT EXISTS audit_anchors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  anchor_sequence BIGINT NOT NULL CHECK (anchor_sequence > 0),
  from_sequence BIGINT NOT NULL CHECK (from_sequence > 0),
  to_sequence BIGINT NOT NULL,
  row_count BIGINT NOT NULL CHECK (row_count > 0),
  first_occurred_at BIGINT NOT NULL,
  last_occurred_at BIGINT NOT NULL,
  segment_hash TEXT NOT NULL,
  previous_anchor_hash TEXT,
  anchor_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  key_id TEXT NOT NULL,
  segment_file TEXT NOT NULL,
  sealed_by TEXT NOT NULL,
  sealed_at BIGINT NOT NULL,
  CHECK (to_sequence >= from_sequence),
  UNIQUE (tenant_id, anchor_sequence),
  UNIQUE (tenant_id, to_sequence),
  UNIQUE (tenant_id, anchor_hash)
);
-- The newest anchor of a workspace is read before every seal and before every
-- sweep of the event class, so it is the one lookup that has to stay O(1).
CREATE INDEX IF NOT EXISTS audit_anchors_tenant_sequence_idx
  ON audit_anchors (tenant_id, anchor_sequence DESC);
ALTER TABLE audit_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_anchors FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_anchors_tenant_policy ON audit_anchors
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- A hold is a standing instruction not to remove what it covers. scope_kind
-- names the dimension it was placed on and the nullable columns narrow it
-- further, so an account hold limited to one class and one date range is one
-- row rather than three. A lifted hold is kept: who lifted it and why is the
-- evidence that the data became removable again.
CREATE TABLE IF NOT EXISTS audit_legal_holds (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('account', 'workspace', 'data-class', 'date-range')),
  account_id TEXT,
  class_id TEXT,
  from_at BIGINT,
  to_at BIGINT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'lifted')),
  placed_by TEXT NOT NULL,
  placed_at BIGINT NOT NULL,
  lifted_by TEXT,
  lift_reason TEXT,
  lifted_at BIGINT,
  CHECK (scope_kind <> 'account' OR account_id IS NOT NULL),
  CHECK (scope_kind <> 'data-class' OR class_id IS NOT NULL),
  CHECK (scope_kind <> 'date-range' OR (from_at IS NOT NULL AND to_at IS NOT NULL)),
  CHECK (scope_kind <> 'workspace' OR (account_id IS NULL AND class_id IS NULL
         AND from_at IS NULL AND to_at IS NULL)),
  CHECK (from_at IS NULL OR to_at IS NULL OR to_at >= from_at),
  CHECK ((status = 'lifted') = (lifted_at IS NOT NULL))
);
-- The sweep and every erasure ask for the active holds of one workspace before
-- they touch a row, so that read walks an index instead of the table.
CREATE INDEX IF NOT EXISTS audit_legal_holds_tenant_status_idx
  ON audit_legal_holds (tenant_id, status, placed_at DESC, id);
ALTER TABLE audit_legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_legal_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_legal_holds_tenant_policy ON audit_legal_holds
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- One data key per subject. Audit events are excluded from erasure because they
-- are the evidence the lifecycle happened, so the subject-identifying fields of
-- a new event are sealed under this key instead: destroying the key blanks the
-- material and the account it belonged to, and what is left is a tombstone that
-- proves an event existed and can never be read again. The row stays so the
-- events that point at it keep a target, and the chain hash covers the sealed
-- bytes rather than the plaintext, so destruction never breaks verification.
CREATE TABLE IF NOT EXISTS audit_subject_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject TEXT,
  material TEXT,
  sealed_at BIGINT NOT NULL,
  destroyed_at BIGINT,
  CHECK ((subject IS NULL) = (material IS NULL)),
  CHECK ((destroyed_at IS NULL) = (material IS NOT NULL))
);
-- Partial, because every destroyed key carries a null subject and two of them
-- would collide under a total unique index.
CREATE UNIQUE INDEX IF NOT EXISTS audit_subject_keys_tenant_subject_idx
  ON audit_subject_keys (tenant_id, subject)
  WHERE subject IS NOT NULL;
ALTER TABLE audit_subject_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_subject_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_subject_keys_tenant_policy ON audit_subject_keys
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- An erasure is a request the running platform answers, for the same reason an
-- export is: only the platform process holds the registrations every owning
-- module made, so only it can reach an erase operation. The operator command
-- records the row and waits. The subject is kept while the run needs it and
-- blanked when it finishes, so the history proves an erasure happened without
-- naming the person it erased; subject_marker is the same hash the certificate
-- file is named after, which is what ties the two together.
CREATE TABLE IF NOT EXISTS audit_erasure_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject TEXT,
  subject_marker TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested', 'completed', 'failed')),
  dry_run SMALLINT NOT NULL CHECK (dry_run IN (0, 1)),
  destroy_key SMALLINT NOT NULL CHECK (destroy_key IN (0, 1)),
  requested_by TEXT NOT NULL,
  output_directory TEXT,
  workspace_slug TEXT,
  workspace_name TEXT,
  classes BIGINT NOT NULL CHECK (classes >= 0),
  row_count BIGINT NOT NULL CHECK (row_count >= 0),
  certificate_path TEXT,
  outcome_json TEXT,
  reason TEXT,
  claimed_at BIGINT,
  started_at BIGINT NOT NULL,
  completed_at BIGINT
);
CREATE INDEX IF NOT EXISTS audit_erasure_runs_tenant_time_idx
  ON audit_erasure_runs (tenant_id, started_at DESC, id);
CREATE INDEX IF NOT EXISTS audit_erasure_runs_pending_idx
  ON audit_erasure_runs (status, started_at, tenant_id, id);
ALTER TABLE audit_erasure_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_erasure_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_erasure_runs_tenant_policy ON audit_erasure_runs
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

-- A sealed event keeps its actor and subject columns at a fixed marker and
-- carries the envelope beside them. The event hash reads the envelope in the
-- place the metadata used to sit, so the hash of a sealed row is a function of
-- the stored bytes alone and stays verifiable after the key is destroyed.
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS subject_key_id TEXT;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS sealed_payload TEXT;
ALTER TABLE audit_sweep_runs ADD COLUMN IF NOT EXISTS held_back BIGINT;
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_subject_type_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_events_subject_type_check') THEN
    ALTER TABLE audit_events
      ADD CONSTRAINT audit_events_subject_type_check
      CHECK (subject_type IN ('data-class', 'sweep-run', 'export-run', 'legal-hold', 'erasure', 'chain-anchor'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_events_sealed_check') THEN
    ALTER TABLE audit_events
      ADD CONSTRAINT audit_events_sealed_check
      CHECK ((subject_key_id IS NULL) = (sealed_payload IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_sweep_runs_held_back_check') THEN
    ALTER TABLE audit_sweep_runs
      ADD CONSTRAINT audit_sweep_runs_held_back_check
      CHECK (held_back IS NULL OR held_back >= 0);
  END IF;
END
$$;
-- The anchor rotation counts anchors per key across every workspace before it
-- knows whose they are, so it reads the routing columns alone on the background
-- role; every anchor it names is read and re-signed under the workspace the
-- routing row named. The hashes stay invisible to it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY audit_anchors_background_policy ON audit_anchors
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON audit_anchors FROM coreloom_background;
GRANT SELECT (tenant_id, id, key_id) ON audit_anchors TO coreloom_background;
CREATE POLICY audit_erasure_runs_background_policy ON audit_erasure_runs
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON audit_erasure_runs FROM coreloom_background;
GRANT SELECT (tenant_id, id, status, started_at) ON audit_erasure_runs TO coreloom_background;
`;

/* Mirrors migrations/0005_audit_event_format.up.sql byte for byte. */
export const AUDIT_MIGRATION_005_EVENT_FORMAT = `-- The event format marker, the subject marker, a partial erasure run and the
-- indexes the ledger walks need.
--
-- seal_format names the writer of a row. A row without it was written before
-- audit.core recorded a format at all, which is exactly the set verify reports
-- as plaintext; a row that carries the marker and no sealed payload is an event
-- about nobody, not an unsealed person. Deriving that from sealed_payload alone
-- reported every platform event as pre-0.2.0.
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS seal_format TEXT;

-- The name a subject keeps once its key is gone. Destruction removes the
-- account the key belonged to, so without this column a destroyed key cannot be
-- found again and the next event naming that subject would create a new key and
-- put the account back in the clear. Active rows are named from the same hash
-- the certificate file already uses.
ALTER TABLE audit_subject_keys ADD COLUMN IF NOT EXISTS subject_marker TEXT;
UPDATE audit_subject_keys
  SET subject_marker = substr(encode(sha256((tenant_id || ':' || subject)::bytea), 'hex'), 1, 12)
  WHERE subject IS NOT NULL AND subject_marker IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS audit_subject_keys_tenant_marker_idx
  ON audit_subject_keys (tenant_id, subject_marker)
  WHERE subject_marker IS NOT NULL;

-- A run whose class was truncated or whose owner failed erased some of the
-- subject and not all of it. Recording that as completed would tell an operator
-- the subject is gone when a class still holds rows.
ALTER TABLE audit_erasure_runs DROP CONSTRAINT IF EXISTS audit_erasure_runs_status_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_erasure_runs_status_check') THEN
    ALTER TABLE audit_erasure_runs
      ADD CONSTRAINT audit_erasure_runs_status_check
      CHECK (status IN ('requested', 'completed', 'partial', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_subject_keys_marker_check') THEN
    ALTER TABLE audit_subject_keys
      ADD CONSTRAINT audit_subject_keys_marker_check
      CHECK (subject_marker IS NULL OR length(subject_marker) <= 32);
  END IF;
END
$$;

-- The keyset walks the export takes over the three ledgers order by the primary
-- key inside one workspace, and the anchor rotation counts and pages anchors by
-- key. Without these each walk was a scan of every row of the table.
CREATE INDEX IF NOT EXISTS audit_events_tenant_id_idx
  ON audit_events (tenant_id, id);
CREATE INDEX IF NOT EXISTS audit_sweep_runs_tenant_id_idx
  ON audit_sweep_runs (tenant_id, id);
CREATE INDEX IF NOT EXISTS audit_export_runs_tenant_id_idx
  ON audit_export_runs (tenant_id, id);
CREATE INDEX IF NOT EXISTS audit_anchors_key_id_idx
  ON audit_anchors (key_id, id);

-- The routing read starts at the classes waiting longest, so it orders by
-- last_swept_at NULLS FIRST. The index migration 0001 created sorts nulls last,
-- which is the opposite end, so the walk sorted every due class on every pass.
CREATE INDEX IF NOT EXISTS audit_data_classes_due_nulls_first_idx
  ON audit_data_classes (sweepable, last_swept_at NULLS FIRST, tenant_id, class_id);
DROP INDEX IF EXISTS audit_data_classes_due_idx;
`;

/* Mirrors migrations/0006_audit_own_class_walks.up.sql byte for byte. */
export const AUDIT_MIGRATION_006_OWN_CLASS_WALKS = `-- audit.core declares the rest of its own tenant tables as data classes, so the
-- legal holds and the erasure history are exported through the same keyset walk
-- as the chain and the two ledgers, and an erasure plan counts the holds that
-- name the subject. Each of those reads orders inside one workspace by the
-- primary key or filters by the account a hold covers; without these indexes
-- every page would be a pass over the workspace's rows.
CREATE INDEX IF NOT EXISTS audit_legal_holds_tenant_id_idx
  ON audit_legal_holds (tenant_id, id);
CREATE INDEX IF NOT EXISTS audit_erasure_runs_tenant_id_idx
  ON audit_erasure_runs (tenant_id, id);
-- Partial, because a hold that names no account is never counted for a subject.
CREATE INDEX IF NOT EXISTS audit_legal_holds_tenant_account_idx
  ON audit_legal_holds (tenant_id, account_id)
  WHERE account_id IS NOT NULL;
`;

/** The tables migration 0001 creates; its inspection has to prove all four. */
const AUDIT_0001_TABLES = [
	'audit_data_classes',
	'audit_sweep_runs',
	'audit_export_runs',
	'audit_events',
] as const;

export const AUDIT_TENANT_TABLES = [
	'audit_data_classes',
	'audit_sweep_runs',
	'audit_export_runs',
	'audit_events',
	'audit_anchors',
	'audit_legal_holds',
	'audit_subject_keys',
	'audit_erasure_runs',
] as const;

/** The tables migration 0004 adds; 0001 proves the four before them. */
export const AUDIT_0004_TABLES = [
	'audit_anchors',
	'audit_legal_holds',
	'audit_subject_keys',
	'audit_erasure_runs',
] as const;

/**
 * Adoption probes run inside the migration transaction, which is pinned to one
 * connection, so every one of them is awaited in turn: eagerly created promises
 * would issue overlapping queries on that single client.
 */
async function everyTenantTable(
	database: DatabaseSession,
	tables: readonly string[],
	extras: readonly (() => Promise<boolean>)[] = [],
): Promise<ExistingMigrationState> {
	const states: ExistingMigrationState[] = [];
	for (const table of tables) {
		states.push(
			await postgresTenantTableState(database, table, table + '_tenant_policy'),
		);
	}
	if (extras.length > 0) states.push(await migrationObjectState(extras));
	if (states.every((state) => state === 'complete')) return 'complete';
	return states.every((state) => state === 'absent') ? 'absent' : 'partial';
}

/**
 * Whether a named constraint exists on a table of the current schema. The
 * catalogue is not schema qualified by itself, so the join is what keeps a probe
 * from reading a same-named constraint of another schema on the search path.
 *
 * Migrations 0003, 0004 and 0005 probe pg_constraint by name alone inside their
 * own DO blocks. A same-named constraint on another schema of the search path
 * would make one of those blocks skip an ALTER TABLE it should have run. Those
 * files are applied and their checksums are the ledger's, so the bodies stay as
 * they are; the adoption probes live here rather than in the applied SQL, which
 * is why every constraint those migrations add is proved through this
 * schema-scoped check before a schema is adopted as complete. A deployment that
 * carries such a schema is reported partial and refused rather than adopted.
 *
 * `carries` is for a constraint a later migration replaced under the same name:
 * PostgreSQL names an inline column check after the table and the column, so
 * the name alone cannot tell the narrow one from the widened one and the text
 * the widening added is what proves which of the two a schema holds.
 */
function hasConstraint(
	database: DatabaseSession,
	table: string,
	constraint: string,
	carries: string | null = null,
): () => Promise<boolean> {
	return async () => {
		const result = await database.query<{ present: boolean }>({
			text: `SELECT EXISTS (
			  SELECT 1 FROM pg_constraint AS constraint_row
			  JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
			  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
			  WHERE namespace.nspname = current_schema()
			    AND relation.relname = $1
			    AND constraint_row.conname = $2
			    AND ($3::text IS NULL
			      OR position($3 IN pg_get_constraintdef(constraint_row.oid)) > 0)
			) AS present`,
			parameters: [table, constraint, carries],
		});
		return result.rows[0]?.present === true;
	};
}

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_audit_core',
		sql: { postgresql: AUDIT_MIGRATION_001 },
		/* Every table of this migration has to be proved, not just the first:
		   a schema carrying only some of them is partial, never complete. */
		inspectExisting: (database) =>
			everyTenantTable(database, AUDIT_0001_TABLES),
	},
	{
		id: '0002_audit_sweep_routing_role',
		sql: { postgresql: AUDIT_MIGRATION_002_SWEEP_ROUTING_ROLE },
		/* A policy and a column grant leave no schema object behind, so the
		   privilege itself is what proves this migration ran. */
		inspectExisting: async (database) => {
			const result = await database.query<{ granted: boolean }>({
				text: `SELECT CASE WHEN to_regclass('audit_data_classes') IS NOT NULL THEN
				  has_column_privilege('coreloom_background', 'audit_data_classes', 'last_swept_at', 'SELECT')
				ELSE false END AS granted`,
			});
			return result.rows[0]?.granted === true ? 'complete' : 'absent';
		},
	},
	{
		id: '0003_audit_export_request',
		sql: { postgresql: AUDIT_MIGRATION_003_EXPORT_REQUEST },
		/* The added column is what proves this migration ran: the grant and the
		   policy travel in the same transactional DDL, so a schema that carries
		   the column carries them too. The introspector scopes every probe to
		   current_schema(), so a same-named table on the search path cannot
		   answer for this one. */
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasColumn('audit_export_runs', 'summary_json'),
				() => database.schema.hasIndex('audit_export_runs_pending_idx'),
			]),
	},
	{
		id: '0004_audit_hold_seal_erasure',
		sql: { postgresql: AUDIT_MIGRATION_004_HOLD_SEAL_ERASURE },
		/* Three tables, two columns on a fourth and one on a fifth, with the
		   indexes and the constraints that go with them: every object has to be
		   proved, because a schema carrying only some is partial, never
		   complete. */
		inspectExisting: (database) =>
			everyTenantTable(database, AUDIT_0004_TABLES, [
				() => database.schema.hasColumn('audit_events', 'subject_key_id'),
				() => database.schema.hasColumn('audit_events', 'sealed_payload'),
				() => database.schema.hasColumn('audit_sweep_runs', 'held_back'),
				() => database.schema.hasIndex('audit_anchors_tenant_sequence_idx'),
				() => database.schema.hasIndex('audit_legal_holds_tenant_status_idx'),
				() => database.schema.hasIndex('audit_subject_keys_tenant_subject_idx'),
				() => database.schema.hasIndex('audit_erasure_runs_tenant_time_idx'),
				() => database.schema.hasIndex('audit_erasure_runs_pending_idx'),
				hasConstraint(database, 'audit_events', 'audit_events_sealed_check'),
				hasConstraint(
					database,
					'audit_sweep_runs',
					'audit_sweep_runs_held_back_check',
				),
			]),
	},
	{
		id: '0005_audit_event_format',
		sql: { postgresql: AUDIT_MIGRATION_005_EVENT_FORMAT },
		/* Two columns, the marker index and the widened status constraint; the
		   ledger indexes travel in the same transactional DDL. Both constraints
		   are proved through the schema-scoped probe, because the DO block that
		   adds them reads pg_constraint by name alone. */
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasColumn('audit_events', 'seal_format'),
				() => database.schema.hasColumn('audit_subject_keys', 'subject_marker'),
				() => database.schema.hasIndex('audit_subject_keys_tenant_marker_idx'),
				() => database.schema.hasIndex('audit_events_tenant_id_idx'),
				() =>
					database.schema.hasIndex('audit_data_classes_due_nulls_first_idx'),
				hasConstraint(
					database,
					'audit_erasure_runs',
					'audit_erasure_runs_status_check',
					/* Migration 0004 created the table with the same constraint name
					   and without this status, so the definition is what separates
					   the widened constraint from the one before it. */
					'partial',
				),
				hasConstraint(
					database,
					'audit_subject_keys',
					'audit_subject_keys_marker_check',
				),
			]),
	},
	{
		id: '0006_audit_own_class_walks',
		sql: { postgresql: AUDIT_MIGRATION_006_OWN_CLASS_WALKS },
		/* Three indexes and nothing else, so each of them is the proof. */
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasIndex('audit_legal_holds_tenant_id_idx'),
				() => database.schema.hasIndex('audit_erasure_runs_tenant_id_idx'),
				() => database.schema.hasIndex('audit_legal_holds_tenant_account_idx'),
			]),
	},
];
