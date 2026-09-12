import type { DatabaseMigration } from '@flowdular/database';
import { postgresTenantTableState } from '@flowdular/database';

/* Every constant mirrors its migrations/<id>.up.sql file byte for byte;
   tests/migrations.test.ts fails on drift. */

export const EXPORTS_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS exports_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  list_id TEXT NOT NULL CHECK (length(list_id) BETWEEN 3 AND 96),
  status TEXT NOT NULL CHECK (status IN ('requested', 'running', 'completed', 'failed')),
  row_count BIGINT NOT NULL CHECK (row_count >= 0),
  byte_count BIGINT NOT NULL CHECK (byte_count >= 0),
  object_id TEXT CHECK (object_id IS NULL OR length(object_id) BETWEEN 1 AND 128),
  requester_account_id TEXT NOT NULL CHECK (length(requester_account_id) BETWEEN 1 AND 128),
  requester_json TEXT NOT NULL CHECK (length(requester_json) <= 8192 AND requester_json::jsonb IS NOT NULL),
  failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 64),
  claimed_at BIGINT,
  started_at BIGINT NOT NULL,
  completed_at BIGINT,
  UNIQUE (tenant_id, object_id),
  CHECK ((status IN ('completed', 'failed')) = (completed_at IS NOT NULL)),
  CHECK ((failure_code IS NOT NULL) = (status = 'failed')),
  CHECK (object_id IS NULL OR status = 'completed')
);
CREATE INDEX IF NOT EXISTS exports_jobs_tenant_started_idx
  ON exports_jobs (tenant_id, started_at DESC, id);
CREATE INDEX IF NOT EXISTS exports_jobs_tenant_export_idx
  ON exports_jobs (tenant_id, started_at, id);
ALTER TABLE exports_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE exports_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY exports_jobs_tenant_policy ON exports_jobs
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

export const EXPORTS_MIGRATION_002_JOB_ROUTING_ROLE = `-- The poll loop must find waiting jobs across workspaces before it knows whose
-- they are, so it reads the routing columns alone on the background role: the
-- list, the requester snapshot, the object and every count stay invisible to
-- it, and each job it picks is claimed and run again under the workspace the
-- routing row named. PostgreSQL checks column privileges in WHERE too, so
-- \`status\` is part of the grant. A job already running is routed as well, so a
-- claim whose process is gone is found again once its lease lapses.
CREATE INDEX IF NOT EXISTS exports_jobs_routing_idx
  ON exports_jobs (status, started_at, tenant_id, id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY exports_jobs_background_policy ON exports_jobs
  FOR SELECT TO coreloom_background
  USING (status IN ('requested', 'running'));
REVOKE SELECT ON exports_jobs FROM coreloom_background;
GRANT SELECT (tenant_id, id, status, started_at) ON exports_jobs TO coreloom_background;
`;

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_exports_core',
		sql: { postgresql: EXPORTS_MIGRATION_001 },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'exports_jobs',
				'exports_jobs_tenant_policy',
				[
					() => database.schema.hasIndex('exports_jobs_tenant_started_idx'),
					() => database.schema.hasIndex('exports_jobs_tenant_export_idx'),
				],
			),
	},
	{
		id: '0002_exports_job_routing_role',
		sql: { postgresql: EXPORTS_MIGRATION_002_JOB_ROUTING_ROLE },
		/* A policy and a column grant leave no schema object behind, so the
		   privilege itself is what proves this migration ran. */
		inspectExisting: async (database) => {
			const result = await database.query<{ granted: boolean }>({
				text: `SELECT CASE WHEN to_regclass('exports_jobs') IS NOT NULL THEN
				  has_column_privilege('coreloom_background', 'exports_jobs', 'status', 'SELECT')
				ELSE false END AS granted`,
			});
			return result.rows[0]?.granted ? 'complete' : 'absent';
		},
	},
];
