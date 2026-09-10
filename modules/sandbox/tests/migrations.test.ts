import { readdirSync, readFileSync } from 'node:fs';
import type {
	DatabaseAdapterLease,
	DatabaseProvider,
} from '@flowdular/database';
import {
	DATABASE_MIGRATION_LEDGER,
	databaseMigrationStatus,
	runDatabaseMigrations,
} from '@flowdular/database';
import { createTestDatabaseProvider } from '@flowdular/database-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseMigrations } from '../src/services/migration.ts';

const migrationDirectory = new URL('../migrations/', import.meta.url);

const MODULE_TABLES =
	'sandbox_access_grants, sandbox_sessions, sandbox_audit_events';

let provider: DatabaseProvider;
let lease: DatabaseAdapterLease;

beforeAll(async () => {
	provider = createTestDatabaseProvider();
	lease = await provider.acquire({
		namespace: 'sandbox.core',
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
			text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = 'sandbox.core'`,
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
		'sandbox.core',
		databaseMigrations,
	);
}

function status() {
	return databaseMigrationStatus(
		lease.database,
		'sandbox.core',
		databaseMigrations,
	);
}

describe('sandbox migrations', () => {
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
					text: `INSERT INTO sandbox_access_grants
				 (id, tenant_id, account_id, email, display_name, capabilities_json,
				  granted_by, granted_at)
				 VALUES ('grant-1', 'tenant-a', 'account-a', 'admin@example.com',
				  'Administrator', '["sandbox.access.use"]', 'owner-a', 1)`,
				}),
			{ tenantId: 'tenant-a', access: 'write' },
		);
		await lease.database.execute({
			text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = 'sandbox.core'`,
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
						transaction.query<{ email: string }>({
							text: 'SELECT email FROM sandbox_access_grants',
						}),
					{ tenantId: 'tenant-a', access: 'read' },
				)
			).rows,
		).toEqual([{ email: 'admin@example.com' }]);
	});

	it('runs clean on a second migration pass', async () => {
		await apply();

		expect((await apply()).map((entry) => entry.action)).toEqual(
			databaseMigrations.map(() => 'unchanged'),
		);
	});
});
