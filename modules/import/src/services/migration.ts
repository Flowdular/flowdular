import type { DatabaseMigration } from '@flowdular/database';
import { postgresTenantTableState } from '@flowdular/database';

/* Every constant mirrors its migrations/<id>.up.sql file byte for byte;
   tests/migrations.test.ts fails on drift. */

export const IMPORT_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  target TEXT NOT NULL CHECK (length(target) BETWEEN 3 AND 96),
  document_id TEXT NOT NULL CHECK (length(document_id) BETWEEN 1 AND 128),
  document_ref TEXT NOT NULL CHECK (length(document_ref) BETWEEN 1 AND 200),
  mode TEXT NOT NULL CHECK (mode IN ('create-only', 'update-existing', 'skip-existing')),
  dry_run SMALLINT NOT NULL CHECK (dry_run IN (0, 1)),
  valid_only SMALLINT NOT NULL CHECK (valid_only IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('parsing', 'validated', 'writing', 'completed', 'failed', 'cancelled')),
  total_rows BIGINT NOT NULL CHECK (total_rows >= 0),
  valid_rows BIGINT NOT NULL CHECK (valid_rows >= 0),
  written_rows BIGINT NOT NULL CHECK (written_rows >= 0),
  failed_rows BIGINT NOT NULL CHECK (failed_rows >= 0),
  requester_account_id TEXT NOT NULL CHECK (length(requester_account_id) BETWEEN 1 AND 128),
  requester_json TEXT NOT NULL CHECK (length(requester_json) <= 8192 AND requester_json::jsonb IS NOT NULL),
  columns_json TEXT NOT NULL CHECK (length(columns_json) <= 8192 AND columns_json::jsonb IS NOT NULL),
  failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 64),
  claimed_at BIGINT,
  started_at BIGINT NOT NULL,
  completed_at BIGINT,
  CHECK ((status IN ('completed', 'failed', 'cancelled')) = (completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS import_jobs_tenant_started_idx
  ON import_jobs (tenant_id, started_at DESC, id);
ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY import_jobs_tenant_policy ON import_jobs
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

CREATE TABLE IF NOT EXISTS import_job_rows (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  row_number BIGINT NOT NULL CHECK (row_number >= 1),
  outcome TEXT NOT NULL CHECK (outcome IN ('valid', 'invalid', 'created', 'updated', 'skipped', 'failed')),
  field TEXT CHECK (field IS NULL OR length(field) BETWEEN 1 AND 64),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 200),
  record_ref TEXT CHECK (record_ref IS NULL OR length(record_ref) BETWEEN 1 AND 200),
  UNIQUE (tenant_id, job_id, row_number)
);
ALTER TABLE import_job_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_job_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY import_job_rows_tenant_policy ON import_job_rows
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

CREATE TABLE IF NOT EXISTS import_mappings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  target TEXT NOT NULL CHECK (length(target) BETWEEN 3 AND 96),
  columns_json TEXT NOT NULL CHECK (length(columns_json) <= 8192 AND columns_json::jsonb IS NOT NULL),
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, target)
);
ALTER TABLE import_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY import_mappings_tenant_policy ON import_mappings
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

export const IMPORT_MIGRATION_002_JOB_ROUTING_ROLE = `-- The poll loop must find queued jobs across workspaces before it knows whose
-- they are, so it reads the routing columns alone on the background role: the
-- document, the target, the mapping, the requester and every row outcome stay
-- invisible to it, and each job it picks is claimed and processed again under
-- the workspace the routing row named. PostgreSQL checks column privileges in
-- WHERE too, so \`status\` is part of the grant.
CREATE INDEX IF NOT EXISTS import_jobs_routing_idx
  ON import_jobs (status, started_at, tenant_id, id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY import_jobs_background_policy ON import_jobs
  FOR SELECT TO coreloom_background
  USING (status IN ('parsing', 'writing'));
REVOKE SELECT ON import_jobs FROM coreloom_background;
GRANT SELECT (tenant_id, id, status, started_at) ON import_jobs TO coreloom_background;
`;

export const IMPORT_MIGRATION_003_EXPORT_INDEX = `-- The data class export walks a workspace oldest first by (started_at, id) and
-- the retention sweep picks its batch by the same key. The listing index orders
-- started_at descending, and reading it backwards pairs an ascending started_at
-- with a descending id, so neither walk can be served by it. The outcome and
-- mapping walks keep using the unique keys their tables already carry.
CREATE INDEX IF NOT EXISTS import_jobs_tenant_export_idx
  ON import_jobs (tenant_id, started_at, id);
`;

export const IMPORT_MIGRATION_004_TRACEPARENT = `-- The trace that enqueued the job, as a W3C traceparent header value, so the
-- pass that claims it can be read against the request that started it. Nullable
-- because a job enqueued outside a traced scope, and every job that predates
-- this column, is a new root. It is written once at insert and never used as a
-- predicate, so it carries no index and stays off the background routing grant:
-- the claim returns it under the tenant that owns the job.
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS traceparent text;
`;

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_import_core',
		sql: { postgresql: IMPORT_MIGRATION_001 },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'import_jobs',
				'import_jobs_tenant_policy',
				[
					() => database.schema.hasTable('import_job_rows'),
					() => database.schema.hasTable('import_mappings'),
					() => database.schema.hasIndex('import_jobs_tenant_started_idx'),
				],
			),
	},
	{
		id: '0002_import_job_routing_role',
		sql: { postgresql: IMPORT_MIGRATION_002_JOB_ROUTING_ROLE },
		/* A policy and a column grant leave no schema object behind, so the
		   privilege itself is what proves this migration ran. */
		inspectExisting: async (database) => {
			const result = await database.query<{ granted: boolean }>({
				text: `SELECT CASE WHEN to_regclass('import_jobs') IS NOT NULL THEN
				  has_column_privilege('coreloom_background', 'import_jobs', 'status', 'SELECT')
				ELSE false END AS granted`,
			});
			return result.rows[0]?.granted ? 'complete' : 'absent';
		},
	},
	{
		id: '0003_import_jobs_export_index',
		sql: { postgresql: IMPORT_MIGRATION_003_EXPORT_INDEX },
		inspectExisting: async (database) =>
			(await database.schema.hasIndex('import_jobs_tenant_export_idx'))
				? 'complete'
				: 'absent',
	},
	{
		id: '0004_import_jobs_traceparent',
		sql: { postgresql: IMPORT_MIGRATION_004_TRACEPARENT },
		inspectExisting: async (database) =>
			(await database.schema.hasColumn('import_jobs', 'traceparent'))
				? 'complete'
				: 'absent',
	},
];
