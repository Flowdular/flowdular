import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
	DATABASE_MIGRATION_LEDGER,
	databaseMigrationStatus,
	runDatabaseMigrations,
	type DatabaseHandle,
	type DatabaseProvider,
} from '@flowdular/database';
import { createPgliteTestProvider } from '@flowdular/database-testing';
import { databaseMigrations } from '../src/services/migration.ts';
import { migrateSearchDatabase } from '../src/services/database-repository.ts';
import { SEARCH_TENANT_TABLES } from './support/database.ts';

const directory = new URL('../migrations/', import.meta.url);

let providers: DatabaseProvider[] = [];

afterEach(async () => {
	const open = providers;
	providers = [];
	for (const provider of open) await provider.dispose();
});

async function migrator(): Promise<DatabaseHandle> {
	const provider = createPgliteTestProvider();
	providers.push(provider);
	const lease = await provider.acquire({
		namespace: 'search.core',
		purpose: 'migration',
	});
	return lease.database;
}

interface RelationSecurity {
	readonly relrowsecurity: boolean;
	readonly relforcerowsecurity: boolean;
	readonly policies: number | bigint | string;
}

describe('search migrations', () => {
	it('mirrors every numbered up file byte for byte', () => {
		for (const migration of databaseMigrations) {
			expect(migration.sql.postgresql).toBe(
				readFileSync(new URL(`${migration.id}.up.sql`, directory), 'utf8'),
			);
		}
	});

	it('applies every migration once and records it in the ledger', async () => {
		const database = await migrator();
		const applied = await runDatabaseMigrations(
			database,
			'search.core',
			databaseMigrations,
		);
		expect(applied.map((result) => [result.id, result.action])).toEqual(
			databaseMigrations.map((migration) => [migration.id, 'applied']),
		);
		const ledger = await database.transaction(
			(transaction) =>
				transaction.query<{ id: string }>({
					text: `SELECT id FROM ${DATABASE_MIGRATION_LEDGER}
					 WHERE namespace = $1 ORDER BY id`,
					parameters: ['search.core'],
				}),
			{ access: 'read' },
		);
		expect(ledger.rows.map((row) => row.id)).toEqual(
			databaseMigrations.map((migration) => migration.id),
		);

		const second = await runDatabaseMigrations(
			database,
			'search.core',
			databaseMigrations,
		);
		expect(second.every((result) => result.action === 'unchanged')).toBe(true);
	});

	it('forces row level security with a tenant policy on every tenant table', async () => {
		const database = await migrator();
		await migrateSearchDatabase(database);
		for (const table of SEARCH_TENANT_TABLES) {
			const security = await database.transaction(
				(transaction) =>
					transaction.query<RelationSecurity>({
						text: `SELECT relation.relrowsecurity, relation.relforcerowsecurity,
						              (SELECT count(*) FROM pg_policy
						               WHERE polrelid = relation.oid
						                 AND polname = $2) AS policies
						       FROM pg_class AS relation
						       JOIN pg_namespace AS namespace
						         ON namespace.oid = relation.relnamespace
						       WHERE namespace.nspname = current_schema()
						         AND relation.relname = $1`,
						parameters: [table, `${table}_tenant_policy`],
					}),
				{ access: 'read' },
			);
			expect(security.rows[0]).toMatchObject({
				relrowsecurity: true,
				relforcerowsecurity: true,
			});
			expect(Number(security.rows[0]?.policies)).toBe(1);
		}
	});

	/* The bound of 50 per member depends on one row per member and query text,
	   so the uniqueness is a database rule and not only a service one. */
	it('refuses a second row for the same member and query text', async () => {
		const database = await migrator();
		await migrateSearchDatabase(database);
		const write = (id: string, query: string) =>
			database.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO search_recent_queries
						 (id, tenant_id, account_id, query, ran_at)
						 VALUES ($1, 'tenant-a', 'account-ada', $2, 1)`,
						parameters: [id, query],
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			);

		await write('row-1', 'Ada');
		await expect(write('row-2', 'ada')).rejects.toThrow();
	});

	it('adopts a schema that already carries the objects instead of reapplying them', async () => {
		const database = await migrator();
		await migrateSearchDatabase(database);
		await database.transaction(
			(transaction) =>
				transaction.execute({
					text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = $1`,
					parameters: ['search.core'],
				}),
			{ access: 'write' },
		);

		const status = await databaseMigrationStatus(
			database,
			'search.core',
			databaseMigrations,
		);
		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'adopted'),
		);

		const adopted = await runDatabaseMigrations(
			database,
			'search.core',
			databaseMigrations,
		);
		expect(adopted.every((result) => result.action === 'adopted')).toBe(true);
	});

	it('reports a pending schema before anything is applied', async () => {
		const database = await migrator();
		const status = await databaseMigrationStatus(
			database,
			'search.core',
			databaseMigrations,
		);
		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'pending'),
		);
	});
});
