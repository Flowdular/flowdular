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
import { migrateExportsDatabase } from '../src/services/database-repository.ts';
import { EXPORTS_TENANT_TABLES } from './support/harness.ts';

const directory = new URL('../migrations/', import.meta.url);

const ROUTING_COLUMNS = ['tenant_id', 'id', 'status', 'started_at'] as const;
const HIDDEN_COLUMNS = [
	'list_id',
	'row_count',
	'byte_count',
	'object_id',
	'requester_account_id',
	'requester_json',
	'failure_code',
	'claimed_at',
	'completed_at',
] as const;

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
		namespace: 'exports.core',
		purpose: 'migration',
	});
	return lease.database;
}

describe('exports.core migrations', () => {
	it('mirrors every numbered up file byte for byte', () => {
		for (const migration of databaseMigrations) {
			expect(migration.sql.postgresql).toBe(
				readFileSync(new URL(`${migration.id}.up.sql`, directory), 'utf8'),
			);
		}
	});

	it('ships a down file for every up file', () => {
		for (const migration of databaseMigrations) {
			expect(
				readFileSync(new URL(`${migration.id}.down.sql`, directory), 'utf8'),
			).not.toBe('');
		}
	});

	it('applies every migration once and records it in the ledger', async () => {
		const database = await migrator();
		const applied = await runDatabaseMigrations(
			database,
			'exports.core',
			databaseMigrations,
		);
		expect(applied.map((entry) => entry.action)).toEqual(
			databaseMigrations.map(() => 'applied'),
		);
		const ledger = await database.query<{ id: string }>({
			text: `SELECT id FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = $1 ORDER BY id`,
			parameters: ['exports.core'],
		});
		expect(ledger.rows.map((row) => row.id)).toEqual(
			databaseMigrations.map((migration) => migration.id),
		);
		const again = await runDatabaseMigrations(
			database,
			'exports.core',
			databaseMigrations,
		);
		expect(again.map((entry) => entry.action)).toEqual(
			databaseMigrations.map(() => 'unchanged'),
		);
	});

	it('forces row level security with a tenant policy on every tenant table', async () => {
		const database = await migrator();
		await migrateExportsDatabase(database);
		for (const table of EXPORTS_TENANT_TABLES) {
			const state = await database.query<{
				relrowsecurity: boolean;
				relforcerowsecurity: boolean;
			}>({
				text: 'SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1',
				parameters: [table],
			});
			expect(state.rows[0]).toEqual({
				relrowsecurity: true,
				relforcerowsecurity: true,
			});
			const policy = await database.query<{ count: number | string }>({
				text: `SELECT count(*) AS count FROM pg_policy
				 WHERE polrelid = to_regclass($1) AND polname = $2`,
				parameters: [table, `${table}_tenant_policy`],
			});
			expect(Number(policy.rows[0]?.count)).toBe(1);
		}
	});

	it('grants the background role the routing columns and nothing else', async () => {
		const database = await migrator();
		await migrateExportsDatabase(database);
		for (const column of ROUTING_COLUMNS) {
			const granted = await database.query<{ granted: boolean }>({
				text: `SELECT has_column_privilege('coreloom_background', 'exports_jobs', $1, 'SELECT') AS granted`,
				parameters: [column],
			});
			expect([column, granted.rows[0]?.granted]).toEqual([column, true]);
		}
		for (const column of HIDDEN_COLUMNS) {
			const granted = await database.query<{ granted: boolean }>({
				text: `SELECT has_column_privilege('coreloom_background', 'exports_jobs', $1, 'SELECT') AS granted`,
				parameters: [column],
			});
			expect([column, granted.rows[0]?.granted]).toEqual([column, false]);
		}
	});

	it('gives the background role no policy beyond reading', async () => {
		const database = await migrator();
		await migrateExportsDatabase(database);
		const policy = await database.query<{ polcmd: string }>({
			text: `SELECT polcmd FROM pg_policy
			 WHERE polrelid = to_regclass('exports_jobs') AND polname = 'exports_jobs_background_policy'`,
		});
		expect(policy.rows.map((row) => row.polcmd)).toEqual(['r']);
	});

	it('creates the indexes the list, the routing read and the export walk need', async () => {
		const database = await migrator();
		await migrateExportsDatabase(database);
		const indexes = await database.query<{ indexname: string }>({
			text: `SELECT indexname FROM pg_indexes WHERE tablename = 'exports_jobs' ORDER BY indexname`,
		});
		expect(indexes.rows.map((row) => row.indexname)).toEqual([
			'exports_jobs_pkey',
			'exports_jobs_routing_idx',
			'exports_jobs_tenant_export_idx',
			'exports_jobs_tenant_id_object_id_key',
			'exports_jobs_tenant_started_idx',
		]);
	});

	it('refuses a settled job with no completion and a failed job with no code', async () => {
		const database = await migrator();
		await migrateExportsDatabase(database);
		const insert = (values: string) =>
			database.execute({
				text: `INSERT INTO exports_jobs (id, tenant_id, list_id, status,
				 row_count, byte_count, object_id, requester_account_id,
				 requester_json, failure_code, claimed_at, started_at, completed_at)
				 VALUES (${values})`,
			});
		await expect(
			insert(
				`'a', 't', 'users.core.members', 'completed', 0, 0, NULL, 'account', '{}', NULL, NULL, 1, NULL`,
			),
		).rejects.toThrow();
		await expect(
			insert(
				`'b', 't', 'users.core.members', 'failed', 0, 0, NULL, 'account', '{}', NULL, NULL, 1, 2`,
			),
		).rejects.toThrow();
		await expect(
			insert(
				`'c', 't', 'users.core.members', 'running', 0, 0, 'object-1', 'account', '{}', NULL, NULL, 1, NULL`,
			),
		).rejects.toThrow();
		await expect(
			insert(
				`'d', 't', 'users.core.members', 'requested', 0, 0, NULL, 'account', 'not json', NULL, NULL, 1, NULL`,
			),
		).rejects.toThrow();
	});

	it('adopts a schema that already carries the objects instead of reapplying them', async () => {
		const database = await migrator();
		await migrateExportsDatabase(database);
		await database.execute({
			text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = $1`,
			parameters: ['exports.core'],
		});
		const status = await databaseMigrationStatus(
			database,
			'exports.core',
			databaseMigrations,
		);
		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'adopted'),
		);
		const applied = await runDatabaseMigrations(
			database,
			'exports.core',
			databaseMigrations,
		);
		expect(applied.map((entry) => entry.action)).toEqual(
			databaseMigrations.map(() => 'adopted'),
		);
	});

	it('reports a pending schema before anything is applied', async () => {
		const database = await migrator();
		const status = await databaseMigrationStatus(
			database,
			'exports.core',
			databaseMigrations,
		);
		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'pending'),
		);
	});
});
