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
import { migrateAccessDatabase } from '../src/services/database-repository.ts';
import {
	ACCESS_TENANT_TABLES,
	databaseMigrations,
} from '../src/services/migration.ts';

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
		namespace: 'access.core',
		purpose: 'migration',
	});
	return lease.database;
}

interface RelationSecurity {
	readonly relrowsecurity: boolean;
	readonly relforcerowsecurity: boolean;
	readonly policies: number | bigint | string;
}

describe('access migrations', () => {
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
			'access.core',
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
					parameters: ['access.core'],
				}),
			{ access: 'read' },
		);
		expect(ledger.rows.map((row) => row.id)).toEqual(
			databaseMigrations.map((migration) => migration.id),
		);
		const second = await runDatabaseMigrations(
			database,
			'access.core',
			databaseMigrations,
		);
		expect(second.every((result) => result.action === 'unchanged')).toBe(true);
	});

	it('forces row level security with a tenant policy on every tenant table', async () => {
		const database = await migrator();
		await migrateAccessDatabase(database);

		for (const table of ACCESS_TENANT_TABLES) {
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

	/* No loop of this module reads across workspaces, so the cross-tenant role
	   is granted nothing at all. */
	it('grants the background role no column of any table', async () => {
		const database = await migrator();
		await migrateAccessDatabase(database);

		for (const table of ACCESS_TENANT_TABLES) {
			const granted = await database.transaction(
				(transaction) =>
					transaction.query<{ allowed: boolean }>({
						text: `SELECT has_table_privilege('coreloom_background', $1, 'SELECT')
						 AS allowed`,
						parameters: [table],
					}),
				{ access: 'read' },
			);
			expect([table, granted.rows[0]?.allowed]).toEqual([table, false]);
		}
	});

	it('refuses a period that ends before it starts and a note past its bound', async () => {
		const database = await migrator();
		await migrateAccessDatabase(database);
		const insert = (
			period: readonly [string, string],
			note: string | null,
			id: string,
		) =>
			database.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO access_attestations (id, tenant_id,
						 reviewer_account_id, reviewer_label, period_from, period_to,
						 member_count, active_member_count, role_count, extra_scope_count,
						 token_count, provider_count, note, created_at)
						 VALUES ($1, 'tenant-a', 'account-1', 'a@example.com', $2, $3,
						 0, 0, 0, 0, 0, 0, $4, 1)`,
						parameters: [id, period[0], period[1], note],
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			);

		await insert(['2026-06-01T00:00:00Z', '2026-06-30T00:00:00Z'], null, 'ok');
		await expect(
			insert(['2026-06-30T00:00:00Z', '2026-06-01T00:00:00Z'], null, 'bad'),
		).rejects.toThrow();
		await expect(
			insert(
				['2026-06-01T00:00:00Z', '2026-06-30T00:00:00Z'],
				'x'.repeat(2001),
				'long',
			),
		).rejects.toThrow();
	});

	it('adopts a schema that already carries the objects instead of reapplying them', async () => {
		const database = await migrator();
		await migrateAccessDatabase(database);
		await database.transaction(
			(transaction) =>
				transaction.execute({
					text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = $1`,
					parameters: ['access.core'],
				}),
			{ access: 'write' },
		);

		const status = await databaseMigrationStatus(
			database,
			'access.core',
			databaseMigrations,
		);

		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'adopted'),
		);
		const adopted = await runDatabaseMigrations(
			database,
			'access.core',
			databaseMigrations,
		);
		expect(adopted.every((result) => result.action === 'adopted')).toBe(true);
	});

	it('reports a pending schema before anything is applied', async () => {
		const database = await migrator();

		const status = await databaseMigrationStatus(
			database,
			'access.core',
			databaseMigrations,
		);

		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'pending'),
		);
	});
});
