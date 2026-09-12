import type {
	DatabaseMigration,
	ExistingMigrationState,
} from '@flowdular/database';
import { postgresTenantTableState } from '@flowdular/database';

/* Mirrors migrations/0001_connectors_core.up.sql byte for byte. */
export const CONNECTORS_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS connectors_instances (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  definition_key TEXT NOT NULL,
  name TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  base_url TEXT NOT NULL,
  auth_kind TEXT NOT NULL CHECK (auth_kind IN ('none', 'api-key', 'bearer', 'oauth2-client-credentials')),
  credential_key_id TEXT,
  credential_iv TEXT,
  credential_tag TEXT,
  credential_ciphertext TEXT,
  credential_fingerprint TEXT,
  allowed_hosts_json TEXT NOT NULL,
  allow_workflows SMALLINT NOT NULL DEFAULT 0 CHECK (allow_workflows IN (0, 1)),
  allow_agents SMALLINT NOT NULL DEFAULT 0 CHECK (allow_agents IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  last_call_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS connectors_instances_name_normalized_idx
  ON connectors_instances (tenant_id, name_normalized);
CREATE INDEX IF NOT EXISTS connectors_instances_tenant_status_idx
  ON connectors_instances (tenant_id, status, name_normalized);
ALTER TABLE connectors_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors_instances FORCE ROW LEVEL SECURITY;
CREATE POLICY connectors_instances_tenant_policy ON connectors_instances
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

CREATE TABLE IF NOT EXISTS connectors_calls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  caller TEXT NOT NULL CHECK (caller IN ('test', 'workflow', 'agent')),
  caller_ref TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'refused')),
  status INTEGER,
  error_class TEXT,
  duration_ms INTEGER NOT NULL,
  request_bytes INTEGER NOT NULL,
  response_bytes INTEGER NOT NULL,
  occurred_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS connectors_calls_tenant_time_idx
  ON connectors_calls (tenant_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS connectors_calls_instance_idx
  ON connectors_calls (tenant_id, instance_id, occurred_at DESC);
ALTER TABLE connectors_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY connectors_calls_tenant_policy ON connectors_calls
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));

CREATE TABLE IF NOT EXISTS connectors_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('instance.created', 'instance.updated', 'instance.consent-changed', 'instance.enabled', 'instance.disabled', 'instance.deleted')),
  instance_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS connectors_audit_tenant_time_idx
  ON connectors_audit (tenant_id, occurred_at DESC, id DESC);
ALTER TABLE connectors_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY connectors_audit_tenant_policy ON connectors_audit
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/* Mirrors migrations/0002_connectors_call_keys.up.sql byte for byte. */
export const CONNECTORS_MIGRATION_002 = `CREATE TABLE IF NOT EXISTS connectors_call_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 3 AND 200),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  call_id TEXT,
  claimed_at BIGINT NOT NULL,
  completed_at BIGINT,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS connectors_call_keys_tenant_claimed_idx
  ON connectors_call_keys (tenant_id, claimed_at, id);
ALTER TABLE connectors_call_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors_call_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY connectors_call_keys_tenant_policy ON connectors_call_keys
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/** Every tenant table of one migration must be adopted, or none of it is. */
async function combined(
	states: readonly Promise<ExistingMigrationState>[],
): Promise<ExistingMigrationState> {
	const resolved: ExistingMigrationState[] = [];
	for (const state of states) resolved.push(await state);
	if (resolved.every((state) => state === 'complete')) return 'complete';
	if (resolved.every((state) => state === 'absent')) return 'absent';
	return 'partial';
}

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_connectors_core',
		sql: { postgresql: CONNECTORS_MIGRATION_001 },
		inspectExisting: (database) =>
			combined([
				postgresTenantTableState(
					database,
					'connectors_instances',
					'connectors_instances_tenant_policy',
					[
						() =>
							database.schema.hasIndex(
								'connectors_instances_name_normalized_idx',
							),
						() =>
							database.schema.hasIndex(
								'connectors_instances_tenant_status_idx',
							),
					],
				),
				postgresTenantTableState(
					database,
					'connectors_calls',
					'connectors_calls_tenant_policy',
					[
						() => database.schema.hasIndex('connectors_calls_tenant_time_idx'),
						() => database.schema.hasIndex('connectors_calls_instance_idx'),
					],
				),
				postgresTenantTableState(
					database,
					'connectors_audit',
					'connectors_audit_tenant_policy',
					[() => database.schema.hasIndex('connectors_audit_tenant_time_idx')],
				),
			]),
	},
	{
		id: '0002_connectors_call_keys',
		sql: { postgresql: CONNECTORS_MIGRATION_002 },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'connectors_call_keys',
				'connectors_call_keys_tenant_policy',
				[
					() =>
						database.schema.hasIndex('connectors_call_keys_tenant_claimed_idx'),
				],
			),
	},
];
