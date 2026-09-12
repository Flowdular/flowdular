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
	'auth_external_identities',
	'auth_identity_providers',
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
	auth_identity_providers: 'auth_identity_providers_tenant_policy',
	/* A binding carries a workspace when a tenant-owned provider made it, and
	   none when a platform provider did; the policy admits both. */
	auth_external_identities: 'auth_external_identities_tenant_policy',
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

	/* Memberships created while the parties and catalog modules shipped still
	   carry their scopes, and a built-in role row carrying one would grant it
	   again at the next assignment. */
	it('retires the bundled module scopes a seeded database still grants', async () => {
		const retired = databaseMigrations.findIndex(
			(migration) => migration.id === '0018_retire_bundled_module_scopes',
		);
		expect(retired).toBeGreaterThan(0);
		await runDatabaseMigrations(
			lease.database,
			'auth.core',
			databaseMigrations.slice(0, retired),
		);
		await lease.database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: `INSERT INTO auth_tenants (id, name, slug, created_at)
					       VALUES ('tenant-a', 'Contoso', 'tenant-a', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_accounts
					       (id, email, email_normalized, password_hash, display_name, status, created_at)
					       VALUES ('account-a', 'ada@example.com', 'ada@example.com', 'hash', 'Ada', 'active', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_memberships (account_id, tenant_id, role, created_at)
					       VALUES ('account-a', 'tenant-a', 'owner', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
					       VALUES ('account-a', 'tenant-a', 'users.members.read'),
					              ('account-a', 'tenant-a', 'parties.records.read'),
					              ('account-a', 'tenant-a', 'parties.records.manage'),
					              ('account-a', 'tenant-a', 'catalog.items.read'),
					              ('account-a', 'tenant-a', 'catalog.items.manage')`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_roles
					       (id, tenant_id, key, name, description, scopes_json, builtin, created_at, updated_at)
					       VALUES ('tenant-a:owner', 'tenant-a', 'owner', 'Owner', 'Full access',
					               '["auth.profile.read","parties.records.read","catalog.items.manage","users.members.read"]',
					               1, 1, 1)`,
				});
			},
			{ tenantId: 'tenant-a', access: 'write' },
		);

		expect((await apply()).map((entry) => entry.action)).toEqual(
			databaseMigrations.map((_, index) =>
				index < retired ? 'unchanged' : 'applied',
			),
		);

		const remaining = await lease.database.transaction(
			async (transaction) => ({
				scopes: (
					await transaction.query<{ scope: string }>({
						text: `SELECT scope FROM auth_membership_scopes
						       WHERE scope LIKE 'parties.%' OR scope LIKE 'catalog.%'
						          OR scope = 'users.members.read'
						       ORDER BY scope`,
					})
				).rows,
				roles: (
					await transaction.query<{ scopes_json: string }>({
						text: 'SELECT scopes_json FROM auth_roles',
					})
				).rows,
			}),
			{ tenantId: 'tenant-a', access: 'read' },
		);

		/* The whole ledger runs here, so the later backfills grant this owner their
		   own scopes too; each is asserted by its own case. What this one proves is
		   that no retired scope survives and the grant that still ships is kept. */
		expect(remaining.scopes).toEqual([{ scope: 'users.members.read' }]);
		const ownerRole = JSON.parse(remaining.roles[0]!.scopes_json) as string[];
		expect(
			ownerRole.filter(
				(scope) => scope.startsWith('parties.') || scope.startsWith('catalog.'),
			),
		).toEqual([]);
		expect(ownerRole.slice(0, 2)).toEqual([
			'auth.profile.read',
			'users.members.read',
		]);
	});

	/* notifications.core member defaults reach a workspace that already exists
	   through nothing else: auth sync-scopes grants owners only, and the built-in
	   role row is seeded once, when the workspace is created. */
	it('grants the notifications member scopes to memberships and to the member role row', async () => {
		const granted = databaseMigrations.findIndex(
			(migration) => migration.id === '0019_notifications_member_scopes',
		);
		expect(granted).toBeGreaterThan(0);
		await runDatabaseMigrations(
			lease.database,
			'auth.core',
			databaseMigrations.slice(0, granted),
		);
		await lease.database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: `INSERT INTO auth_tenants (id, name, slug, created_at)
					       VALUES ('tenant-a', 'Contoso', 'tenant-a', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_accounts
					       (id, email, email_normalized, password_hash, display_name, status, created_at)
					       VALUES ('account-ada', 'ada@example.com', 'ada@example.com', 'hash', 'Ada', 'active', 1),
					              ('account-bo', 'bo@example.com', 'bo@example.com', 'hash', 'Bo', 'active', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_memberships (account_id, tenant_id, role, created_at)
					       VALUES ('account-ada', 'tenant-a', 'owner', 1),
					              ('account-bo', 'tenant-a', 'member', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
					       VALUES ('account-ada', 'tenant-a', 'users.members.manage'),
					              ('account-bo', 'tenant-a', 'users.members.read'),
					              ('account-bo', 'tenant-a', 'notifications.inbox.read')`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_roles
					       (id, tenant_id, key, name, description, scopes_json, builtin, created_at, updated_at)
					       VALUES ('tenant-a:member', 'tenant-a', 'member', 'Member', 'Standard access',
					               '["auth.profile.read","notifications.inbox.read"]', 1, 1, 1),
					              ('tenant-a:owner', 'tenant-a', 'owner', 'Owner', 'Full access',
					               '["auth.profile.read"]', 1, 1, 1)`,
				});
			},
			{ tenantId: 'tenant-a', access: 'write' },
		);

		await apply();

		const seeded = await lease.database.transaction(
			async (transaction) => ({
				scopes: (
					await transaction.query<{ account_id: string; scope: string }>({
						text: `SELECT account_id, scope FROM auth_membership_scopes
						       WHERE scope LIKE 'notifications.%'
						       ORDER BY account_id, scope`,
					})
				).rows,
				roles: (
					await transaction.query<{ key: string; scopes_json: string }>({
						text: 'SELECT key, scopes_json FROM auth_roles ORDER BY key',
					})
				).rows,
			}),
			{ tenantId: 'tenant-a', access: 'read' },
		);

		/* The member gets the three, without a duplicate of the one already held;
		   the owner path is auth sync-scopes and this migration leaves it alone. */
		expect(seeded.scopes).toEqual([
			{ account_id: 'account-bo', scope: 'notifications.inbox.manage' },
			{ account_id: 'account-bo', scope: 'notifications.inbox.read' },
			{ account_id: 'account-bo', scope: 'notifications.webhooks.read' },
		]);
		const roles = new Map(
			seeded.roles.map((row) => [
				row.key,
				JSON.parse(row.scopes_json) as string[],
			]),
		);
		expect(roles.get('member')?.slice(0, 4)).toEqual([
			'auth.profile.read',
			'notifications.inbox.read',
			'notifications.inbox.manage',
			'notifications.webhooks.read',
		]);
		/* The notifications grant leaves the owner row alone; the later backfills
		   run in the same pass and append only what their own cases assert. */
		expect(
			roles.get('owner')?.filter((scope) => scope.startsWith('notifications.')),
		).toEqual([]);
	});

	/* auth.core is not a module a deployment enables, so auth sync-scopes never
	   runs for it and a workspace created before the identity providers screen
	   existed would have no owner able to open it. */
	it('grants the identity provider scopes to owner memberships and to the owner role row', async () => {
		const granted = databaseMigrations.findIndex(
			(migration) => migration.id === '0022_auth_provider_scopes',
		);
		expect(granted).toBeGreaterThan(0);
		await runDatabaseMigrations(
			lease.database,
			'auth.core',
			databaseMigrations.slice(0, granted),
		);
		await lease.database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: `INSERT INTO auth_tenants (id, name, slug, created_at)
					       VALUES ('tenant-a', 'Contoso', 'tenant-a', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_accounts
					       (id, email, email_normalized, password_hash, display_name, status, created_at)
					       VALUES ('account-ada', 'ada@example.com', 'ada@example.com', 'hash', 'Ada', 'active', 1),
					              ('account-bo', 'bo@example.com', 'bo@example.com', 'hash', 'Bo', 'active', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_memberships (account_id, tenant_id, role, created_at)
					       VALUES ('account-ada', 'tenant-a', 'owner', 1),
					              ('account-bo', 'tenant-a', 'member', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
					       VALUES ('account-ada', 'tenant-a', 'users.members.manage'),
					              ('account-ada', 'tenant-a', 'auth.providers.read'),
					              ('account-bo', 'tenant-a', 'users.members.read')`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_roles
					       (id, tenant_id, key, name, description, scopes_json, builtin, created_at, updated_at)
					       VALUES ('tenant-a:owner', 'tenant-a', 'owner', 'Owner', 'Full access',
					               '["auth.profile.read","auth.providers.read"]', 1, 1, 1),
					              ('tenant-a:member', 'tenant-a', 'member', 'Member', 'Standard access',
					               '["auth.profile.read"]', 1, 1, 1),
					              ('tenant-a:auditor', 'tenant-a', 'auditor', 'Auditor', 'Custom',
					               '["auth.audit.read"]', 0, 1, 1)`,
				});
			},
			{ tenantId: 'tenant-a', access: 'write' },
		);

		await apply();

		const seeded = await lease.database.transaction(
			async (transaction) => ({
				scopes: (
					await transaction.query<{ account_id: string; scope: string }>({
						text: `SELECT account_id, scope FROM auth_membership_scopes
						       WHERE scope LIKE 'auth.providers.%'
						       ORDER BY account_id, scope`,
					})
				).rows,
				roles: (
					await transaction.query<{ key: string; scopes_json: string }>({
						text: 'SELECT key, scopes_json FROM auth_roles ORDER BY key',
					})
				).rows,
			}),
			{ tenantId: 'tenant-a', access: 'read' },
		);

		/* The owner gets both, without a duplicate of the one already held; the
		   member keeps none, because neither scope is a member default. */
		expect(seeded.scopes).toEqual([
			{ account_id: 'account-ada', scope: 'auth.providers.manage' },
			{ account_id: 'account-ada', scope: 'auth.providers.read' },
		]);
		const roles = new Map(
			seeded.roles.map((row) => [
				row.key,
				JSON.parse(row.scopes_json) as string[],
			]),
		);
		expect(roles.get('owner')?.slice(0, 3)).toEqual([
			'auth.profile.read',
			'auth.providers.read',
			'auth.providers.manage',
		]);
		expect(roles.get('member')?.slice(0, 1)).toEqual(['auth.profile.read']);
		expect(roles.get('auditor')).toEqual(['auth.audit.read']);
	});

	/* The enterprise modules split their defaults: some scopes are owner-only and
	   four are member defaults too, and neither reaches a workspace that already
	   exists. A workspace that never enabled one of these modules never ran auth
	   sync-scopes for it either, so the owner path is missing as well. */
	it('grants the enterprise module scopes to owner and member memberships by their defaults', async () => {
		const granted = databaseMigrations.findIndex(
			(migration) => migration.id === '0023_enterprise_module_scopes',
		);
		expect(granted).toBeGreaterThan(0);
		await runDatabaseMigrations(
			lease.database,
			'auth.core',
			databaseMigrations.slice(0, granted),
		);
		await lease.database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: `INSERT INTO auth_tenants (id, name, slug, created_at)
					       VALUES ('tenant-a', 'Contoso', 'tenant-a', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_accounts
					       (id, email, email_normalized, password_hash, display_name, status, created_at)
					       VALUES ('account-ada', 'ada@example.com', 'ada@example.com', 'hash', 'Ada', 'active', 1),
					              ('account-bo', 'bo@example.com', 'bo@example.com', 'hash', 'Bo', 'active', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_memberships (account_id, tenant_id, role, created_at)
					       VALUES ('account-ada', 'tenant-a', 'owner', 1),
					              ('account-bo', 'tenant-a', 'member', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
					       VALUES ('account-ada', 'tenant-a', 'documents.files.read'),
					              ('account-bo', 'tenant-a', 'users.members.read')`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_roles
					       (id, tenant_id, key, name, description, scopes_json, builtin, created_at, updated_at)
					       VALUES ('tenant-a:owner', 'tenant-a', 'owner', 'Owner', 'Full access',
					               '["auth.profile.read","documents.files.read"]', 1, 1, 1),
					              ('tenant-a:member', 'tenant-a', 'member', 'Member', 'Standard access',
					               '["auth.profile.read"]', 1, 1, 1),
					              ('tenant-a:auditor', 'tenant-a', 'auditor', 'Auditor', 'Custom',
					               '["auth.audit.read"]', 0, 1, 1)`,
				});
			},
			{ tenantId: 'tenant-a', access: 'write' },
		);
		/* The same person is only a member of the second workspace: a membership
		   carries its own role, so the owner defaults must not follow the account. */
		await lease.database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: `INSERT INTO auth_tenants (id, name, slug, created_at)
					       VALUES ('tenant-b', 'Fabrikam', 'tenant-b', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_memberships (account_id, tenant_id, role, created_at)
					       VALUES ('account-ada', 'tenant-b', 'member', 1)`,
				});
			},
			{ tenantId: 'tenant-b', access: 'write' },
		);

		await apply();

		const seeded = await lease.database.transaction(
			async (transaction) => ({
				scopes: (
					await transaction.query<{ account_id: string; scope: string }>({
						text: `SELECT account_id, scope FROM auth_membership_scopes
						       WHERE tenant_id = 'tenant-a'
						         AND scope NOT LIKE 'auth.%' AND scope NOT LIKE 'users.%'
						       ORDER BY account_id, scope`,
					})
				).rows,
				roles: (
					await transaction.query<{ key: string; scopes_json: string }>({
						text: 'SELECT key, scopes_json FROM auth_roles ORDER BY key',
					})
				).rows,
			}),
			{ tenantId: 'tenant-a', access: 'read' },
		);

		/* The owner gets all sixteen, without a duplicate of the one already held;
		   the member gets the four member defaults of 0023 and the two approval
		   member defaults 0024 adds in the same pass. */
		expect(seeded.scopes).toEqual([
			/* 0024, 0025, 0027 and 0029 run in the same pass and grant their scopes too, and 0031 repeats every backfill since 0019 with the memberships readable, so the owner ends with every owner default and the member with every member default declared by those migrations. */
			{ account_id: 'account-ada', scope: 'access.review.manage' },
			{ account_id: 'account-ada', scope: 'access.review.read' },
			{ account_id: 'account-ada', scope: 'approvals.requests.decide' },
			{ account_id: 'account-ada', scope: 'approvals.requests.manage' },
			{ account_id: 'account-ada', scope: 'approvals.requests.read' },
			{ account_id: 'account-ada', scope: 'audit.holds.manage' },
			{ account_id: 'account-ada', scope: 'audit.registry.read' },
			{ account_id: 'account-ada', scope: 'audit.retention.manage' },
			{ account_id: 'account-ada', scope: 'automations.schedules.manage' },
			{ account_id: 'account-ada', scope: 'automations.schedules.read' },
			{ account_id: 'account-ada', scope: 'automations.triggers.manage' },
			{ account_id: 'account-ada', scope: 'automations.triggers.read' },
			{ account_id: 'account-ada', scope: 'connectors.instances.manage' },
			{ account_id: 'account-ada', scope: 'connectors.instances.read' },
			{ account_id: 'account-ada', scope: 'directory.provisioning.read' },
			{ account_id: 'account-ada', scope: 'directory.tokens.manage' },
			{ account_id: 'account-ada', scope: 'directory.tokens.read' },
			{ account_id: 'account-ada', scope: 'documents.files.manage' },
			{ account_id: 'account-ada', scope: 'documents.files.read' },
			{ account_id: 'account-ada', scope: 'exports.lists.manage' },
			{ account_id: 'account-ada', scope: 'exports.lists.read' },
			{ account_id: 'account-ada', scope: 'import.jobs.manage' },
			{ account_id: 'account-ada', scope: 'import.jobs.read' },
			{ account_id: 'account-ada', scope: 'metering.usage.read' },
			{ account_id: 'account-ada', scope: 'profile.self.manage' },
			{ account_id: 'account-ada', scope: 'reports.workspace.read' },
			{ account_id: 'account-ada', scope: 'search.records.read' },
			{ account_id: 'account-ada', scope: 'workflows.definitions.manage' },
			{ account_id: 'account-ada', scope: 'workflows.definitions.publish' },
			{ account_id: 'account-ada', scope: 'workflows.definitions.read' },
			{ account_id: 'account-ada', scope: 'workflows.runs.cancel' },
			{ account_id: 'account-ada', scope: 'workflows.runs.execute' },
			{ account_id: 'account-ada', scope: 'workflows.runs.read' },
			{ account_id: 'account-bo', scope: 'approvals.requests.decide' },
			{ account_id: 'account-bo', scope: 'approvals.requests.read' },
			{ account_id: 'account-bo', scope: 'connectors.instances.read' },
			{ account_id: 'account-bo', scope: 'documents.files.manage' },
			{ account_id: 'account-bo', scope: 'documents.files.read' },
			{ account_id: 'account-bo', scope: 'notifications.inbox.manage' },
			{ account_id: 'account-bo', scope: 'notifications.inbox.read' },
			{ account_id: 'account-bo', scope: 'notifications.webhooks.read' },
			{ account_id: 'account-bo', scope: 'profile.self.manage' },
			{ account_id: 'account-bo', scope: 'search.records.read' },
		]);
		const roles = new Map(
			seeded.roles.map((row) => [
				row.key,
				JSON.parse(row.scopes_json) as string[],
			]),
		);
		/* The scopes already held keep their order and the missing ones are
		   appended in the order acl/scopes.ts declares them, 0025 and 0027 after
		   0023 because they run later in the same pass. */
		expect(roles.get('owner')).toEqual([
			'auth.profile.read',
			'documents.files.read',
			'directory.tokens.read',
			'directory.tokens.manage',
			'directory.provisioning.read',
			'audit.registry.read',
			'audit.retention.manage',
			'approvals.requests.read',
			'approvals.requests.decide',
			'approvals.requests.manage',
			'documents.files.manage',
			'metering.usage.read',
			'import.jobs.read',
			'import.jobs.manage',
			'search.records.read',
			'connectors.instances.read',
			'connectors.instances.manage',
			'audit.holds.manage',
			'workflows.definitions.read',
			'workflows.definitions.manage',
			'workflows.definitions.publish',
			'workflows.runs.read',
			'workflows.runs.execute',
			'workflows.runs.cancel',
			'automations.schedules.read',
			'automations.schedules.manage',
			'automations.triggers.read',
			'automations.triggers.manage',
			'profile.self.manage',
			'reports.workspace.read',
			'exports.lists.read',
			'exports.lists.manage',
			'access.review.read',
			'access.review.manage',
		]);
		expect(roles.get('member')).toEqual([
			'auth.profile.read',
			'documents.files.read',
			'documents.files.manage',
			'search.records.read',
			'connectors.instances.read',
			'approvals.requests.read',
			'approvals.requests.decide',
			'profile.self.manage',
		]);
		/* A role the workspace wrote itself is not a default and stays as it is. */
		expect(roles.get('auditor')).toEqual(['auth.audit.read']);

		const other = await lease.database.transaction(
			async (transaction) =>
				(
					await transaction.query<{ account_id: string; scope: string }>({
						text: `SELECT account_id, scope FROM auth_membership_scopes
						       WHERE tenant_id = 'tenant-b'
						       ORDER BY account_id, scope`,
					})
				).rows,
			{ tenantId: 'tenant-b', access: 'read' },
		);
		/* Her membership there is a member one, so it receives the member defaults
		   of that pass and none of the owner ones. */
		expect(other).toEqual([
			{ account_id: 'account-ada', scope: 'approvals.requests.decide' },
			{ account_id: 'account-ada', scope: 'approvals.requests.read' },
			{ account_id: 'account-ada', scope: 'connectors.instances.read' },
			{ account_id: 'account-ada', scope: 'documents.files.manage' },
			{ account_id: 'account-ada', scope: 'documents.files.read' },
			/* 0031 repeats the 0019 member grant with the memberships readable. */
			{ account_id: 'account-ada', scope: 'notifications.inbox.manage' },
			{ account_id: 'account-ada', scope: 'notifications.inbox.read' },
			{ account_id: 'account-ada', scope: 'notifications.webhooks.read' },
			{ account_id: 'account-ada', scope: 'profile.self.manage' },
			{ account_id: 'account-ada', scope: 'search.records.read' },
		]);
	});

	/* A member is a decider now, so the member defaults carry the read and the
	   decide scope. 0023 gave the approval scopes to owners alone, so only the
	   member path is missing from a workspace that already exists. */
	it('grants the approval member scopes to member memberships without touching what owners hold', async () => {
		const granted = databaseMigrations.findIndex(
			(migration) => migration.id === '0024_approvals_member_scopes',
		);
		expect(granted).toBeGreaterThan(0);
		await runDatabaseMigrations(
			lease.database,
			'auth.core',
			databaseMigrations.slice(0, granted),
		);
		await lease.database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: `INSERT INTO auth_tenants (id, name, slug, created_at)
					       VALUES ('tenant-a', 'Contoso', 'tenant-a', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_accounts
					       (id, email, email_normalized, password_hash, display_name, status, created_at)
					       VALUES ('account-ada', 'ada@example.com', 'ada@example.com', 'hash', 'Ada', 'active', 1),
					              ('account-bo', 'bo@example.com', 'bo@example.com', 'hash', 'Bo', 'active', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_memberships (account_id, tenant_id, role, created_at)
					       VALUES ('account-ada', 'tenant-a', 'owner', 1),
					              ('account-bo', 'tenant-a', 'member', 1)`,
				});
				/* The owner holds all three from 0023; the member holds the read scope
				   already, so the migration has to add the decide scope alone to it. */
				await transaction.execute({
					text: `INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
					       VALUES ('account-ada', 'tenant-a', 'approvals.requests.read'),
					              ('account-ada', 'tenant-a', 'approvals.requests.decide'),
					              ('account-ada', 'tenant-a', 'approvals.requests.manage'),
					              ('account-bo', 'tenant-a', 'documents.files.read'),
					              ('account-bo', 'tenant-a', 'approvals.requests.read')`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_roles
					       (id, tenant_id, key, name, description, scopes_json, builtin, created_at, updated_at)
					       VALUES ('tenant-a:owner', 'tenant-a', 'owner', 'Owner', 'Full access',
					               '["auth.profile.read","approvals.requests.read","approvals.requests.decide","approvals.requests.manage"]', 1, 1, 1),
					              ('tenant-a:member', 'tenant-a', 'member', 'Member', 'Standard access',
					               '["auth.profile.read","documents.files.read"]', 1, 1, 1),
					              ('tenant-a:auditor', 'tenant-a', 'auditor', 'Auditor', 'Custom',
					               '["approvals.requests.read"]', 0, 1, 1)`,
				});
			},
			{ tenantId: 'tenant-a', access: 'write' },
		);

		await apply();

		const seeded = await lease.database.transaction(
			async (transaction) => ({
				scopes: (
					await transaction.query<{ account_id: string; scope: string }>({
						text: `SELECT account_id, scope FROM auth_membership_scopes
						       WHERE tenant_id = 'tenant-a'
						       ORDER BY account_id, scope`,
					})
				).rows,
				roles: (
					await transaction.query<{ key: string; scopes_json: string }>({
						text: 'SELECT key, scopes_json FROM auth_roles ORDER BY key',
					})
				).rows,
			}),
			{ tenantId: 'tenant-a', access: 'read' },
		);

		/* The member gains the decide scope and nothing else, without a duplicate
		   of the read scope it already held; the owner keeps exactly its three. */
		expect(seeded.scopes).toEqual([
			/* 0025, 0027 and 0029 run in the same pass and grant their scopes too, and 0031 repeats every backfill since 0019 with the memberships readable, so both memberships end with every default declared by those migrations. */
			{ account_id: 'account-ada', scope: 'access.review.manage' },
			{ account_id: 'account-ada', scope: 'access.review.read' },
			{ account_id: 'account-ada', scope: 'approvals.requests.decide' },
			{ account_id: 'account-ada', scope: 'approvals.requests.manage' },
			{ account_id: 'account-ada', scope: 'approvals.requests.read' },
			{ account_id: 'account-ada', scope: 'audit.holds.manage' },
			{ account_id: 'account-ada', scope: 'audit.registry.read' },
			{ account_id: 'account-ada', scope: 'audit.retention.manage' },
			{ account_id: 'account-ada', scope: 'auth.providers.manage' },
			{ account_id: 'account-ada', scope: 'auth.providers.read' },
			{ account_id: 'account-ada', scope: 'automations.schedules.manage' },
			{ account_id: 'account-ada', scope: 'automations.schedules.read' },
			{ account_id: 'account-ada', scope: 'automations.triggers.manage' },
			{ account_id: 'account-ada', scope: 'automations.triggers.read' },
			{ account_id: 'account-ada', scope: 'connectors.instances.manage' },
			{ account_id: 'account-ada', scope: 'connectors.instances.read' },
			{ account_id: 'account-ada', scope: 'directory.provisioning.read' },
			{ account_id: 'account-ada', scope: 'directory.tokens.manage' },
			{ account_id: 'account-ada', scope: 'directory.tokens.read' },
			{ account_id: 'account-ada', scope: 'documents.files.manage' },
			{ account_id: 'account-ada', scope: 'documents.files.read' },
			{ account_id: 'account-ada', scope: 'exports.lists.manage' },
			{ account_id: 'account-ada', scope: 'exports.lists.read' },
			{ account_id: 'account-ada', scope: 'import.jobs.manage' },
			{ account_id: 'account-ada', scope: 'import.jobs.read' },
			{ account_id: 'account-ada', scope: 'metering.usage.read' },
			{ account_id: 'account-ada', scope: 'profile.self.manage' },
			{ account_id: 'account-ada', scope: 'reports.workspace.read' },
			{ account_id: 'account-ada', scope: 'search.records.read' },
			{ account_id: 'account-ada', scope: 'workflows.definitions.manage' },
			{ account_id: 'account-ada', scope: 'workflows.definitions.publish' },
			{ account_id: 'account-ada', scope: 'workflows.definitions.read' },
			{ account_id: 'account-ada', scope: 'workflows.runs.cancel' },
			{ account_id: 'account-ada', scope: 'workflows.runs.execute' },
			{ account_id: 'account-ada', scope: 'workflows.runs.read' },
			{ account_id: 'account-bo', scope: 'approvals.requests.decide' },
			{ account_id: 'account-bo', scope: 'approvals.requests.read' },
			{ account_id: 'account-bo', scope: 'connectors.instances.read' },
			{ account_id: 'account-bo', scope: 'documents.files.manage' },
			{ account_id: 'account-bo', scope: 'documents.files.read' },
			{ account_id: 'account-bo', scope: 'notifications.inbox.manage' },
			{ account_id: 'account-bo', scope: 'notifications.inbox.read' },
			{ account_id: 'account-bo', scope: 'notifications.webhooks.read' },
			{ account_id: 'account-bo', scope: 'profile.self.manage' },
			{ account_id: 'account-bo', scope: 'search.records.read' },
		]);
		const roles = new Map(
			seeded.roles.map((row) => [
				row.key,
				JSON.parse(row.scopes_json) as string[],
			]),
		);
		expect(roles.get('member')).toEqual([
			'auth.profile.read',
			'documents.files.read',
			'approvals.requests.read',
			'approvals.requests.decide',
			'profile.self.manage',
		]);
		expect(roles.get('owner')).toEqual([
			'auth.profile.read',
			'approvals.requests.read',
			'approvals.requests.decide',
			'approvals.requests.manage',
			'audit.holds.manage',
			'workflows.definitions.read',
			'workflows.definitions.manage',
			'workflows.definitions.publish',
			'workflows.runs.read',
			'workflows.runs.execute',
			'workflows.runs.cancel',
			'automations.schedules.read',
			'automations.schedules.manage',
			'automations.triggers.read',
			'automations.triggers.manage',
			'profile.self.manage',
			'reports.workspace.read',
			'exports.lists.read',
			'exports.lists.manage',
			'access.review.read',
			'access.review.manage',
		]);
		/* A role the workspace wrote itself is not a default and stays as it is. */
		expect(roles.get('auditor')).toEqual(['approvals.requests.read']);
	});

	/* audit.holds.manage was declared after 0023 backfilled the enterprise
	   module scopes, so an existing workspace carries it on neither its owner
	   memberships nor its built-in owner role row, and auth sync-scopes never
	   reaches it either: audit.core was already enabled when the permission
	   appeared. */
	it('grants the audit holds scope to owner memberships and to the owner role row', async () => {
		const granted = databaseMigrations.findIndex(
			(migration) => migration.id === '0025_audit_holds_owner_scope',
		);
		expect(granted).toBeGreaterThan(0);
		await runDatabaseMigrations(
			lease.database,
			'auth.core',
			databaseMigrations.slice(0, granted),
		);
		await lease.database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: `INSERT INTO auth_tenants (id, name, slug, created_at)
					       VALUES ('tenant-a', 'Contoso', 'tenant-a', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_accounts
					       (id, email, email_normalized, password_hash, display_name, status, created_at)
					       VALUES ('account-ada', 'ada@example.com', 'ada@example.com', 'hash', 'Ada', 'active', 1),
					              ('account-bo', 'bo@example.com', 'bo@example.com', 'hash', 'Bo', 'active', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_memberships (account_id, tenant_id, role, created_at)
					       VALUES ('account-ada', 'tenant-a', 'owner', 1),
					              ('account-bo', 'tenant-a', 'member', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
					       VALUES ('account-ada', 'tenant-a', 'audit.registry.read'),
					              ('account-ada', 'tenant-a', 'audit.retention.manage'),
					              ('account-bo', 'tenant-a', 'documents.files.read')`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_roles
					       (id, tenant_id, key, name, description, scopes_json, builtin, created_at, updated_at)
					       VALUES ('tenant-a:owner', 'tenant-a', 'owner', 'Owner', 'Full access',
					               '["auth.profile.read","audit.registry.read","audit.retention.manage"]', 1, 1, 1),
					              ('tenant-a:member', 'tenant-a', 'member', 'Member', 'Standard access',
					               '["auth.profile.read","documents.files.read"]', 1, 1, 1),
					              ('tenant-a:auditor', 'tenant-a', 'auditor', 'Auditor', 'Custom',
					               '["audit.registry.read"]', 0, 1, 1)`,
				});
			},
			{ tenantId: 'tenant-a', access: 'write' },
		);
		/* The same person is a member of the second workspace, and a membership
		   carries its own role, so the owner default must not follow the account. */
		await lease.database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: `INSERT INTO auth_tenants (id, name, slug, created_at)
					       VALUES ('tenant-b', 'Fabrikam', 'tenant-b', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_memberships (account_id, tenant_id, role, created_at)
					       VALUES ('account-ada', 'tenant-b', 'member', 1)`,
				});
			},
			{ tenantId: 'tenant-b', access: 'write' },
		);

		await apply();

		const seeded = await lease.database.transaction(
			async (transaction) => ({
				scopes: (
					await transaction.query<{ account_id: string; scope: string }>({
						text: `SELECT account_id, scope FROM auth_membership_scopes
						       WHERE tenant_id = 'tenant-a' AND scope LIKE 'audit.%'
						       ORDER BY account_id, scope`,
					})
				).rows,
				roles: (
					await transaction.query<{ key: string; scopes_json: string }>({
						text: 'SELECT key, scopes_json FROM auth_roles ORDER BY key',
					})
				).rows,
			}),
			{ tenantId: 'tenant-a', access: 'read' },
		);

		/* The owner gains the hold scope without a duplicate of the two it held;
		   the member gains none, because no audit permission is a member default. */
		expect(seeded.scopes).toEqual([
			{ account_id: 'account-ada', scope: 'audit.holds.manage' },
			{ account_id: 'account-ada', scope: 'audit.registry.read' },
			{ account_id: 'account-ada', scope: 'audit.retention.manage' },
		]);
		const roles = new Map(
			seeded.roles.map((row) => [
				row.key,
				JSON.parse(row.scopes_json) as string[],
			]),
		);
		/* Appended after the scopes the row already held, which keep their order;
		   0027 runs later in the same pass and appends after it. */
		expect(roles.get('owner')?.slice(0, 4)).toEqual([
			'auth.profile.read',
			'audit.registry.read',
			'audit.retention.manage',
			'audit.holds.manage',
		]);
		expect(
			roles.get('member')?.filter((scope) => scope.startsWith('audit.')),
		).toEqual([]);
		/* A role the workspace wrote itself is not a default and stays as it is. */
		expect(roles.get('auditor')).toEqual(['audit.registry.read']);

		const other = await lease.database.transaction(
			async (transaction) =>
				(
					await transaction.query<{ scope: string }>({
						text: `SELECT scope FROM auth_membership_scopes
						       WHERE tenant_id = 'tenant-b' AND scope LIKE 'audit.%'`,
					})
				).rows,
			{ tenantId: 'tenant-b', access: 'read' },
		);
		expect(other).toEqual([]);
	});

	/* workflows.core, automations.core and profile.core were enabled long before
	   their eleven permissions became defaults, so auth sync-scopes never reached
	   an existing workspace with them and the seed lists reach only a workspace
	   created from now on. D-PROFILE-PERMISSIONS puts profile.self.manage with
	   members as well, and the other ten stay with owners. */
	it('grants the eleven to owners and profile.self.manage to members, in both the memberships and the built-in role rows', async () => {
		const granted = databaseMigrations.findIndex(
			(migration) => migration.id === '0027_workflow_automation_profile_scopes',
		);
		expect(granted).toBeGreaterThan(0);
		await runDatabaseMigrations(
			lease.database,
			'auth.core',
			databaseMigrations.slice(0, granted),
		);
		await lease.database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: `INSERT INTO auth_tenants (id, name, slug, created_at)
					       VALUES ('tenant-a', 'Contoso', 'tenant-a', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_accounts
					       (id, email, email_normalized, password_hash, display_name, status, created_at)
					       VALUES ('account-ada', 'ada@example.com', 'ada@example.com', 'hash', 'Ada', 'active', 1),
					              ('account-bo', 'bo@example.com', 'bo@example.com', 'hash', 'Bo', 'active', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_memberships (account_id, tenant_id, role, created_at)
					       VALUES ('account-ada', 'tenant-a', 'owner', 1),
					              ('account-bo', 'tenant-a', 'member', 1)`,
				});
				/* The owner already holds one of the eleven, so the insert has to add
				   the other ten and leave that one alone. */
				await transaction.execute({
					text: `INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
					       VALUES ('account-ada', 'tenant-a', 'workflows.definitions.read'),
					              ('account-bo', 'tenant-a', 'documents.files.read')`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_roles
					       (id, tenant_id, key, name, description, scopes_json, builtin, created_at, updated_at)
					       VALUES ('tenant-a:owner', 'tenant-a', 'owner', 'Owner', 'Full access',
					               '["auth.profile.read","workflows.definitions.read"]', 1, 1, 1),
					              ('tenant-a:member', 'tenant-a', 'member', 'Member', 'Standard access',
					               '["auth.profile.read","documents.files.read"]', 1, 1, 1),
					              ('tenant-a:operator', 'tenant-a', 'operator', 'Operator', 'Custom',
					               '["workflows.runs.read"]', 0, 1, 1)`,
				});
			},
			{ tenantId: 'tenant-a', access: 'write' },
		);
		/* The same person is a member of the second workspace, and a membership
		   carries its own role, so the owner defaults must not follow the account. */
		await lease.database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: `INSERT INTO auth_tenants (id, name, slug, created_at)
					       VALUES ('tenant-b', 'Fabrikam', 'tenant-b', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_memberships (account_id, tenant_id, role, created_at)
					       VALUES ('account-ada', 'tenant-b', 'member', 1)`,
				});
			},
			{ tenantId: 'tenant-b', access: 'write' },
		);

		await apply();

		const declared = `scope LIKE 'workflows.%' OR scope LIKE 'automations.%'
		                  OR scope LIKE 'profile.%'`;
		const seeded = await lease.database.transaction(
			async (transaction) => ({
				scopes: (
					await transaction.query<{ account_id: string; scope: string }>({
						text: `SELECT account_id, scope FROM auth_membership_scopes
						       WHERE tenant_id = 'tenant-a' AND (${declared})
						       ORDER BY account_id, scope`,
					})
				).rows,
				roles: (
					await transaction.query<{ key: string; scopes_json: string }>({
						text: 'SELECT key, scopes_json FROM auth_roles ORDER BY key',
					})
				).rows,
			}),
			{ tenantId: 'tenant-a', access: 'read' },
		);

		/* The owner gains the ten it lacked, without a duplicate of the one it
		   held; the member gains profile.self.manage and nothing else. */
		expect(seeded.scopes).toEqual([
			{ account_id: 'account-ada', scope: 'automations.schedules.manage' },
			{ account_id: 'account-ada', scope: 'automations.schedules.read' },
			{ account_id: 'account-ada', scope: 'automations.triggers.manage' },
			{ account_id: 'account-ada', scope: 'automations.triggers.read' },
			{ account_id: 'account-ada', scope: 'profile.self.manage' },
			{ account_id: 'account-ada', scope: 'workflows.definitions.manage' },
			{ account_id: 'account-ada', scope: 'workflows.definitions.publish' },
			{ account_id: 'account-ada', scope: 'workflows.definitions.read' },
			{ account_id: 'account-ada', scope: 'workflows.runs.cancel' },
			{ account_id: 'account-ada', scope: 'workflows.runs.execute' },
			{ account_id: 'account-ada', scope: 'workflows.runs.read' },
			{ account_id: 'account-bo', scope: 'profile.self.manage' },
		]);
		const roles = new Map(
			seeded.roles.map((row) => [
				row.key,
				JSON.parse(row.scopes_json) as string[],
			]),
		);
		/* The scopes already held keep their order and the ten missing ones are
		   appended in the order acl/scopes.ts declares them, 0029 after them
		   because it runs later in the same pass. */
		expect(roles.get('owner')).toEqual([
			'auth.profile.read',
			'workflows.definitions.read',
			'workflows.definitions.manage',
			'workflows.definitions.publish',
			'workflows.runs.read',
			'workflows.runs.execute',
			'workflows.runs.cancel',
			'automations.schedules.read',
			'automations.schedules.manage',
			'automations.triggers.read',
			'automations.triggers.manage',
			'profile.self.manage',
			'reports.workspace.read',
			'exports.lists.read',
			'exports.lists.manage',
			'access.review.read',
			'access.review.manage',
		]);
		/* The member role row takes the one member default and none of the ten
		   the workflow and automation modules keep with owners. */
		expect(
			roles
				.get('member')
				?.filter(
					(scope) =>
						scope.startsWith('workflows.') ||
						scope.startsWith('automations.') ||
						scope.startsWith('profile.'),
				),
		).toEqual(['profile.self.manage']);
		/* A role the workspace wrote itself is not a default and stays as it is. */
		expect(roles.get('operator')).toEqual(['workflows.runs.read']);

		const other = await lease.database.transaction(
			async (transaction) =>
				(
					await transaction.query<{ scope: string }>({
						text: `SELECT scope FROM auth_membership_scopes
						       WHERE tenant_id = 'tenant-b' AND (${declared})`,
					})
				).rows,
			{ tenantId: 'tenant-b', access: 'read' },
		);
		/* Her membership there is a member one, so none of the ten owner scopes
		   follows the account into it and the one member default does. */
		expect(other).toEqual([{ scope: 'profile.self.manage' }]);
	});

	/* reports.core, exports.core and access.core were enabled before their five
	   permissions became owner defaults, so auth sync-scopes never reached an
	   existing workspace with them and the seed lists reach only a workspace
	   created from now on. D-REPORTS-AUDIENCE, D-OWNERS-ONLY and
	   D-EXPORTS-PERMISSIONS keep all five with owners, so no member default is
	   granted here. */
	it('grants the report, export and access review scopes to owners alone, in both the memberships and the built-in role rows', async () => {
		const granted = databaseMigrations.findIndex(
			(migration) => migration.id === '0029_reports_exports_access_scopes',
		);
		expect(granted).toBeGreaterThan(0);
		await runDatabaseMigrations(
			lease.database,
			'auth.core',
			databaseMigrations.slice(0, granted),
		);
		await lease.database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: `INSERT INTO auth_tenants (id, name, slug, created_at)
					       VALUES ('tenant-a', 'Contoso', 'tenant-a', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_accounts
					       (id, email, email_normalized, password_hash, display_name, status, created_at)
					       VALUES ('account-ada', 'ada@example.com', 'ada@example.com', 'hash', 'Ada', 'active', 1),
					              ('account-bo', 'bo@example.com', 'bo@example.com', 'hash', 'Bo', 'active', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_memberships (account_id, tenant_id, role, created_at)
					       VALUES ('account-ada', 'tenant-a', 'owner', 1),
					              ('account-bo', 'tenant-a', 'member', 1)`,
				});
				/* The owner already holds one of the five, so the insert has to add
				   the other four and leave that one alone. */
				await transaction.execute({
					text: `INSERT INTO auth_membership_scopes (account_id, tenant_id, scope)
					       VALUES ('account-ada', 'tenant-a', 'exports.lists.read'),
					              ('account-bo', 'tenant-a', 'documents.files.read')`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_roles
					       (id, tenant_id, key, name, description, scopes_json, builtin, created_at, updated_at)
					       VALUES ('tenant-a:owner', 'tenant-a', 'owner', 'Owner', 'Full access',
					               '["auth.profile.read","exports.lists.read"]', 1, 1, 1),
					              ('tenant-a:member', 'tenant-a', 'member', 'Member', 'Standard access',
					               '["auth.profile.read","documents.files.read"]', 1, 1, 1),
					              ('tenant-a:reviewer', 'tenant-a', 'reviewer', 'Reviewer', 'Custom',
					               '["access.review.read"]', 0, 1, 1)`,
				});
			},
			{ tenantId: 'tenant-a', access: 'write' },
		);
		/* The same person is a member of the second workspace, and a membership
		   carries its own role, so the owner defaults must not follow the account. */
		await lease.database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: `INSERT INTO auth_tenants (id, name, slug, created_at)
					       VALUES ('tenant-b', 'Fabrikam', 'tenant-b', 1)`,
				});
				await transaction.execute({
					text: `INSERT INTO auth_memberships (account_id, tenant_id, role, created_at)
					       VALUES ('account-ada', 'tenant-b', 'member', 1)`,
				});
			},
			{ tenantId: 'tenant-b', access: 'write' },
		);

		await apply();

		const declared = `scope LIKE 'reports.%' OR scope LIKE 'exports.%'
		                  OR scope LIKE 'access.%'`;
		const seeded = await lease.database.transaction(
			async (transaction) => ({
				scopes: (
					await transaction.query<{ account_id: string; scope: string }>({
						text: `SELECT account_id, scope FROM auth_membership_scopes
						       WHERE tenant_id = 'tenant-a' AND (${declared})
						       ORDER BY account_id, scope`,
					})
				).rows,
				roles: (
					await transaction.query<{ key: string; scopes_json: string }>({
						text: 'SELECT key, scopes_json FROM auth_roles ORDER BY key',
					})
				).rows,
			}),
			{ tenantId: 'tenant-a', access: 'read' },
		);

		/* The owner gains the four it lacked, without a duplicate of the one it
		   held; the member gains none of the five. */
		expect(seeded.scopes).toEqual([
			{ account_id: 'account-ada', scope: 'access.review.manage' },
			{ account_id: 'account-ada', scope: 'access.review.read' },
			{ account_id: 'account-ada', scope: 'exports.lists.manage' },
			{ account_id: 'account-ada', scope: 'exports.lists.read' },
			{ account_id: 'account-ada', scope: 'reports.workspace.read' },
		]);
		const roles = new Map(
			seeded.roles.map((row) => [
				row.key,
				JSON.parse(row.scopes_json) as string[],
			]),
		);
		/* The scopes already held keep their order and the four missing ones are
		   appended in the order acl/scopes.ts declares them. */
		expect(roles.get('owner')).toEqual([
			'auth.profile.read',
			'exports.lists.read',
			'reports.workspace.read',
			'exports.lists.manage',
			'access.review.read',
			'access.review.manage',
		]);
		expect(
			roles
				.get('member')
				?.filter(
					(scope) =>
						scope.startsWith('reports.') ||
						scope.startsWith('exports.') ||
						scope.startsWith('access.'),
				),
		).toEqual([]);
		/* A role the workspace wrote itself is not a default and stays as it is. */
		expect(roles.get('reviewer')).toEqual(['access.review.read']);

		const other = await lease.database.transaction(
			async (transaction) =>
				(
					await transaction.query<{ scope: string }>({
						text: `SELECT scope FROM auth_membership_scopes
						       WHERE tenant_id = 'tenant-b' AND (${declared})`,
					})
				).rows,
			{ tenantId: 'tenant-b', access: 'read' },
		);
		/* Her membership there is a member one, and none of the five is a member
		   default, so it receives nothing. */
		expect(other).toEqual([]);
	});

	/* The paged member read walks (tenant_id, account_id), which the primary key
	   leads with the other way round; without this index every page scans the
	   deployment's memberships after the cursor and filters the workspace out. */
	it('indexes the workspace first for the paged member walk', async () => {
		await apply();

		const indexes = await lease.database.query<{
			indexname: string;
			indexdef: string;
		}>({
			text: `SELECT indexname, indexdef FROM pg_indexes
			       WHERE schemaname = current_schema()
			         AND indexname = 'auth_memberships_tenant_keyset_idx'`,
		});

		expect(indexes.rows).toHaveLength(1);
		expect(indexes.rows[0]?.indexdef).toContain('(tenant_id, account_id)');
	});

	/* The three export walks page by (tenant_id, id); without these the database
	   sorts the workspace again for every page. */
	it('indexes the keyset of every data class export walk', async () => {
		await apply();

		const indexes = await lease.database.query<{ indexname: string }>({
			text: `SELECT indexname FROM pg_indexes
			       WHERE schemaname = current_schema()
			         AND indexname = ANY($1::text[])
			       ORDER BY indexname`,
			parameters: [
				'{auth_api_tokens_tenant_keyset_idx,auth_audit_tenant_keyset_idx,auth_sessions_tenant_keyset_idx}',
			],
		});

		expect(indexes.rows.map((row) => row.indexname)).toEqual([
			'auth_api_tokens_tenant_keyset_idx',
			'auth_audit_tenant_keyset_idx',
			'auth_sessions_tenant_keyset_idx',
		]);
	});

	it('runs clean on a second migration pass', async () => {
		await apply();

		expect((await apply()).map((entry) => entry.action)).toEqual(
			databaseMigrations.map(() => 'unchanged'),
		);
	});
});
