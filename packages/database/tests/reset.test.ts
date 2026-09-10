import { createPgliteCluster } from '@flowdular/database-pglite';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
	databaseResetPlan,
	PostgresDatabaseAdapter,
	resetDatabase,
	runDatabaseMigrations,
	type DatabaseMigration,
	type PostgresDriverClient,
	type PostgresDriverPool,
} from '../src/index.ts';

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

/* One embedded PostgreSQL for the file, emptied before each case, so the two
   seconds it costs to boot are paid once. */
const cluster = createPgliteCluster();
const database = new PostgresDatabaseAdapter({ pool: cluster.pool() });

afterAll(async () => {
	await database.dispose();
});

beforeEach(async () => {
	await resetDatabase(database, { intent: 'confirmed-destructive-reset' });
});

async function migrated(): Promise<PostgresDatabaseAdapter> {
	await runDatabaseMigrations(database, 'reset.core', migrations);
	await database.execute({
		text: 'INSERT INTO reset_parents (id) VALUES ($1)',
		parameters: ['parent'],
	});
	await database.execute({
		text: 'INSERT INTO reset_children (id, parent_id) VALUES ($1, $2)',
		parameters: ['child', 'parent'],
	});
	return database;
}

describe('database reset', () => {
	it('lists the ledger and every module table in the plan', async () => {
		await expect(databaseResetPlan(await migrated())).resolves.toEqual([
			'_coreloom_migrations_v2',
			'reset_children',
			'reset_parents',
		]);
	});

	/* The catalog order drops a referenced parent before its child, so a reset
	   that respected foreign keys would fail on this fixture. */
	it('drops referenced tables and the ledger, so the next start migrates again', async () => {
		await migrated();
		await expect(
			resetDatabase(database, { intent: 'confirmed-destructive-reset' }),
		).resolves.toMatchObject({
			dialectId: 'postgresql',
			droppedTables: [
				'_coreloom_migrations_v2',
				'reset_children',
				'reset_parents',
			],
		});
		await expect(databaseResetPlan(database)).resolves.toEqual([]);

		await runDatabaseMigrations(database, 'reset.core', migrations);
		await expect(
			database.query({ text: 'SELECT id FROM reset_parents' }),
		).resolves.toEqual({ rows: [], rowCount: 0 });
	});

	it('is a no-op on an empty database and refuses an unconfirmed intent', async () => {
		await expect(
			resetDatabase(database, { intent: 'confirmed-destructive-reset' }),
		).resolves.toEqual({ dialectId: 'postgresql', droppedTables: [] });
		await expect(
			resetDatabase(database, {
				intent: 'reset' as 'confirmed-destructive-reset',
			}),
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
	});

	/* A module holds a runtime lease, never a migration lease, so the tenant
	   requirement is what keeps a reset out of request-time code. */
	it('refuses a plan and a reset on a tenant-scoped runtime handle', async () => {
		const client: PostgresDriverClient = {
			query: async () => ({ rows: [], rowCount: 0 }),
			release: () => undefined,
		};
		const pool: PostgresDriverPool = {
			connect: async () => client,
			end: async () => undefined,
		};
		const runtime = new PostgresDatabaseAdapter({ pool, tenantRequired: true });
		try {
			await expect(databaseResetPlan(runtime)).rejects.toMatchObject({
				code: 'TENANT_CONTEXT_REQUIRED',
			});
			await expect(
				resetDatabase(runtime, { intent: 'confirmed-destructive-reset' }),
			).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
		} finally {
			await runtime.dispose();
		}
	});
});
