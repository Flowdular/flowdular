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

let provider: DatabaseProvider;
let lease: DatabaseAdapterLease;

beforeAll(async () => {
	provider = createTestDatabaseProvider();
	lease = await provider.acquire({
		namespace: 'agents.core',
		purpose: 'migration',
	});
});

/* Every case states its own starting point, so the shared cluster goes back to
   an unmigrated, unrecorded schema first. */
beforeEach(async () => {
	const tables = await lease.database.query<{ tablename: string }>({
		text: `SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`,
	});
	if (tables.rows.length === 0) return;
	await lease.database.execute({
		text: `DROP TABLE ${tables.rows
			.map((row) => `"${row.tablename}"`)
			.join(', ')} CASCADE`,
	});
});

afterAll(async () => {
	await lease?.release();
	await provider?.dispose();
});

function apply() {
	return runDatabaseMigrations(
		lease.database,
		'agents.core',
		databaseMigrations,
	);
}

function status() {
	return databaseMigrationStatus(
		lease.database,
		'agents.core',
		databaseMigrations,
	);
}

/* A table is tenant owned from the moment a migration gives it a tenant_id,
   whether the column arrives with the table or by a later ALTER. Reading the
   CREATE body rather than the whole file keeps the row-security check attached
   to the table it protects. */
function tenantTablesOf(sql: string): readonly string[] {
	const tables: string[] = [];
	for (const [, name, body] of sql.matchAll(
		/CREATE TABLE(?: IF NOT EXISTS)? (\w+) \(([\s\S]*?)\n\);/g,
	)) {
		if (/^\s+tenant_id\s+TEXT\s+NOT NULL/m.test(body!)) tables.push(name!);
	}
	for (const [, name] of sql.matchAll(
		/ALTER TABLE (\w+) ADD COLUMN tenant_id\b/g,
	)) {
		tables.push(name!);
	}
	return tables;
}

function policyFor(sql: string, table: string): string {
	return (
		sql.match(
			new RegExp(`CREATE POLICY \\w+\\s+ON ${table}\\b[\\s\\S]*?;`),
		)?.[0] ?? ''
	);
}

describe('agents migrations', () => {
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

	it('forces tenant row security on every table it creates with a tenant id', () => {
		const covered: string[] = [];
		for (const migration of databaseMigrations) {
			const sql = migration.sql.postgresql ?? '';
			for (const table of tenantTablesOf(sql)) {
				covered.push(table);
				expect(sql).toContain(
					`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
				);
				expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
				const policy = policyFor(sql, table);
				expect(policy).toContain("current_setting('coreloom.tenant_id', true)");
				expect(policy).toContain('WITH CHECK');
			}
		}
		/* Counting the tenant columns independently proves the reader above found
		   every tenant table instead of silently matching none. */
		const declared = databaseMigrations.reduce(
			(total, migration) =>
				total +
				[
					...(migration.sql.postgresql ?? '').matchAll(
						/^\s+tenant_id\s+TEXT\s+NOT NULL|ADD COLUMN tenant_id\b/gm,
					),
				].length,
			0,
		);
		expect(covered).toHaveLength(declared);
		expect(covered.length).toBeGreaterThan(0);
	});

	it('applies every migration on a fresh database', async () => {
		expect((await apply()).map((entry) => entry.action)).toEqual(
			databaseMigrations.map(() => 'applied'),
		);
		expect((await status()).map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'applied'),
		);
	});

	it('reports pending before the first pass', async () => {
		expect((await status()).map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'pending'),
		);
	});

	it('adopts a schema that predates the ledger without changing its rows', async () => {
		await apply();
		await lease.database.transaction(
			(transaction) =>
				transaction.execute({
					text: `INSERT INTO agent_definitions
						 (id, tenant_id, agent_key, name, description, instructions, provider,
						  model, allowed_tools_json, max_steps, timeout_ms, temperature_milli,
						  status, revision, created_by, created_at, updated_by, updated_at)
						 VALUES ('agent-1', 'tenant-a', 'assistant', 'Assistant', 'Test agent',
						  'Help the user', 'local-simulation', 'deterministic-v1', '[]', 4,
						  10000, 0, 'active', 1, 'owner-a', 1, 'owner-a', 1)`,
				}),
			{ access: 'write', tenantId: 'tenant-a' },
		);
		await lease.database.execute({
			text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = 'agents.core'`,
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
						transaction.query<{ name: string }>({
							text: 'SELECT name FROM agent_definitions',
						}),
					{ access: 'read', tenantId: 'tenant-a' },
				)
			).rows,
		).toEqual([{ name: 'Assistant' }]);
	});

	it('runs clean on a second migration pass', async () => {
		await apply();

		expect((await apply()).map((entry) => entry.action)).toEqual(
			databaseMigrations.map(() => 'unchanged'),
		);
	});

	it('refuses adoption when reconciliation policies exist but a routing grant is missing', async () => {
		await apply();
		await lease.database.execute({
			text: 'REVOKE SELECT (agent_id) ON module_agent_bindings FROM coreloom_background',
		});
		await lease.database.execute({
			text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = 'agents.core' AND id = '0021_agents_agent_reconciliation_role'`,
		});
		await expect(apply()).rejects.toMatchObject({ code: 'PARTIAL_MIGRATION' });
	});

	/* The standing refusal table is what keeps one refused meter out of the
	   chained trail on every retry. A pre-ledger schema that does not carry it
	   must not be adopted as if the migration had run, or the refusals would be
	   unbounded again on a deployment that reports itself up to date. */
	it('creates the meter refusal table on a schema that predates it', async () => {
		await apply();
		await lease.database.execute({ text: 'DROP TABLE agent_meter_refusals' });
		await lease.database.execute({
			text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = 'agents.core'`,
		});

		const states = await status();
		expect(states.map((entry) => [entry.id, entry.state])).toContainEqual([
			'0024_agent_meter_refusals',
			'pending',
		]);
		/* Every other migration is adopted, so the probe answers for this table
		   alone rather than for the schema as a whole. */
		expect(
			states
				.filter((entry) => entry.id !== '0024_agent_meter_refusals')
				.every((entry) => entry.state === 'adopted'),
		).toBe(true);

		expect(
			(await apply()).find((entry) => entry.id === '0024_agent_meter_refusals')
				?.action,
		).toBe('applied');
		expect(
			(
				await lease.database.query<{ present: boolean }>({
					text: `SELECT to_regclass('agent_meter_refusals') IS NOT NULL AS present`,
				})
			).rows[0]?.present,
		).toBe(true);
	});

	it('reports a ledger entry that no longer matches its migration', async () => {
		await apply();
		const drifted = databaseMigrations[0]!.id;
		await lease.database.execute({
			text: `UPDATE ${DATABASE_MIGRATION_LEDGER}
			       SET checksum = 'sha256:drifted'
			       WHERE namespace = 'agents.core' AND id = $1`,
			parameters: [drifted],
		});

		const states = await status();
		expect(states[0]).toMatchObject({ id: drifted, state: 'mismatch' });
		expect(states.slice(1).map((entry) => entry.state)).toEqual(
			databaseMigrations.slice(1).map(() => 'applied'),
		);
		await expect(apply()).rejects.toMatchObject({
			code: 'CHECKSUM_MISMATCH',
			migrationId: drifted,
		});
	});
});
