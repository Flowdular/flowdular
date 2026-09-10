import {
	databaseResetPlan,
	resetDatabase,
	runDatabaseMigrations,
	type DatabaseMigration,
} from '@flowdular/database';
import { describe, expect, it } from 'vitest';
import { createPostgresTestProvider } from '../src/postgres.ts';

const migratorUrl = process.env.FD_TEST_POSTGRES_URL?.trim();

const migrations: readonly DatabaseMigration[] = [
	{
		id: '0001_reset_fixture',
		sql: {
			postgresql: `CREATE TABLE IF NOT EXISTS reset_parents (
  id TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS reset_children (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL REFERENCES reset_parents (id)
);
`,
		},
		inspectExisting: async (database) =>
			(await database.schema.hasTable('reset_parents')) ? 'complete' : 'absent',
	},
];

describe.skipIf(!migratorUrl)('PostgreSQL reset', () => {
	it('drops referenced tables and the ledger inside one transaction', async () => {
		const provider = await createPostgresTestProvider({
			migratorUrl: migratorUrl!,
			runtimeUrl: process.env.FD_TEST_POSTGRES_RUNTIME_URL?.trim() || undefined,
		});
		try {
			const lease = await provider.acquire({
				namespace: 'reset.core',
				purpose: 'migration',
			});
			const database = lease.database;
			await runDatabaseMigrations(database, 'reset.core', migrations);
			await database.execute({
				text: 'INSERT INTO reset_parents (id) VALUES ($1)',
				parameters: ['parent'],
			});
			await database.execute({
				text: 'INSERT INTO reset_children (id, parent_id) VALUES ($1, $2)',
				parameters: ['child', 'parent'],
			});

			await expect(databaseResetPlan(database)).resolves.toEqual([
				'_coreloom_migrations_v2',
				'reset_children',
				'reset_parents',
			]);
			await expect(
				resetDatabase(database, { intent: 'confirmed-destructive-reset' }),
			).resolves.toMatchObject({ dialectId: 'postgresql' });
			await expect(databaseResetPlan(database)).resolves.toEqual([]);

			await runDatabaseMigrations(database, 'reset.core', migrations);
			await expect(
				database.query({ text: 'SELECT id FROM reset_parents' }),
			).resolves.toEqual({ rows: [], rowCount: 0 });
			await lease.release();
		} finally {
			await provider.dispose();
		}
	});

	it('refuses a reset through a tenant-scoped runtime lease', async () => {
		const provider = await createPostgresTestProvider({
			migratorUrl: migratorUrl!,
			runtimeUrl: process.env.FD_TEST_POSTGRES_RUNTIME_URL?.trim() || undefined,
		});
		try {
			const lease = await provider.acquire({
				namespace: 'reset.core',
				purpose: 'runtime',
			});
			await expect(
				resetDatabase(lease.database, {
					intent: 'confirmed-destructive-reset',
				}),
			).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
			await lease.release();
		} finally {
			await provider.dispose();
		}
	});
});
