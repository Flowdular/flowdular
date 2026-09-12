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
import { migrateNotificationsDatabase } from '../src/services/database-repository.ts';
import { NOTIFICATIONS_TENANT_TABLES } from './support/database.ts';

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
		namespace: 'notifications.core',
		purpose: 'migration',
	});
	return lease.database;
}

/** One row per table whose kind check 0009 replaces, under a new kind. */
const APPROVAL_KIND_WRITES: Readonly<Record<string, string>> = {
	notifications_inbox: `INSERT INTO notifications_inbox
	 (id, tenant_id, recipient_account_id, kind, title, source_module,
	  source_ref, status, created_at)
	 VALUES ('inbox-approval', 'tenant-a', 'account-ada', 'approval-requested',
	         'Purchase order 4711', 'approvals.core', 'approval-4711',
	         'unread', 1)`,
	notifications_preferences: `INSERT INTO notifications_preferences
	 (id, tenant_id, recipient_account_id, kind, enabled, created_at, updated_at)
	 VALUES ('preference-approval', 'tenant-a', 'account-ada',
	         'approval-decided', 1, 1, 1)`,
	notifications_deliveries: `INSERT INTO notifications_deliveries
	 (id, tenant_id, subscription_id, kind, source_module, source_ref,
	  sequence, attempt_number, status, scheduled_for, payload_digest,
	  payload_bytes, occurred_at, created_at)
	 VALUES ('delivery-approval', 'tenant-a', 'subscription-a',
	         'approval-requested', 'approvals.core', 'approval-4711',
	         1, 1, 'pending', 1, 'digest', 10, 1, 1)`,
};

/** One row per table whose kind check 0010 replaces, under the new kind. */
const METER_THRESHOLD_KIND_WRITES: Readonly<Record<string, string>> = {
	notifications_inbox: `INSERT INTO notifications_inbox
	 (id, tenant_id, recipient_account_id, kind, title, source_module,
	  source_ref, status, created_at)
	 VALUES ('inbox-meter', 'tenant-a', 'account-ada', 'meter-threshold',
	         'Agent tokens at 80 percent', 'metering.core',
	         'agents.core.run-tokens:2026-09:warning', 'unread', 1)`,
	notifications_preferences: `INSERT INTO notifications_preferences
	 (id, tenant_id, recipient_account_id, kind, enabled, created_at, updated_at)
	 VALUES ('preference-meter', 'tenant-a', 'account-ada',
	         'meter-threshold', 1, 1, 1)`,
	notifications_deliveries: `INSERT INTO notifications_deliveries
	 (id, tenant_id, subscription_id, kind, source_module, source_ref,
	  sequence, attempt_number, status, scheduled_for, payload_digest,
	  payload_bytes, occurred_at, created_at)
	 VALUES ('delivery-meter', 'tenant-a', 'subscription-a',
	         'meter-threshold', 'metering.core',
	         'agents.core.run-tokens:2026-09:warning',
	         1, 1, 'pending', 1, 'digest', 10, 1, 1)`,
};

interface RelationSecurity {
	readonly relrowsecurity: boolean;
	readonly relforcerowsecurity: boolean;
	readonly policies: number | bigint | string;
}

describe('notifications migrations', () => {
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
			'notifications.core',
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
					parameters: ['notifications.core'],
				}),
			{ access: 'read' },
		);
		expect(ledger.rows.map((row) => row.id)).toEqual(
			databaseMigrations.map((migration) => migration.id),
		);

		const second = await runDatabaseMigrations(
			database,
			'notifications.core',
			databaseMigrations,
		);
		expect(second.every((result) => result.action === 'unchanged')).toBe(true);
	});

	it('forces row level security with a tenant policy on every tenant table', async () => {
		const database = await migrator();
		await migrateNotificationsDatabase(database);
		for (const table of NOTIFICATIONS_TENANT_TABLES) {
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

	it('grants the background role the routing columns and nothing else', async () => {
		const database = await migrator();
		await migrateNotificationsDatabase(database);
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

		for (const column of [
			'tenant_id',
			'id',
			'scheduled_for',
			'status',
			'claimed_at',
		]) {
			expect([
				column,
				await granted('notifications_deliveries', column),
			]).toEqual([column, true]);
		}
		for (const column of [
			'subscription_id',
			'source_ref',
			'title',
			'payload_digest',
			'error_class',
		]) {
			expect([
				column,
				await granted('notifications_deliveries', column),
			]).toEqual([column, false]);
		}
	});

	it('grants the background role the rotation inventory columns and nothing else', async () => {
		const database = await migrator();
		await migrateNotificationsDatabase(database);
		const granted = async (column: string) =>
			(
				await database.transaction(
					(transaction) =>
						transaction.query<{ allowed: boolean }>({
							text: `SELECT has_column_privilege('coreloom_background',
							 'notifications_webhook_subscriptions', $1, 'SELECT') AS allowed`,
							parameters: [column],
						}),
					{ access: 'read' },
				)
			).rows[0]?.allowed === true;

		for (const column of ['tenant_id', 'secret_key_id']) {
			expect([column, await granted(column)]).toEqual([column, true]);
		}
		for (const column of [
			'secret_ciphertext',
			'secret_iv',
			'secret_tag',
			'secret_fingerprint',
			'url',
			'name',
		]) {
			expect([column, await granted(column)]).toEqual([column, false]);
		}
	});

	/* The column is NOT NULL, so a deployment that already holds attempt rows
	   only migrates if they are given a value. They keep the empty default and
	   the digest they were written with. */
	it('gives an attempt row written before the title column the empty default', async () => {
		const database = await migrator();
		const before = databaseMigrations.filter(
			(migration) => migration.id < '0006_notifications_delivery_title',
		);
		await runDatabaseMigrations(database, 'notifications.core', before);
		await database.transaction(
			(transaction) =>
				transaction.execute({
					text: `INSERT INTO notifications_deliveries
					 (id, tenant_id, subscription_id, kind, source_module, source_ref,
					  sequence, attempt_number, status, scheduled_for, payload_digest,
					  payload_bytes, occurred_at, created_at)
					 VALUES ('delivery-legacy', 'tenant-a', 'subscription-a',
					         'agent-run-failed', 'agents.core', 'run-legacy',
					         1, 1, 'succeeded', 1, 'digest', 10, 1, 1)`,
				}),
			{ access: 'write', tenantId: 'tenant-a' },
		);

		await migrateNotificationsDatabase(database);

		const rows = await database.transaction(
			(transaction) =>
				transaction.query<{ title: string }>({
					text: 'SELECT title FROM notifications_deliveries',
				}),
			{ access: 'read', tenantId: 'tenant-a' },
		);
		expect(rows.rows).toEqual([{ title: '' }]);
	});

	/* The kind list is a database rule, not only a service one, so an approval
	   kind has to be refused on every table the check guards until 0009 has
	   replaced all three. */
	it('accepts an approval kind on every guarded table only once 0009 is applied', async () => {
		const database = await migrator();
		const before = databaseMigrations.filter(
			(migration) => migration.id < '0009_notifications_kind_approvals',
		);
		await runDatabaseMigrations(database, 'notifications.core', before);
		const attempt = async (text: string): Promise<'accepted' | 'refused'> => {
			try {
				await database.transaction(
					(transaction) => transaction.execute({ text }),
					{ access: 'write', tenantId: 'tenant-a' },
				);
				return 'accepted';
			} catch {
				return 'refused';
			}
		};

		for (const [table, statement] of Object.entries(APPROVAL_KIND_WRITES)) {
			expect([table, await attempt(statement)]).toEqual([table, 'refused']);
		}

		await migrateNotificationsDatabase(database);

		for (const [table, statement] of Object.entries(APPROVAL_KIND_WRITES)) {
			expect([table, await attempt(statement)]).toEqual([table, 'accepted']);
		}
	});

	/* The kind list is a database rule, not only a service one, so the metering
	   kind has to be refused on every table the check guards until 0010 has
	   replaced all three. */
	it('accepts the meter threshold kind on every guarded table only once 0010 is applied', async () => {
		const database = await migrator();
		const before = databaseMigrations.filter(
			(migration) => migration.id < '0010_notifications_kind_meter_threshold',
		);
		await runDatabaseMigrations(database, 'notifications.core', before);
		const attempt = async (text: string): Promise<'accepted' | 'refused'> => {
			try {
				await database.transaction(
					(transaction) => transaction.execute({ text }),
					{ access: 'write', tenantId: 'tenant-a' },
				);
				return 'accepted';
			} catch {
				return 'refused';
			}
		};

		for (const [table, statement] of Object.entries(
			METER_THRESHOLD_KIND_WRITES,
		)) {
			expect([table, await attempt(statement)]).toEqual([table, 'refused']);
		}

		await migrateNotificationsDatabase(database);

		for (const [table, statement] of Object.entries(
			METER_THRESHOLD_KIND_WRITES,
		)) {
			expect([table, await attempt(statement)]).toEqual([table, 'accepted']);
		}
	});

	it('adopts a schema that already carries the objects instead of reapplying them', async () => {
		const database = await migrator();
		await migrateNotificationsDatabase(database);
		await database.transaction(
			(transaction) =>
				transaction.execute({
					text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = $1`,
					parameters: ['notifications.core'],
				}),
			{ access: 'write' },
		);

		const status = await databaseMigrationStatus(
			database,
			'notifications.core',
			databaseMigrations,
		);
		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'adopted'),
		);

		const adopted = await runDatabaseMigrations(
			database,
			'notifications.core',
			databaseMigrations,
		);
		expect(adopted.every((result) => result.action === 'adopted')).toBe(true);
	});

	it('reports a pending schema before anything is applied', async () => {
		const database = await migrator();
		const status = await databaseMigrationStatus(
			database,
			'notifications.core',
			databaseMigrations,
		);
		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'pending'),
		);
	});
});
