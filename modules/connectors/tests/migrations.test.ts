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
import { migrateConnectorsDatabase } from '../src/services/database-repository.ts';
import { databaseMigrations } from '../src/services/migration.ts';
import { CONNECTORS_TENANT_TABLES } from './support/database.ts';

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
		namespace: 'connectors.core',
		purpose: 'migration',
	});
	return lease.database;
}

interface RelationSecurity {
	readonly relrowsecurity: boolean;
	readonly relforcerowsecurity: boolean;
	readonly policies: number | bigint | string;
}

describe('connectors migrations', () => {
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
			'connectors.core',
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
					parameters: ['connectors.core'],
				}),
			{ access: 'read' },
		);
		expect(ledger.rows.map((row) => row.id)).toEqual(
			databaseMigrations.map((migration) => migration.id),
		);

		const second = await runDatabaseMigrations(
			database,
			'connectors.core',
			databaseMigrations,
		);
		expect(second.every((result) => result.action === 'unchanged')).toBe(true);
	});

	it('forces row level security with a tenant policy on every tenant table', async () => {
		const database = await migrator();
		await migrateConnectorsDatabase(database);
		for (const table of CONNECTORS_TENANT_TABLES) {
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
			expect([table, security.rows[0]]).toEqual([
				table,
				expect.objectContaining({
					relrowsecurity: true,
					relforcerowsecurity: true,
				}),
			]);
			expect([table, Number(security.rows[0]?.policies)]).toEqual([table, 1]);
		}
	});

	it('refuses a second instance with the same normalized name in one tenant', async () => {
		const database = await migrator();
		await migrateConnectorsDatabase(database);
		const insert = (id: string, name: string) =>
			database.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO connectors_instances
						 (id, tenant_id, definition_key, name, name_normalized, base_url,
						  auth_kind, allowed_hosts_json, allow_workflows, allow_agents,
						  status, created_at, updated_at)
						 VALUES ($1, 'tenant-a', 'http-json', $2, $3,
						         'https://api.example.test', 'none', '[]', 0, 0,
						         'active', 1, 1)`,
						parameters: [id, name, name.toLowerCase()],
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			);
		await insert('instance-1', 'Billing');
		await expect(insert('instance-2', 'billing')).rejects.toThrow();
	});

	it('refuses a consent flag and a status the domain does not know', async () => {
		const database = await migrator();
		await migrateConnectorsDatabase(database);
		const insert = (status: string, allowAgents: number) =>
			database.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO connectors_instances
						 (id, tenant_id, definition_key, name, name_normalized, base_url,
						  auth_kind, allowed_hosts_json, allow_workflows, allow_agents,
						  status, created_at, updated_at)
						 VALUES ('instance-x', 'tenant-a', 'http-json', 'X', 'x',
						         'https://api.example.test', 'none', '[]', 0, $2, $1, 1, 1)`,
						parameters: [status, allowAgents],
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			);
		await expect(insert('retired', 0)).rejects.toThrow();
		await expect(insert('active', 2)).rejects.toThrow();
	});

	it('adopts a schema that already carries the objects instead of reapplying them', async () => {
		const database = await migrator();
		await migrateConnectorsDatabase(database);
		await database.transaction(
			(transaction) =>
				transaction.execute({
					text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = $1`,
					parameters: ['connectors.core'],
				}),
			{ access: 'write' },
		);

		const status = await databaseMigrationStatus(
			database,
			'connectors.core',
			databaseMigrations,
		);
		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'adopted'),
		);
		const adopted = await runDatabaseMigrations(
			database,
			'connectors.core',
			databaseMigrations,
		);
		expect(adopted.every((result) => result.action === 'adopted')).toBe(true);
	});

	it('reports a pending schema before anything is applied', async () => {
		const database = await migrator();
		const status = await databaseMigrationStatus(
			database,
			'connectors.core',
			databaseMigrations,
		);
		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'pending'),
		);
	});
});
