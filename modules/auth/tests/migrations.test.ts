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

const MODULE_TABLES = [
	'auth_membership_scopes',
	'auth_memberships',
	'auth_sessions',
	'auth_api_tokens',
	'auth_roles',
	'auth_audit',
	'auth_sign_in_failures',
	'auth_password_reset_tokens',
	'auth_tenant_invitations',
	'auth_mfa_totp',
	'auth_mfa_recovery_codes',
	'auth_mfa_challenges',
	'module_settings',
	'auth_accounts',
	'auth_tenants',
].join(', ');

/* Every table that carries a workspace boundary, and the policy that binds it.
   auth_tenants is a workspace itself, so its policy binds the primary key. */
const TENANT_TABLES: Readonly<Record<string, string>> = {
	auth_tenants: 'auth_tenants_tenant_policy',
	auth_memberships: 'auth_memberships_tenant_policy',
	auth_membership_scopes: 'auth_membership_scopes_tenant_policy',
	auth_sessions: 'auth_sessions_tenant_policy',
	auth_api_tokens: 'auth_api_tokens_tenant_policy',
	module_settings: 'module_settings_tenant_policy',
	auth_roles: 'auth_roles_tenant_policy',
	auth_audit: 'auth_audit_tenant_policy',
	auth_tenant_invitations: 'auth_tenant_invitations_tenant_policy',
	auth_mfa_challenges: 'auth_mfa_challenges_tenant_policy',
};

let provider: DatabaseProvider;
let lease: DatabaseAdapterLease;

beforeAll(async () => {
	provider = createTestDatabaseProvider();
	lease = await provider.acquire({
		namespace: 'auth.core',
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
			text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = 'auth.core'`,
		});
	}
});

afterAll(async () => {
	await lease?.release();
	await provider?.dispose();
});

function apply() {
	return runDatabaseMigrations(lease.database, 'auth.core', databaseMigrations);
}

function status() {
	return databaseMigrationStatus(
		lease.database,
		'auth.core',
		databaseMigrations,
	);
}

describe('auth migrations', () => {
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

	it('declares forced row security and a tenant policy for every table that carries a workspace', () => {
		const script = databaseMigrations
			.map((migration) => migration.sql.postgresql ?? '')
			.join('\n');

		for (const [table, policy] of Object.entries(TENANT_TABLES)) {
			expect(script).toContain(
				`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
			);
			expect(script).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
			expect(script).toContain(`CREATE POLICY ${policy} ON ${table}`);
		}
		expect(script).toContain("current_setting('coreloom.tenant_id', true)");
		expect(script).toContain('WITH CHECK');
	});

	it('applies every migration on a fresh database', async () => {
		expect((await apply()).map((entry) => entry.action)).toEqual(
			databaseMigrations.map(() => 'applied'),
		);
		expect((await status()).map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'applied'),
		);
	});

	it('enables and forces row security on every workspace table it creates', async () => {
		await apply();

		const security = await lease.database.query<{
			relname: string;
			relrowsecurity: boolean;
			relforcerowsecurity: boolean;
			policies: number | string;
		}>({
			text: `SELECT relation.relname, relation.relrowsecurity,
			              relation.relforcerowsecurity,
			              (SELECT count(*) FROM pg_policy
			                 WHERE polrelid = relation.oid) AS policies
			       FROM pg_class AS relation
			       JOIN pg_namespace AS namespace
			         ON namespace.oid = relation.relnamespace
			       WHERE namespace.nspname = current_schema()
			         AND relation.relname = ANY($1::text[])`,
			parameters: [`{${Object.keys(TENANT_TABLES).join(',')}}`],
		});

		expect(security.rows).toHaveLength(Object.keys(TENANT_TABLES).length);
		for (const row of security.rows) {
			expect({
				table: row.relname,
				enabled: row.relrowsecurity,
				forced: row.relforcerowsecurity,
			}).toEqual({ table: row.relname, enabled: true, forced: true });
			expect(Number(row.policies)).toBeGreaterThan(0);
		}
	});

	it('adopts a schema that predates the ledger without changing its rows', async () => {
		await apply();
		await lease.database.transaction(
			(transaction) =>
				transaction.execute({
					text: `INSERT INTO auth_tenants (id, name, slug, created_at)
			       VALUES ('tenant-a', 'Contoso', 'tenant-a', 1)`,
				}),
			{ tenantId: 'tenant-a', access: 'write' },
		);
		await lease.database.execute({
			text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = 'auth.core'`,
		});

		/* The scope backfills carry no schema, so adoption cannot prove them and
		   the runner replays them. They read through forced row security and
		   reach nothing, which is what makes the replay safe. */
		const adopted = new Set(
			databaseMigrations
				.filter((migration) => migration.inspectExisting)
				.map((migration) => migration.id),
		);
		expect((await status()).map((entry) => entry.state)).toEqual(
			databaseMigrations.map((migration) =>
				adopted.has(migration.id) ? 'adopted' : 'pending',
			),
		);
		expect((await apply()).map((entry) => entry.action)).toEqual(
			databaseMigrations.map((migration) =>
				adopted.has(migration.id) ? 'adopted' : 'applied',
			),
		);
		expect(
			(
				await lease.database.transaction(
					(transaction) =>
						transaction.query<{ name: string }>({
							text: 'SELECT name FROM auth_tenants',
						}),
					{ tenantId: 'tenant-a', access: 'read' },
				)
			).rows,
		).toEqual([{ name: 'Contoso' }]);
	});

	it('runs clean on a second migration pass', async () => {
		await apply();

		expect((await apply()).map((entry) => entry.action)).toEqual(
			databaseMigrations.map(() => 'unchanged'),
		);
	});
});
