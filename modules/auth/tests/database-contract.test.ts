import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { OWNER_SCOPES } from '../src/acl/scopes.ts';
import {
	closeAuthTestDatabases,
	createAuthTestDatabase,
	type AuthTestDatabase,
} from './support/database.ts';

const open = new Set<AuthTestDatabase>();

afterEach(async () => {
	await Promise.all([...open].map((database) => database.dispose()));
	open.clear();
});

afterAll(closeAuthTestDatabases);

async function fixture(): Promise<AuthTestDatabase> {
	const database = await createAuthTestDatabase();
	open.add(database);
	return database;
}

const ACCOUNT = {
	email: 'Owner@example.com',
	normalizedEmail: 'owner@example.com',
	passwordHash: 'hash',
	displayName: 'Ada Owner',
	role: 'owner',
	scopes: OWNER_SCOPES,
};

async function seedTenant(
	database: AuthTestDatabase,
	tenantId: string,
	accountId: string,
	email: string,
): Promise<void> {
	await database.repository.createAccountWithTenant({
		...ACCOUNT,
		accountId,
		tenantId,
		email,
		normalizedEmail: email.toLowerCase(),
		organizationName: `Workspace ${tenantId}`,
		organizationSlug: tenantId,
		createdAt: 1_000,
	});
}

describe('auth database repository contract', () => {
	it('keeps memberships, scopes and audit rows tenant scoped', async () => {
		const database = await fixture();
		await seedTenant(database, 'tenant-a', 'account-a', 'a@example.com');
		await seedTenant(database, 'tenant-b', 'account-b', 'b@example.com');

		expect(
			(await database.repository.listTenantMembers('tenant-a')).map(
				(member) => member.accountId,
			),
		).toEqual(['account-a']);
		expect(
			(await database.repository.listTenantMembers('tenant-b')).map(
				(member) => member.accountId,
			),
		).toEqual(['account-b']);

		await database.repository.appendAudit({
			tenantId: 'tenant-a',
			actorAccountId: 'account-a',
			actorLabel: 'a@example.com',
			actorKind: 'user',
			actorRunId: null,
			action: 'auth.sign-in.succeeded',
			subjectType: 'account',
			subjectId: 'account-a',
			metadata: {},
			occurredAt: 2_000,
		});

		expect(
			await database.repository.queryAudit({
				tenantId: 'tenant-b',
				limit: 10,
				cursor: null,
				action: null,
				actor: null,
			}),
		).toEqual([]);
		const page = await database.repository.queryAudit({
			tenantId: 'tenant-a',
			limit: 10,
			cursor: null,
			action: null,
			actor: null,
		});
		expect(page).toHaveLength(1);
		/* The identity column comes back as a BIGINT, which the driver hands over
		   as a string; the cursor arithmetic depends on it being a number. */
		expect(typeof page[0]!.id).toBe('number');
		expect(typeof page[0]!.occurredAt).toBe('number');
	});

	it('finds an account and its workspaces across the tenant boundary', async () => {
		const database = await fixture();
		await seedTenant(database, 'tenant-a', 'account-a', 'ada@example.com');
		await database.repository.createTenantMembership({
			accountId: 'account-a',
			tenantId: 'tenant-b',
			organizationName: 'Second',
			organizationSlug: 'second',
			role: 'owner',
			scopes: OWNER_SCOPES,
			createdAt: 1_001,
		});

		const credential =
			await database.repository.findAccountByEmail('ada@example.com');
		expect(credential).toMatchObject({
			accountId: 'account-a',
			tenantId: 'tenant-a',
			role: 'owner',
		});
		expect(credential?.scopes).toEqual([...OWNER_SCOPES].sort());
		expect(
			(await database.repository.listTenantAccess('account-a')).map(
				(access) => access.slug,
			),
		).toEqual(['tenant-a', 'second']);
	});

	it('routes a session token to its workspace and expires it by idle time', async () => {
		const database = await fixture();
		await seedTenant(database, 'tenant-a', 'account-a', 'ada@example.com');
		await database.repository.createSession({
			id: 'session-1',
			tokenHash: 'token-hash-1',
			accountId: 'account-a',
			tenantId: 'tenant-a',
			csrfToken: 'csrf',
			createdAt: 1_000,
			expiresAt: 100_000,
		});

		const live = await database.repository.findSession(
			'token-hash-1',
			2_000,
			60_000,
			1_000,
		);
		expect(live?.principal).toMatchObject({
			accountId: 'account-a',
			tenantId: 'tenant-a',
		});
		expect(live?.expiresAt).toBe(100_000);

		expect(
			await database.repository.findSession('token-hash-1', 90_000, 1_000, 500),
		).toBeNull();
		/* The idle read removes the row, so the token cannot be replayed. */
		expect(
			await database.repository.findSession(
				'token-hash-1',
				90_100,
				60_000,
				500,
			),
		).toBeNull();
	});

	/* Revoking one session names it by an id that carries no workspace, so this
	   is the case that proves the background grant covers that column. */
	it('revokes one session of an account by id, in any of its workspaces', async () => {
		const database = await fixture();
		await seedTenant(database, 'tenant-a', 'account-a', 'ada@example.com');
		await database.repository.createTenantMembership({
			accountId: 'account-a',
			tenantId: 'tenant-b',
			organizationName: 'Second',
			organizationSlug: 'second',
			role: 'owner',
			scopes: OWNER_SCOPES,
			createdAt: 1_001,
		});
		for (const [id, tenantId] of [
			['session-a', 'tenant-a'],
			['session-b', 'tenant-b'],
		] as const) {
			await database.repository.createSession({
				id,
				tokenHash: `hash-${id}`,
				accountId: 'account-a',
				tenantId,
				csrfToken: 'csrf',
				createdAt: 1_000,
				expiresAt: 100_000,
			});
		}

		expect(
			await database.repository.deleteSessionById('account-a', 'session-b'),
		).toBe(true);
		expect(
			await database.repository.deleteSessionById('account-a', 'session-b'),
		).toBe(false);
		expect(
			(await database.repository.listAccountSessions('account-a', 2_000)).map(
				(entry) => entry.id,
			),
		).toEqual(['session-a']);
	});

	/* Deleting the account row is the only cross-tenant write auth.core makes.
	   It works because referential actions are not subject to row security,
	   which is the property this pins. */
	it('removes an account from every workspace it belonged to', async () => {
		const database = await fixture();
		await seedTenant(database, 'tenant-a', 'account-a', 'ada@example.com');
		await database.repository.createTenantMembership({
			accountId: 'account-a',
			tenantId: 'tenant-b',
			organizationName: 'Second',
			organizationSlug: 'second',
			role: 'owner',
			scopes: OWNER_SCOPES,
			createdAt: 1_001,
		});
		await database.repository.createSession({
			id: 'session-1',
			tokenHash: 'token-hash-1',
			accountId: 'account-a',
			tenantId: 'tenant-b',
			csrfToken: 'csrf',
			createdAt: 1_000,
			expiresAt: 100_000,
		});
		expect(await database.repository.countMemberships('account-a')).toBe(2);

		await database.repository.deleteAccount('account-a');

		expect(await database.repository.countMemberships('account-a')).toBe(0);
		expect(await database.repository.listTenantMembers('tenant-b')).toEqual([]);
		expect(
			await database.repository.findSession(
				'token-hash-1',
				2_000,
				60_000,
				1_000,
			),
		).toBeNull();
	});

	it('refuses a write that forced row security assigns to another tenant', async () => {
		const database = await fixture();
		await seedTenant(database, 'tenant-a', 'account-a', 'ada@example.com');

		await expect(
			database.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO auth_audit
						       (tenant_id, actor_account_id, actor_label, actor_kind,
						        actor_run_id, action, subject_type, subject_id,
						        metadata_json, occurred_at)
						       VALUES ($1, NULL, 'forged', 'user', NULL, 'forged',
						               'account', 'account-a', '{}', 1)`,
						parameters: ['tenant-b'],
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			),
		).rejects.toBeDefined();
	});

	it('refuses any runtime statement without a tenant context', async () => {
		const database = await fixture();

		await expect(
			database.runtime.transaction(async () => undefined, { access: 'read' }),
		).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
	});

	it('grants the background role the routing columns and nothing else', async () => {
		const database = await fixture();
		await seedTenant(database, 'tenant-a', 'account-a', 'ada@example.com');
		await database.repository.createSession({
			id: 'session-1',
			tokenHash: 'token-hash-1',
			accountId: 'account-a',
			tenantId: 'tenant-a',
			csrfToken: 'csrf',
			createdAt: 1_000,
			expiresAt: 100_000,
		});

		const routed = await database.background.query<{ tenant_id: string }>({
			text: 'SELECT tenant_id FROM auth_sessions WHERE token_hash = $1',
			parameters: ['token-hash-1'],
		});
		expect(routed.rows).toEqual([{ tenant_id: 'tenant-a' }]);

		/* The CSRF token is outside the column grant, and so is every write. */
		await expect(
			database.background.query({
				text: 'SELECT csrf_token FROM auth_sessions WHERE token_hash = $1',
				parameters: ['token-hash-1'],
			}),
		).rejects.toBeDefined();
		await expect(
			database.background.query({
				text: 'SELECT password_hash FROM auth_accounts WHERE id = $1',
				parameters: ['account-a'],
			}),
		).rejects.toBeDefined();
		await expect(
			database.background.execute({
				text: 'DELETE FROM auth_sessions WHERE token_hash = $1',
				parameters: ['token-hash-1'],
			}),
		).rejects.toBeDefined();
	});
});
