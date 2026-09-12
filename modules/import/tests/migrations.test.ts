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
import { migrateImportDatabase } from '../src/services/database-repository.ts';
import { IMPORT_TENANT_TABLES } from './support/harness.ts';

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
		namespace: 'import.core',
		purpose: 'migration',
	});
	return lease.database;
}

interface RelationSecurity {
	readonly relrowsecurity: boolean;
	readonly relforcerowsecurity: boolean;
	readonly policies: number | bigint | string;
}

describe('import migrations', () => {
	it('mirrors every numbered up file byte for byte', () => {
		for (const migration of databaseMigrations) {
			expect(migration.sql.postgresql).toBe(
				readFileSync(new URL(`${migration.id}.up.sql`, directory), 'utf8'),
			);
		}
	});

	it('ships a down file for every up file', () => {
		for (const migration of databaseMigrations) {
			expect([
				migration.id,
				readFileSync(new URL(`${migration.id}.down.sql`, directory), 'utf8')
					.length > 0,
			]).toEqual([migration.id, true]);
		}
	});

	it('applies every migration once and records it in the ledger', async () => {
		const database = await migrator();
		const applied = await runDatabaseMigrations(
			database,
			'import.core',
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
					parameters: ['import.core'],
				}),
			{ access: 'read' },
		);
		expect(ledger.rows.map((row) => row.id)).toEqual(
			databaseMigrations.map((migration) => migration.id),
		);

		const second = await runDatabaseMigrations(
			database,
			'import.core',
			databaseMigrations,
		);
		expect(second.every((result) => result.action === 'unchanged')).toBe(true);
	});

	it('forces row level security with a tenant policy on every tenant table', async () => {
		const database = await migrator();
		await migrateImportDatabase(database);
		for (const table of IMPORT_TENANT_TABLES) {
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

	it('grants the background role the routing columns and nothing else', async () => {
		const database = await migrator();
		await migrateImportDatabase(database);
		const granted = async (table: string, column: string) =>
			(
				await database.transaction(
					(transaction) =>
						transaction.query<{ allowed: boolean }>({
							text: `SELECT has_column_privilege('coreloom_background',
							 $1, $2, 'SELECT') AS allowed`,
							parameters: [table, column],
						}),
					{ access: 'read' },
				)
			).rows[0]?.allowed === true;

		for (const column of ['tenant_id', 'id', 'status', 'started_at']) {
			expect([column, await granted('import_jobs', column)]).toEqual([
				column,
				true,
			]);
		}
		for (const column of [
			'document_id',
			'document_ref',
			'target',
			'mode',
			'columns_json',
			'requester_json',
			'requester_account_id',
		]) {
			expect([column, await granted('import_jobs', column)]).toEqual([
				column,
				false,
			]);
		}
		/* The outcomes and the mappings carry no routing at all, so the role never
		   sees a column of either. */
		for (const column of ['id', 'tenant_id', 'reason', 'record_ref']) {
			expect([column, await granted('import_job_rows', column)]).toEqual([
				column,
				false,
			]);
		}
		for (const column of ['id', 'tenant_id', 'columns_json']) {
			expect([column, await granted('import_mappings', column)]).toEqual([
				column,
				false,
			]);
		}
	});

	it('gives the background role no policy beyond reading', async () => {
		const database = await migrator();
		await migrateImportDatabase(database);
		const policies = await database.transaction(
			(transaction) =>
				transaction.query<{ polcmd: string }>({
					text: `SELECT polcmd FROM pg_policy
					 WHERE polname = 'import_jobs_background_policy'`,
				}),
			{ access: 'read' },
		);
		/* 'r' is SELECT; anything else would be a write path for a role that must
		   never have one. */
		expect(policies.rows.map((row) => row.polcmd)).toEqual(['r']);
	});

	it('creates the indexes the list, the routing read and the export walk', async () => {
		const database = await migrator();
		await migrateImportDatabase(database);
		const present = await database.transaction(
			(transaction) =>
				transaction.query<{ indexname: string }>({
					text: `SELECT indexname FROM pg_indexes
					 WHERE schemaname = current_schema() AND tablename = 'import_jobs'
					 ORDER BY indexname`,
				}),
			{ access: 'read' },
		);
		expect(present.rows.map((row) => row.indexname)).toEqual([
			'import_jobs_pkey',
			'import_jobs_routing_idx',
			/* Ascending: the export and the sweep walk (started_at, id) forwards,
			   which the descending listing index cannot answer. */
			'import_jobs_tenant_export_idx',
			'import_jobs_tenant_started_idx',
		]);
	});

	it('refuses a second outcome for one row of one job', async () => {
		const database = await migrator();
		await migrateImportDatabase(database);
		const insert = (id: string) =>
			database.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO import_job_rows
						 (id, tenant_id, job_id, row_number, outcome, field, reason, record_ref)
						 VALUES ($1, 'tenant-a', 'job-1', 4, 'valid', NULL, NULL, NULL)`,
						parameters: [id],
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			);
		await insert('row-1');
		await expect(insert('row-2')).rejects.toThrow();
	});

	it('refuses a settled job with no finish time and an open job with one', async () => {
		const database = await migrator();
		await migrateImportDatabase(database);
		const insert = (id: string, status: string, completedAt: number | null) =>
			database.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO import_jobs
						 (id, tenant_id, target, document_id, document_ref, mode, dry_run,
						  valid_only, status, total_rows, valid_rows, written_rows,
						  failed_rows, requester_account_id, requester_json, columns_json,
						  failure_code, claimed_at, started_at, completed_at)
						 VALUES ($1, 'tenant-a', 'users.core.members', 'document-1',
						         'reference-1', 'create-only', 0, 0, $2, 0, 0, 0, 0,
						         'account-ada', '{}', '{}', NULL, NULL, 1, $3)`,
						parameters: [id, status, completedAt],
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			);
		await expect(insert('job-a', 'completed', null)).rejects.toThrow();
		await expect(insert('job-b', 'parsing', 10)).rejects.toThrow();
		await expect(insert('job-c', 'completed', 10)).resolves.toBeDefined();
	});

	it('adopts a schema that already carries the objects instead of reapplying them', async () => {
		const database = await migrator();
		await migrateImportDatabase(database);
		await database.transaction(
			(transaction) =>
				transaction.execute({
					text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = $1`,
					parameters: ['import.core'],
				}),
			{ access: 'write' },
		);

		const status = await databaseMigrationStatus(
			database,
			'import.core',
			databaseMigrations,
		);
		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'adopted'),
		);

		const adopted = await runDatabaseMigrations(
			database,
			'import.core',
			databaseMigrations,
		);
		expect(adopted.every((result) => result.action === 'adopted')).toBe(true);
	});

	it('reports a pending schema before anything is applied', async () => {
		const database = await migrator();
		const status = await databaseMigrationStatus(
			database,
			'import.core',
			databaseMigrations,
		);
		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'pending'),
		);
	});
});
