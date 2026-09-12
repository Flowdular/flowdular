import type { DatabaseMigration } from '@flowdular/database';
import {
	migrationObjectState,
	postgresTenantTableState,
} from '@flowdular/database';

/* Mirrors migrations/0001_approvals_core.up.sql byte for byte. */
export const APPROVALS_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS approvals_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_module TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  permission TEXT NOT NULL,
  action TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  requester_account_id TEXT NOT NULL,
  requirement_json TEXT NOT NULL,
  decisions_needed BIGINT NOT NULL CHECK (decisions_needed >= 1),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  expires_at BIGINT NOT NULL,
  resolved_at BIGINT,
  created_at BIGINT NOT NULL
);
-- A subject module that reopens after a crash has to find the request it
-- already opened instead of asking the same question twice. One pending
-- request per subject reference is what makes opening idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS approvals_requests_pending_subject_idx
  ON approvals_requests (tenant_id, subject_module, subject_ref)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS approvals_requests_tenant_status_idx
  ON approvals_requests (tenant_id, status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS approvals_requests_requester_idx
  ON approvals_requests (tenant_id, requester_account_id, created_at DESC, id);
-- The cross-tenant expiry poll reads in this order and stops at the first
-- request that is not due yet.
CREATE INDEX IF NOT EXISTS approvals_requests_routing_idx
  ON approvals_requests (status, expires_at, tenant_id, id);
ALTER TABLE approvals_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY approvals_requests_tenant_policy ON approvals_requests
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
-- The eligibility snapshot taken when the request opened. It decides whose
-- inbox the request appears in, so it is a row per decider with its own index
-- rather than a list inside the request: the screen asks "what may I decide"
-- once per open workspace and that question has to stay one index lookup.
CREATE TABLE IF NOT EXISTS approvals_eligible (
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, request_id, account_id)
);
CREATE INDEX IF NOT EXISTS approvals_eligible_account_idx
  ON approvals_eligible (tenant_id, account_id, request_id);
ALTER TABLE approvals_eligible ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals_eligible FORCE ROW LEVEL SECURITY;
CREATE POLICY approvals_eligible_tenant_policy ON approvals_eligible
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
CREATE TABLE IF NOT EXISTS approvals_decisions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  decider_account_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'expire', 'cancel')),
  comment TEXT,
  decided_at BIGINT NOT NULL,
  -- Expiry is the one decision no member makes. Every other row names the
  -- account answerable for it, and the pair is checked here rather than only
  -- in the service that writes it.
  CHECK ((decision = 'expire') = (decider_account_id IS NULL))
);
-- One approval or rejection per member per request. The service checks first,
-- but this index is what actually guarantees the conflict it reports.
CREATE UNIQUE INDEX IF NOT EXISTS approvals_decisions_decider_idx
  ON approvals_decisions (tenant_id, request_id, decider_account_id)
  WHERE decision IN ('approve', 'reject');
CREATE INDEX IF NOT EXISTS approvals_decisions_request_idx
  ON approvals_decisions (tenant_id, request_id, decided_at, id);
ALTER TABLE approvals_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY approvals_decisions_tenant_policy ON approvals_decisions
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/* Mirrors migrations/0002_approvals_expiry_routing_role.up.sql byte for byte. */
export const APPROVALS_MIGRATION_002_EXPIRY_ROUTING_ROLE = `-- The expiry loop has to find due pending requests before it knows whose they
-- are, and the requests table is invisible to the cross-tenant role: it carries
-- no background policy and the role holds no default table grant. This adds the
-- four routing columns and nothing else. The subject, the requester, the
-- requirement, the eligibility snapshot and the title stay unreadable on this
-- connection, and every request it names is read again under its own tenant
-- before anything about it is written.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coreloom_background') THEN
    RAISE EXCEPTION 'The coreloom_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY approvals_requests_background_policy ON approvals_requests
  FOR SELECT TO coreloom_background
  USING (true);
REVOKE SELECT ON approvals_requests FROM coreloom_background;
GRANT SELECT (tenant_id, id, expires_at, status) ON approvals_requests TO coreloom_background;
`;

/* Mirrors migrations/0003_approvals_retention_indexes.up.sql byte for byte. */
export const APPROVALS_MIGRATION_003_RETENTION_INDEXES = `-- The retention sweep of approvals.core.requests asks one workspace for its
-- oldest resolved requests, the export walks every request of a workspace in
-- id order, and a subject erasure asks it for the decisions one account made.
-- None of the three is covered by what the module already carries: the status
-- index orders by creation rather than by resolution, the requester index
-- answers who asked rather than who decided, and no index carries the export's
-- own key order. All three are bounded batches, so all three need a range scan
-- rather than a pass over the workspace's requests.
CREATE INDEX IF NOT EXISTS approvals_requests_resolved_idx
  ON approvals_requests (tenant_id, status, resolved_at, id);
CREATE INDEX IF NOT EXISTS approvals_requests_export_idx
  ON approvals_requests (tenant_id, id);
CREATE INDEX IF NOT EXISTS approvals_decisions_decider_account_idx
  ON approvals_decisions (tenant_id, decider_account_id, id);
`;

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_approvals_core',
		sql: { postgresql: APPROVALS_MIGRATION_001 },
		/* One migration creates three tables, so a schema carrying only some of
		   them is partial and the runner refuses it rather than patching it. */
		inspectExisting: async (database) => {
			const states = await Promise.all([
				postgresTenantTableState(
					database,
					'approvals_requests',
					'approvals_requests_tenant_policy',
					[
						() =>
							database.schema.hasIndex(
								'approvals_requests_pending_subject_idx',
							),
						() =>
							database.schema.hasIndex('approvals_requests_tenant_status_idx'),
						() => database.schema.hasIndex('approvals_requests_requester_idx'),
						() => database.schema.hasIndex('approvals_requests_routing_idx'),
					],
				),
				postgresTenantTableState(
					database,
					'approvals_eligible',
					'approvals_eligible_tenant_policy',
					[() => database.schema.hasIndex('approvals_eligible_account_idx')],
				),
				postgresTenantTableState(
					database,
					'approvals_decisions',
					'approvals_decisions_tenant_policy',
					[
						() => database.schema.hasIndex('approvals_decisions_decider_idx'),
						() => database.schema.hasIndex('approvals_decisions_request_idx'),
					],
				),
			]);
			if (states.every((state) => state === 'complete')) return 'complete';
			if (states.every((state) => state === 'absent')) return 'absent';
			return 'partial';
		},
	},
	{
		id: '0002_approvals_expiry_routing_role',
		sql: { postgresql: APPROVALS_MIGRATION_002_EXPIRY_ROUTING_ROLE },
		/* A policy and a column grant leave no schema object behind, so the
		   privilege itself is what proves this migration ran. */
		inspectExisting: async (database) => {
			const result = await database.query<{ granted: boolean }>({
				text: `SELECT CASE WHEN to_regclass('approvals_requests') IS NOT NULL THEN
				  has_column_privilege('coreloom_background', 'approvals_requests', 'expires_at', 'SELECT')
				ELSE false END AS granted`,
			});
			return result.rows[0]?.granted === true ? 'complete' : 'absent';
		},
	},
	{
		id: '0003_approvals_retention_indexes',
		sql: { postgresql: APPROVALS_MIGRATION_003_RETENTION_INDEXES },
		inspectExisting: (database) =>
			migrationObjectState([
				() => database.schema.hasIndex('approvals_requests_resolved_idx'),
				() => database.schema.hasIndex('approvals_requests_export_idx'),
				() =>
					database.schema.hasIndex('approvals_decisions_decider_account_idx'),
			]),
	},
];
