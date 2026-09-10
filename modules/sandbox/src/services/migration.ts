import type { DatabaseMigration } from '@flowdular/database';
import { postgresTenantTableState } from '@flowdular/database';

/* Every constant mirrors its migrations/<id>.up.sql file byte for byte;
   tests/migrations.test.ts fails on drift. */

export const SANDBOX_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS sandbox_access_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  note TEXT,
  granted_by TEXT NOT NULL,
  granted_at BIGINT NOT NULL,
  expires_at BIGINT,
  revoked_at BIGINT,
  revoked_by TEXT,
  UNIQUE (tenant_id, account_id)
);
CREATE INDEX IF NOT EXISTS sandbox_grants_tenant_idx
  ON sandbox_access_grants (tenant_id, revoked_at, email);

CREATE TABLE IF NOT EXISTS sandbox_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  title TEXT NOT NULL,
  blueprint TEXT NOT NULL,
  driver TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('loopback', 'self-hosted')),
  state TEXT NOT NULL CHECK (state IN (
    'draft', 'classified', 'planned', 'editing', 'validating',
    'previewing', 'awaiting-approval', 'accepted', 'failed', 'blocked'
  )),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  ejected_at BIGINT
);
CREATE INDEX IF NOT EXISTS sandbox_sessions_tenant_idx
  ON sandbox_sessions (tenant_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS sandbox_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('grant', 'session', 'module')),
  subject_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  UNIQUE (tenant_id, sequence),
  UNIQUE (tenant_id, event_hash)
);
CREATE INDEX IF NOT EXISTS sandbox_audit_tenant_time_idx
  ON sandbox_audit_events (tenant_id, occurred_at DESC, sequence DESC);
ALTER TABLE sandbox_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_access_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY sandbox_access_grants_tenant_policy ON sandbox_access_grants
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE sandbox_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sandbox_sessions_tenant_policy ON sandbox_sessions
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
ALTER TABLE sandbox_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY sandbox_audit_events_tenant_policy ON sandbox_audit_events
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

export const SANDBOX_MIGRATION_002 = `-- Sessions gain an archive timestamp and two lifecycle states. The table is
-- rebuilt rather than altered in place so the widened state constraint, the
-- new column, the index, and the tenant policy all land in one step.
CREATE TABLE sandbox_sessions_v2 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  title TEXT NOT NULL,
  blueprint TEXT NOT NULL,
  driver TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('loopback', 'self-hosted')),
  state TEXT NOT NULL CHECK (state IN (
    'draft', 'classified', 'planned', 'editing', 'validating',
    'previewing', 'awaiting-approval', 'accepted', 'failed', 'blocked',
    'archived', 'deleted'
  )),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  ejected_at BIGINT,
  archived_at BIGINT
);
INSERT INTO sandbox_sessions_v2
  (id, tenant_id, account_id, module_id, title, blueprint, driver, mode, state,
   created_at, updated_at, ejected_at, archived_at)
  SELECT id, tenant_id, account_id, module_id, title, blueprint, driver, mode,
         state, created_at, updated_at, ejected_at, NULL
  FROM sandbox_sessions;
DROP TABLE sandbox_sessions;
ALTER TABLE sandbox_sessions_v2 RENAME TO sandbox_sessions;
CREATE INDEX IF NOT EXISTS sandbox_sessions_tenant_idx
  ON sandbox_sessions (tenant_id, updated_at DESC, id);
ALTER TABLE sandbox_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sandbox_sessions_tenant_policy ON sandbox_sessions
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_sandbox_core',
		sql: { postgresql: SANDBOX_MIGRATION_001 },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'sandbox_access_grants',
				'sandbox_access_grants_tenant_policy',
				[
					() => database.schema.hasTable('sandbox_sessions'),
					() => database.schema.hasTable('sandbox_audit_events'),
					() => database.schema.hasIndex('sandbox_grants_tenant_idx'),
					() => database.schema.hasIndex('sandbox_audit_tenant_time_idx'),
				],
			),
	},
	{
		id: '0002_sandbox_session_lifecycle',
		sql: { postgresql: SANDBOX_MIGRATION_002 },
		/* The rebuild is recognised by the column it adds, not by the temporary
		   table it uses, which is gone by the time the migration finishes. */
		inspectExisting: async (database) =>
			(await database.schema.hasColumn('sandbox_sessions', 'archived_at'))
				? 'complete'
				: 'absent',
	},
];
