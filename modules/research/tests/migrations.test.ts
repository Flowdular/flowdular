import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
	DATABASE_MIGRATION_LEDGER,
	databaseMigrationStatus,
	runDatabaseMigrations,
	type DatabaseHandle,
	type DatabaseProvider,
} from '@flowdular/database';
import { createTestDatabaseProvider } from '@flowdular/database-testing';
import { migrateResearchDatabase } from '../src/services/database-repository.ts';
import {
	databaseMigrations,
	RESEARCH_TENANT_TABLES,
} from '../src/services/migration.ts';

const directory = new URL('../migrations/', import.meta.url);

let providers: DatabaseProvider[] = [];

afterEach(async () => {
	const open = providers;
	providers = [];
	for (const provider of open) await provider.dispose();
});

async function migrator(): Promise<DatabaseHandle> {
	const provider = createTestDatabaseProvider();
	providers.push(provider);
	const lease = await provider.acquire({
		namespace: 'research.core',
		purpose: 'migration',
	});
	return lease.database;
}

interface RelationSecurity {
	readonly relrowsecurity: boolean;
	readonly relforcerowsecurity: boolean;
	readonly policies: number | bigint | string;
}

describe('research migrations', () => {
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
			'research.core',
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
					parameters: ['research.core'],
				}),
			{ access: 'read' },
		);
		expect(ledger.rows.map((row) => row.id)).toEqual(
			databaseMigrations.map((migration) => migration.id),
		);
		const second = await runDatabaseMigrations(
			database,
			'research.core',
			databaseMigrations,
		);
		expect(second.every((result) => result.action === 'unchanged')).toBe(true);
	});

	it('RESEARCH-TENANT-BOUNDARY forces row level security with a tenant policy on every tenant table', async () => {
		const database = await migrator();
		await migrateResearchDatabase(database);
		for (const table of RESEARCH_TENANT_TABLES) {
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
			expect([table, security.rows[0]?.relrowsecurity]).toEqual([table, true]);
			expect([table, security.rows[0]?.relforcerowsecurity]).toEqual([
				table,
				true,
			]);
			expect([table, Number(security.rows[0]?.policies)]).toEqual([table, 1]);
		}
	});

	it('adopts a schema that already carries the objects instead of reapplying them', async () => {
		const database = await migrator();
		await migrateResearchDatabase(database);
		await database.transaction(
			(transaction) =>
				transaction.execute({
					text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = $1`,
					parameters: ['research.core'],
				}),
			{ access: 'write' },
		);
		const status = await databaseMigrationStatus(
			database,
			'research.core',
			databaseMigrations,
		);
		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'adopted'),
		);
	});
});
