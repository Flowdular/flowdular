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
import { databaseMigrations } from '../src/services/migration.ts';
import { migrateAutomationsDatabase } from '../src/services/database-repository.ts';

const directory = new URL('../migrations/', import.meta.url);

const TENANT_TABLES = [
	'automations_schedules',
	'automations_triggers',
	'automations_audit_events',
] as const;

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
		namespace: 'automations.core',
		purpose: 'migration',
	});
	return lease.database;
}

interface RelationSecurity {
	readonly relrowsecurity: boolean;
	readonly relforcerowsecurity: boolean;
	readonly policies: number | bigint | string;
}

describe('automations migrations', () => {
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
			'automations.core',
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
					parameters: ['automations.core'],
				}),
			{ access: 'read' },
		);
		expect(ledger.rows.map((row) => row.id)).toEqual(
			databaseMigrations.map((migration) => migration.id),
		);

		const second = await runDatabaseMigrations(
			database,
			'automations.core',
			databaseMigrations,
		);
		expect(second.every((result) => result.action === 'unchanged')).toBe(true);
	});

	it('forces row level security with a tenant policy on every tenant table', async () => {
		const database = await migrator();
		await migrateAutomationsDatabase(database);
		for (const table of TENANT_TABLES) {
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

	it('adopts a schema that already carries the tables instead of reapplying them', async () => {
		const database = await migrator();
		await migrateAutomationsDatabase(database);
		await database.transaction(
			(transaction) =>
				transaction.execute({
					text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = $1`,
					parameters: ['automations.core'],
				}),
			{ access: 'write' },
		);

		const status = await databaseMigrationStatus(
			database,
			'automations.core',
			databaseMigrations,
		);
		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'adopted'),
		);

		const adopted = await runDatabaseMigrations(
			database,
			'automations.core',
			databaseMigrations,
		);
		expect(adopted.every((result) => result.action === 'adopted')).toBe(true);
	});

	it('adopts the scheduler and trigger role migrations only with their policy and grant', async () => {
		const database = await migrator();
		await database.transaction(
			async (transaction) => {
				for (const migration of databaseMigrations) {
					await transaction.executeScript(migration.sql.postgresql!);
				}
			},
			{ access: 'write' },
		);
		const status = await databaseMigrationStatus(
			database,
			'automations.core',
			databaseMigrations,
		);
		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'adopted'),
		);
	});

	it('refuses a schema carrying the routing indexes without the background policy or grant', async () => {
		const database = await migrator();
		await migrateAutomationsDatabase(database);
		await database.transaction(
			(transaction) =>
				transaction.executeScript(`
					DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = 'automations.core';
					DROP POLICY automations_schedules_background_policy ON automations_schedules;
					REVOKE SELECT (tenant_id, id, next_run_at, enabled)
					  ON automations_schedules FROM coreloom_background;
					DROP POLICY automations_triggers_background_policy ON automations_triggers;
					REVOKE SELECT (tenant_id, id)
					  ON automations_triggers FROM coreloom_background;
				`),
			{ access: 'write' },
		);

		const status = await databaseMigrationStatus(
			database,
			'automations.core',
			databaseMigrations,
		);
		expect(status.map((entry) => [entry.id, entry.state])).toEqual([
			['0001_automations_core', 'adopted'],
			['0002_automations_targets', 'adopted'],
			['0003_automations_scheduler_role', 'partial'],
			['0004_automations_trigger_routing_role', 'partial'],
			['0005_secret_rotation_inventory', 'adopted'],
		]);
		await expect(
			runDatabaseMigrations(database, 'automations.core', databaseMigrations),
		).rejects.toThrow('0003_automations_scheduler_role');
	});

	it('reports a pending schema before anything is applied', async () => {
		const database = await migrator();
		const status = await databaseMigrationStatus(
			database,
			'automations.core',
			databaseMigrations,
		);
		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'pending'),
		);
	});
});
