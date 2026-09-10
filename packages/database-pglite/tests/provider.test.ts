import {
	createDatabaseProvider,
	databaseProviderConfigFromEnvironment,
	runDatabaseMigrations,
	type DatabaseMigration,
} from '@flowdular/database';
import { describe, expect, it } from 'vitest';
import { createPgliteCluster } from '../src/driver.ts';

const migrations: readonly DatabaseMigration[] = [
	{
		id: '0001_notes_core',
		sql: {
			postgresql: `CREATE TABLE IF NOT EXISTS notes_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  body TEXT NOT NULL
);
ALTER TABLE notes_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes_records FORCE ROW LEVEL SECURITY;
CREATE POLICY notes_records_tenant_policy ON notes_records
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`,
		},
	},
];

function provider() {
	return createDatabaseProvider(
		databaseProviderConfigFromEnvironment(
			{ NODE_ENV: 'test', FD_DATABASE_ADAPTER: 'pglite' },
			'/workspace',
		),
		{ pgliteCluster: (options) => createPgliteCluster(options) },
	);
}

describe('embedded PostgreSQL provider', () => {
	it('reports the embedded adapter and answers readiness', async () => {
		const databases = provider();
		try {
			expect(databases.adapter).toBe('pglite');
			await expect(databases.check()).resolves.toEqual({
				adapter: 'pglite',
				status: 'ready',
			});
		} finally {
			await databases.dispose();
		}
	});

	/* The lease split is the point: a migration lease owns the schema, a runtime
	   lease is the restricted role, and both reach the same database. */
	it('separates the migration and runtime leases over one database', async () => {
		const databases = provider();
		try {
			const migration = await databases.acquire({
				namespace: 'notes.core',
				purpose: 'migration',
			});
			await runDatabaseMigrations(migration.database, 'notes.core', migrations);
			await migration.release();

			const runtime = await databases.acquire({
				namespace: 'notes.core',
				purpose: 'test',
			});
			await runtime.database.transaction(
				(transaction) =>
					transaction.execute({
						text: 'INSERT INTO notes_records (id, tenant_id, body) VALUES ($1, $2, $3)',
						parameters: ['n1', 'tenant-a', 'A'],
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			);

			const own = await runtime.database.transaction(
				(transaction) =>
					transaction.query<{ id: string }>({
						text: 'SELECT id FROM notes_records',
					}),
				{ access: 'read', tenantId: 'tenant-a' },
			);
			expect(own.rows).toEqual([{ id: 'n1' }]);

			const other = await runtime.database.transaction(
				(transaction) =>
					transaction.query<{ id: string }>({
						text: 'SELECT id FROM notes_records',
					}),
				{ access: 'read', tenantId: 'tenant-b' },
			);
			expect(other.rows).toEqual([]);

			await expect(
				runtime.database.transaction(
					(transaction) =>
						transaction.execute({
							text: 'INSERT INTO notes_records (id, tenant_id, body) VALUES ($1, $2, $3)',
							parameters: ['forged', 'tenant-b', 'Forged'],
						}),
					{ access: 'write', tenantId: 'tenant-a' },
				),
			).rejects.toBeDefined();

			await runtime.release();
		} finally {
			await databases.dispose();
		}
	});

	it('refuses the embedded adapter in production', () => {
		expect(() =>
			databaseProviderConfigFromEnvironment(
				{ NODE_ENV: 'production', FD_DATABASE_ADAPTER: 'pglite' },
				'/workspace',
			),
		).toThrow('not a production adapter');
	});
});
