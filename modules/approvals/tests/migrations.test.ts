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
import { migrateApprovalsDatabase } from '../src/services/database-repository.ts';
import { APPROVALS_TENANT_TABLES } from './support/database.ts';

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
		namespace: 'approvals.core',
		purpose: 'migration',
	});
	return lease.database;
}

interface RelationSecurity {
	readonly relrowsecurity: boolean;
	readonly relforcerowsecurity: boolean;
	readonly policies: number | bigint | string;
}

const REQUEST_ROW = `INSERT INTO approvals_requests
 (id, tenant_id, subject_module, subject_ref, permission, action, title,
  summary, requester_account_id, requirement_json, decisions_needed, status,
  expires_at, resolved_at, created_at)
 VALUES ($1, 'tenant-a', 'catalog.core', $2, 'catalog.products.manage',
         'publish', 'Publish', NULL, 'account-requester',
         '{"roleKey":"owner","scope":null,"decisions":1,"expiresInDays":7}',
         1, $3, 1, NULL, 1)`;

describe('approvals migrations', () => {
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
			'approvals.core',
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
					parameters: ['approvals.core'],
				}),
			{ access: 'read' },
		);
		expect(ledger.rows.map((row) => row.id)).toEqual(
			databaseMigrations.map((migration) => migration.id),
		);

		const second = await runDatabaseMigrations(
			database,
			'approvals.core',
			databaseMigrations,
		);
		expect(second.every((result) => result.action === 'unchanged')).toBe(true);
	});

	it('forces row level security with a tenant policy on every tenant table', async () => {
		const database = await migrator();
		await migrateApprovalsDatabase(database);
		for (const table of APPROVALS_TENANT_TABLES) {
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
		await migrateApprovalsDatabase(database);
		const granted = async (column: string) =>
			(
				await database.transaction(
					(transaction) =>
						transaction.query<{ allowed: boolean }>({
							text: `SELECT has_column_privilege('coreloom_background',
							 'approvals_requests', $1, 'SELECT') AS allowed`,
							parameters: [column],
						}),
					{ access: 'read' },
				)
			).rows[0]?.allowed === true;

		for (const column of ['tenant_id', 'id', 'expires_at', 'status']) {
			expect([column, await granted(column)]).toEqual([column, true]);
		}
		for (const column of [
			'subject_ref',
			'requester_account_id',
			'requirement_json',
			'title',
			'summary',
		]) {
			expect([column, await granted(column)]).toEqual([column, false]);
		}
	});

	/* The one pending request per subject is a database rule, not only a service
	   one: it is what makes reopening after a crash find the open request. */
	it('admits one pending request per subject and any number of resolved ones', async () => {
		const database = await migrator();
		await migrateApprovalsDatabase(database);
		const write = async (
			id: string,
			subjectRef: string,
			status: string,
		): Promise<'accepted' | 'refused'> => {
			try {
				await database.transaction(
					(transaction) =>
						transaction.execute({
							text: REQUEST_ROW,
							parameters: [id, subjectRef, status],
						}),
					{ access: 'write', tenantId: 'tenant-a' },
				);
				return 'accepted';
			} catch {
				return 'refused';
			}
		};

		expect(await write('r1', 'product-1', 'pending')).toBe('accepted');
		expect(await write('r2', 'product-1', 'pending')).toBe('refused');
		expect(await write('r3', 'product-1', 'approved')).toBe('accepted');
		expect(await write('r4', 'product-1', 'approved')).toBe('accepted');
		expect(await write('r5', 'product-2', 'pending')).toBe('accepted');
	});

	it('refuses a decision row whose account and kind disagree', async () => {
		const database = await migrator();
		await migrateApprovalsDatabase(database);
		const write = async (
			id: string,
			decision: string,
			account: string | null,
		): Promise<'accepted' | 'refused'> => {
			try {
				await database.transaction(
					(transaction) =>
						transaction.execute({
							text: `INSERT INTO approvals_decisions
							 (id, tenant_id, request_id, decider_account_id, decision,
							  comment, decided_at)
							 VALUES ($1, 'tenant-a', 'r1', $2, $3, NULL, 1)`,
							parameters: [id, account, decision],
						}),
					{ access: 'write', tenantId: 'tenant-a' },
				);
				return 'accepted';
			} catch {
				return 'refused';
			}
		};

		expect(await write('d1', 'approve', 'account-ada')).toBe('accepted');
		expect(await write('d2', 'approve', 'account-ada')).toBe('refused');
		expect(await write('d3', 'reject', 'account-bo')).toBe('accepted');
		expect(await write('d4', 'expire', null)).toBe('accepted');
		expect(await write('d5', 'expire', 'account-cy')).toBe('refused');
		expect(await write('d6', 'approve', null)).toBe('refused');
	});

	it('adopts a schema that already carries the objects instead of reapplying them', async () => {
		const database = await migrator();
		await migrateApprovalsDatabase(database);
		await database.transaction(
			(transaction) =>
				transaction.execute({
					text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = $1`,
					parameters: ['approvals.core'],
				}),
			{ access: 'write' },
		);

		const status = await databaseMigrationStatus(
			database,
			'approvals.core',
			databaseMigrations,
		);
		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'adopted'),
		);

		const adopted = await runDatabaseMigrations(
			database,
			'approvals.core',
			databaseMigrations,
		);
		expect(adopted.every((result) => result.action === 'adopted')).toBe(true);
	});

	it('reports a pending schema before anything is applied', async () => {
		const database = await migrator();
		const status = await databaseMigrationStatus(
			database,
			'approvals.core',
			databaseMigrations,
		);
		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'pending'),
		);
	});
});
