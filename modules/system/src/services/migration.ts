import type { DatabaseMigration } from '@flowdular/database';
import { postgresTenantTableState } from '@flowdular/database';

/* Mirrors migrations/0001_system_module_activations.up.sql byte for byte;
   tests/migrations.test.ts fails on drift. */
export const SYSTEM_MIGRATION_001 = `-- One row per module whose activation an owner changed for a workspace. A
-- composed module without a row is active; the row keeps the last decision and
-- who made it. The primary key is the only lookup: the snapshot reads every row
-- of one tenant at once.
CREATE TABLE IF NOT EXISTS system_module_activations (
  tenant_id TEXT NOT NULL,
  module_id TEXT NOT NULL CHECK (length(module_id) BETWEEN 1 AND 128),
  active SMALLINT NOT NULL CHECK (active IN (0, 1)),
  changed_by TEXT NOT NULL CHECK (length(changed_by) BETWEEN 1 AND 64),
  changed_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, module_id)
);
ALTER TABLE system_module_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_module_activations FORCE ROW LEVEL SECURITY;
CREATE POLICY system_module_activations_tenant_policy ON system_module_activations
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

/** Every tenant table of this module, with the policy each one must carry. */
export const SYSTEM_TENANT_TABLES = ['system_module_activations'] as const;

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_system_module_activations',
		sql: { postgresql: SYSTEM_MIGRATION_001 },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'system_module_activations',
				'system_module_activations_tenant_policy',
			),
	},
];
