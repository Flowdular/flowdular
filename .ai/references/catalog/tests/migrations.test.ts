import { readdirSync, readFileSync } from 'node:fs';
import type {
	DatabaseAdapterLease,
	DatabaseProvider,
} from '@flowdular/sdk/database';
import {
	DATABASE_MIGRATION_LEDGER,
	databaseMigrationStatus,
	runDatabaseMigrations,
} from '@flowdular/sdk/database';
import { createTestDatabaseProvider } from '@flowdular/sdk/database-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseMigrations } from '../src/services/migration.ts';

const migrationDirectory = new URL('../migrations/', import.meta.url);

const MODULE_TABLES =
	'catalog_items, catalog_items_history, catalog_items_history_v2, catalog_idempotency_ledger';

let provider: DatabaseProvider;
let lease: DatabaseAdapterLease;

beforeAll(async () => {
	provider = createTestDatabaseProvider();
	lease = await provider.acquire({
		namespace: 'catalog.core',
		purpose: 'migration',
	});
});

/* Every case states its own starting point, so the shared cluster goes back to
   an unmigrated, unrecorded schema first. */
beforeEach(async () => {
	await lease.database.execute({
		text: `DROP TABLE IF EXISTS ${MODULE_TABLES} CASCADE`,
	});
	if (await lease.database.schema.hasTable(DATABASE_MIGRATION_LEDGER)) {
		await lease.database.execute({
			text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = 'catalog.core'`,
		});
	}
});

afterAll(async () => {
	await lease?.release();
	await provider?.dispose();
});

function apply() {
	return runDatabaseMigrations(
		lease.database,
		'catalog.core',
		databaseMigrations,
	);
}

function status() {
	return databaseMigrationStatus(
		lease.database,
		'catalog.core',
		databaseMigrations,
	);
}

describe('catalog migrations', () => {
	it('mirrors every PostgreSQL up file byte for byte', () => {
		const files = readdirSync(migrationDirectory)
			.filter((name) => name.endsWith('.up.sql'))
			.sort();

		expect(
			databaseMigrations.map((migration) => `${migration.id}.up.sql`),
		).toEqual(files);
		for (const migration of databaseMigrations) {
			expect(migration.sql.postgresql).toBe(
				readFileSync(
					new URL(`${migration.id}.up.sql`, migrationDirectory),
					'utf8',
				),
			);
			/* PostgreSQL and nothing else. A stray dialect key would ship SQL no
			   deployment runs and no test covers. */
			expect(Object.keys(migration.sql)).toEqual(['postgresql']);
		}
	});

	it('declares forced PostgreSQL row security for every tenant table', () => {
		for (const migration of databaseMigrations) {
			const sql = migration.sql.postgresql ?? '';
			expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
			expect(sql).toContain('FORCE ROW LEVEL SECURITY');
			expect(sql).toContain("current_setting('coreloom.tenant_id', true)");
			expect(sql).toContain('WITH CHECK');
		}
	});

	it('applies every migration on a fresh database', async () => {
		expect((await apply()).map((entry) => entry.action)).toEqual(
			databaseMigrations.map(() => 'applied'),
		);
		expect((await status()).map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'applied'),
		);
	});

	it('adopts a schema that predates the ledger without changing its rows', async () => {
		await apply();
		await lease.database.transaction(
			(transaction) =>
				transaction.execute({
					text: `INSERT INTO catalog_items
				 (id, tenant_id, sku, sku_normalized, name, kind, unit,
				  base_price_minor, currency, status, created_at)
				 VALUES ('item-1', 'tenant-a', 'SKU-1', 'sku-1', 'Bolt', 'product',
				         'pcs', 500, 'EUR', 'active', 1)`,
				}),
			{ tenantId: 'tenant-a', access: 'write' },
		);
		await lease.database.execute({
			text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = 'catalog.core'`,
		});

		expect((await status()).map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'adopted'),
		);
		expect((await apply()).map((entry) => entry.action)).toEqual(
			databaseMigrations.map(() => 'adopted'),
		);
		expect(
			(
				await lease.database.transaction(
					(transaction) =>
						transaction.query<{ sku: string }>({
							text: 'SELECT sku FROM catalog_items',
						}),
					{ tenantId: 'tenant-a', access: 'read' },
				)
			).rows,
		).toEqual([{ sku: 'SKU-1' }]);
	});

	it('runs clean on a second migration pass', async () => {
		await apply();

		expect((await apply()).map((entry) => entry.action)).toEqual(
			databaseMigrations.map(() => 'unchanged'),
		);
	});
});
