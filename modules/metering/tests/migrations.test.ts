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
import { migrateMeteringDatabase } from '../src/services/database-repository.ts';
import {
	databaseMigrations,
	METERING_TENANT_TABLES,
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
		namespace: 'metering.core',
		purpose: 'migration',
	});
	return lease.database;
}

interface RelationSecurity {
	readonly relrowsecurity: boolean;
	readonly relforcerowsecurity: boolean;
	readonly policies: number | bigint | string;
}

describe('metering migrations', () => {
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
			'metering.core',
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
					parameters: ['metering.core'],
				}),
			{ access: 'read' },
		);
		expect(ledger.rows.map((row) => row.id)).toEqual(
			databaseMigrations.map((migration) => migration.id),
		);

		const second = await runDatabaseMigrations(
			database,
			'metering.core',
			databaseMigrations,
		);
		expect(second.every((result) => result.action === 'unchanged')).toBe(true);
	});

	it('forces row level security with a tenant policy on every tenant table', async () => {
		const database = await migrator();
		await migrateMeteringDatabase(database);
		for (const table of METERING_TENANT_TABLES) {
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
		await migrateMeteringDatabase(database);
		for (const table of METERING_TENANT_TABLES) {
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

	it('keeps one bucket per meter and UTC day, and one claim per source reference', async () => {
		const database = await migrator();
		await migrateMeteringDatabase(database);
		const insert = (text: string, parameters: readonly unknown[]) =>
			database.transaction(
				(transaction) =>
					transaction.execute({
						text,
						parameters: parameters as never,
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			);
		const bucket = `INSERT INTO metering_buckets
		 (id, tenant_id, meter_key, day, amount, events, updated_at)
		 VALUES ($1, 'tenant-a', 'agents.core.run-tokens', '2026-09-11', 1, 1, 1)`;
		await insert(bucket, ['bucket-1']);
		await expect(insert(bucket, ['bucket-2'])).rejects.toThrow();

		const claim = `INSERT INTO metering_records
		 (id, tenant_id, meter_key, source_ref, day, amount, recorded_at)
		 VALUES ($1, 'tenant-a', 'agents.core.run-tokens', 'run-1',
		         '2026-09-11', 1, 1)`;
		await insert(claim, ['record-1']);
		await expect(insert(claim, ['record-2'])).rejects.toThrow();

		const notice = `INSERT INTO metering_threshold_notices
		 (id, tenant_id, meter_key, month, threshold, sent_at)
		 VALUES ($1, 'tenant-a', 'agents.core.run-tokens', '2026-09',
		         'warning', 1)`;
		await insert(notice, ['notice-1']);
		await expect(insert(notice, ['notice-2'])).rejects.toThrow();
	});

	it('adopts a schema that already carries the objects instead of reapplying them', async () => {
		const database = await migrator();
		await migrateMeteringDatabase(database);
		await database.transaction(
			(transaction) =>
				transaction.execute({
					text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = $1`,
					parameters: ['metering.core'],
				}),
			{ access: 'write' },
		);

		const status = await databaseMigrationStatus(
			database,
			'metering.core',
			databaseMigrations,
		);
		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'adopted'),
		);

		const adopted = await runDatabaseMigrations(
			database,
			'metering.core',
			databaseMigrations,
		);
		expect(adopted.every((result) => result.action === 'adopted')).toBe(true);
	});

	it('reports a pending schema before anything is applied', async () => {
		const database = await migrator();
		const status = await databaseMigrationStatus(
			database,
			'metering.core',
			databaseMigrations,
		);
		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'pending'),
		);
	});
});
