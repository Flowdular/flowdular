import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import { SandboxService } from '../src/services/sandbox-service.ts';
import { SandboxServiceError } from '../src/services/sandbox-service-error.ts';
import {
	directoryFromAuthRuntime,
	type SandboxDirectory,
	type SandboxDirectoryMember,
} from '../src/services/directory.ts';
import {
	closeSandboxTestDatabases,
	createSandboxTestDatabase,
	type SandboxTestDatabase,
} from './support/database.ts';

const OWNER: SandboxDirectoryMember = {
	accountId: 'account-owner',
	email: 'owner@example.com',
	displayName: 'Olga Owner',
	role: 'owner',
	status: 'active',
};

const MEMBER: SandboxDirectoryMember = {
	accountId: 'account-member',
	email: 'member@example.com',
	displayName: 'Mira Member',
	role: 'member',
	status: 'active',
};

function directory(
	scopes: Record<string, readonly string[]>,
	members: readonly SandboxDirectoryMember[] = [OWNER, MEMBER],
): SandboxDirectory {
	return {
		listMembers: async (tenantId) => (tenantId === 'tenant-a' ? members : []),
		listScopes: async (accountId) => scopes[accountId] ?? [],
		listScopesForMembers: async (accountIds) =>
			new Map(
				accountIds.map((accountId) => [accountId, scopes[accountId] ?? []]),
			),
	};
}

const FULL_SCOPES = [
	'sandbox.access.use',
	'sandbox.sessions.read',
	'sandbox.preview.data',
	'sandbox.modules.eject',
];

const databases = new Set<SandboxTestDatabase>();

afterEach(async () => {
	await Promise.all([...databases].map((database) => database.dispose()));
	databases.clear();
});

afterAll(closeSandboxTestDatabases);

async function sandboxFixture(): Promise<SandboxTestDatabase> {
	const database = await createSandboxTestDatabase();
	databases.add(database);
	return database;
}

async function serviceWith(
	scopes: Record<string, readonly string[]>,
	options?: { readonly now: () => number },
): Promise<SandboxService> {
	const database = await sandboxFixture();
	return new SandboxService(database.repository, directory(scopes), options);
}

function ownerService(): Promise<SandboxService> {
	return serviceWith({ 'account-owner': FULL_SCOPES, 'account-member': [] });
}

describe('sandbox access candidates', () => {
	/* The directory is the only cross-module read, and a workspace has many
	   members: the candidate list costs one scope read, not one per member. */
	it('reads the scopes of every member in one directory call', async () => {
		const members = Array.from({ length: 12 }, (_, index) => ({
			...MEMBER,
			accountId: `account-${String(index)}`,
			email: `member-${String(index)}@example.com`,
		}));
		const scopes = Object.fromEntries(
			members.map((member, index) => [
				member.accountId,
				index % 2 === 0 ? FULL_SCOPES : [],
			]),
		);
		const listScopes = vi.fn(directory(scopes, members).listScopes);
		const listScopesForMembers = vi.fn(
			directory(scopes, members).listScopesForMembers,
		);
		const database = await sandboxFixture();
		const service = new SandboxService(database.repository, {
			listMembers: async () => members,
			listScopes,
			listScopesForMembers,
		});

		const candidates = await service.listCandidates('tenant-a');
		expect(candidates).toHaveLength(12);
		expect(
			candidates.map((candidate) => candidate.availableCapabilities),
		).toEqual(members.map((_, index) => (index % 2 === 0 ? FULL_SCOPES : [])));
		expect(listScopesForMembers).toHaveBeenCalledTimes(1);
		expect(listScopesForMembers).toHaveBeenCalledWith(
			members.map((member) => member.accountId),
			'tenant-a',
		);
		expect(listScopes).not.toHaveBeenCalled();
	});

	it('answers the bulk scope read from one auth member listing', async () => {
		const listTenantMembers = vi.fn(async () => [
			{ ...OWNER, scopes: FULL_SCOPES },
			{ ...MEMBER, scopes: ['sandbox.access.use'] },
			{ ...MEMBER, accountId: 'account-other', scopes: FULL_SCOPES },
		]);
		const listMembershipScopes = vi.fn();
		const auth = {
			service: async () => ({ listTenantMembers, listMembershipScopes }),
		} as unknown as AuthRuntime;

		const scopes = await directoryFromAuthRuntime(auth).listScopesForMembers(
			[OWNER.accountId, MEMBER.accountId],
			'tenant-a',
		);
		expect([...scopes.entries()]).toEqual([
			[OWNER.accountId, FULL_SCOPES],
			[MEMBER.accountId, ['sandbox.access.use']],
		]);
		expect(listTenantMembers).toHaveBeenCalledTimes(1);
		expect(listTenantMembers).toHaveBeenCalledWith('tenant-a');
		expect(listMembershipScopes).not.toHaveBeenCalled();
	});
});

describe('sandbox access grants', () => {
	it('grants every sandbox capability the membership holds', async () => {
		const service = await ownerService();
		const grant = await service.grant({
			tenantId: 'tenant-a',
			actorId: 'account-owner',
			accountId: 'account-owner',
		});
		expect(grant.capabilities).toEqual(FULL_SCOPES);
		expect(grant.revokedAt).toBeNull();
	});

	it('never widens a grant beyond the scopes of the membership', async () => {
		const service = await serviceWith({
			'account-member': ['sandbox.access.use', 'sandbox.sessions.read'],
		});
		const grant = await service.grant({
			tenantId: 'tenant-a',
			actorId: 'account-owner',
			accountId: 'account-member',
			capabilities: FULL_SCOPES,
		});
		expect(grant.capabilities).toEqual([
			'sandbox.access.use',
			'sandbox.sessions.read',
		]);
	});

	it('refuses a grant for a membership without the access scope', async () => {
		const service = await ownerService();
		await expect(
			service.grant({
				tenantId: 'tenant-a',
				actorId: 'account-owner',
				accountId: 'account-member',
			}),
		).rejects.toThrow(SandboxServiceError);
	});

	it('refuses a grant for an account outside the tenant', async () => {
		const service = await ownerService();
		await expect(
			service.grant({
				tenantId: 'tenant-b',
				actorId: 'account-owner',
				accountId: 'account-owner',
			}),
		).rejects.toThrow(/not a member/);
	});

	it('authorizes only while the grant is active and the scope is held', async () => {
		const service = await ownerService();
		await service.grant({
			tenantId: 'tenant-a',
			actorId: 'account-owner',
			accountId: 'account-owner',
		});
		expect(
			await service.authorize('tenant-a', 'account-owner', FULL_SCOPES),
		).toMatchObject({ granted: true, capabilities: FULL_SCOPES });
		expect(
			await service.authorize('tenant-a', 'account-owner', [
				'sandbox.sessions.read',
			]),
		).toEqual({ granted: false, reason: 'scope-missing' });
		expect(
			await service.authorize('tenant-a', 'account-unknown', FULL_SCOPES),
		).toEqual({ granted: false, reason: 'grant-missing' });

		await service.revoke('tenant-a', 'account-owner', 'account-owner');
		expect(
			await service.authorize('tenant-a', 'account-owner', FULL_SCOPES),
		).toEqual({ granted: false, reason: 'grant-revoked' });
	});

	it('denies an expired grant', async () => {
		let now = 1_000_000;
		const expiring = await serviceWith(
			{ 'account-owner': FULL_SCOPES },
			{ now: () => now },
		);
		await expiring.grant({
			tenantId: 'tenant-a',
			actorId: 'account-owner',
			accountId: 'account-owner',
			expiresAt: now + 60_000,
		});
		now += 60_001;
		expect(
			await expiring.authorize('tenant-a', 'account-owner', FULL_SCOPES),
		).toEqual({ granted: false, reason: 'grant-expired' });
	});

	it('keeps grants, sessions, and audit events tenant scoped', async () => {
		const service = await ownerService();
		await service.grant({
			tenantId: 'tenant-a',
			actorId: 'account-owner',
			accountId: 'account-owner',
		});
		expect(await service.listGrants('tenant-b')).toHaveLength(0);
		expect(await service.listSessions('tenant-b')).toHaveLength(0);
		expect(await service.listAuditEvents('tenant-b')).toHaveLength(0);
	});
});

describe('sandbox sessions and audit', () => {
	it('records session lifecycle transitions in a verifiable chain', async () => {
		const service = await serviceWith({ 'account-owner': FULL_SCOPES });
		const session = await service.registerSession({
			tenantId: 'tenant-a',
			accountId: 'account-owner',
			sessionId: 'session-1',
			moduleId: 'sales.orders',
			title: 'Sales orders draft',
			blueprint: 'new-module@1.0.0',
			driver: 'claude-code',
			mode: 'loopback',
		});
		expect(session.state).toBe('draft');

		const updated = await service.updateSessionState(
			'tenant-a',
			'session-1',
			'previewing',
			'account-owner',
		);
		expect(updated.state).toBe('previewing');
		expect(await service.verifyAuditChain('tenant-a')).toBe(true);
		expect(
			(await service.listAuditEvents('tenant-a')).map((event) => event.action),
		).toContain('sandbox.session.state');
	});

	it('refuses a session transition from another tenant', async () => {
		const service = await serviceWith({ 'account-owner': FULL_SCOPES });
		await service.registerSession({
			tenantId: 'tenant-a',
			accountId: 'account-owner',
			sessionId: 'session-1',
			moduleId: 'sales.orders',
			title: 'Sales orders draft',
			blueprint: 'new-module@1.0.0',
			driver: 'claude-code',
			mode: 'loopback',
		});
		await expect(
			service.updateSessionState(
				'tenant-b',
				'session-1',
				'accepted',
				'account-owner',
			),
		).rejects.toThrow(/does not exist/);
	});
});

describe('sandbox session lifecycle', () => {
	async function serviceWithSession(): Promise<SandboxService> {
		const service = await serviceWith({ 'account-owner': FULL_SCOPES });
		await service.registerSession({
			tenantId: 'tenant-a',
			accountId: 'account-owner',
			sessionId: 'session-1',
			moduleId: 'sales.orders',
			title: 'Sales orders draft',
			blueprint: 'new-module@1.0.0',
			driver: 'claude-code',
			mode: 'loopback',
		});
		return service;
	}

	it('archives, restores, and deletes with named audit actions', async () => {
		const service = await serviceWithSession();
		const archived = await service.archiveSession(
			'tenant-a',
			'session-1',
			'account-owner',
		);
		expect(archived.state).toBe('archived');
		expect(archived.archivedAt).not.toBeNull();

		const restored = await service.updateSessionState(
			'tenant-a',
			'session-1',
			'previewing',
			'account-owner',
		);
		expect(restored.state).toBe('previewing');
		expect(restored.archivedAt).toBeNull();

		const deleted = await service.deleteSession(
			'tenant-a',
			'session-1',
			'account-owner',
		);
		expect(deleted.state).toBe('deleted');
		await expect(
			service.updateSessionState(
				'tenant-a',
				'session-1',
				'draft',
				'account-owner',
			),
		).rejects.toThrow(/deleted/);

		const actions = (await service.listAuditEvents('tenant-a')).map(
			(event) => event.action,
		);
		expect(actions).toContain('sandbox.session.archived');
		expect(actions).toContain('sandbox.session.restored');
		expect(actions).toContain('sandbox.session.deleted');
		expect(await service.verifyAuditChain('tenant-a')).toBe(true);
	});

	it('rejects a state the enum does not know before the database sees it', async () => {
		const service = await serviceWithSession();
		await expect(
			service.updateSessionState(
				'tenant-a',
				'session-1',
				'exploded' as never,
				'account-owner',
			),
		).rejects.toThrow(/not a sandbox session state/);
	});

	it('records an eject as module evidence in the chain', async () => {
		const service = await serviceWithSession();
		const event = await service.recordEject(
			'tenant-a',
			'session-1',
			'account-owner',
			{
				target: 'workspace',
				files: 12,
				enabled: true,
			},
		);
		expect(event.action).toBe('sandbox.module.ejected');
		expect(event.subjectType).toBe('module');
		expect(await service.verifyAuditChain('tenant-a')).toBe(true);
	});
});

/* The runtime handle tampers a stored row the way an operator with database
   access would, then the service re-verifies through its own reads. */
describe('sandbox audit chain verification', () => {
	it('verifies an untouched chain and reports the row that was altered', async () => {
		const database = await sandboxFixture();
		const service = new SandboxService(
			database.repository,
			directory({ 'account-owner': FULL_SCOPES }),
		);
		await service.grant({
			tenantId: 'tenant-a',
			actorId: 'account-owner',
			accountId: 'account-owner',
		});
		await service.registerSession({
			tenantId: 'tenant-a',
			accountId: 'account-owner',
			sessionId: 'session-1',
			moduleId: 'demo.core',
			title: 'Demo module',
			blueprint: 'demo',
			driver: 'loopback-cli',
			mode: 'loopback',
		});
		expect(await service.verifyAudit('tenant-a')).toEqual({
			verified: true,
			brokenAt: null,
		});

		/* Newest first: index 0 is the session event, sequence 2. */
		const target = (await service.listAuditEvents('tenant-a'))[0]!;
		await database.runtime.transaction(
			(transaction) =>
				transaction.execute({
					text: 'UPDATE sandbox_audit_events SET metadata_json = $1 WHERE id = $2',
					parameters: ['{"tampered":"1"}', target.id],
				}),
			{ access: 'write', tenantId: 'tenant-a' },
		);

		const result = await service.verifyAudit('tenant-a');
		expect(result.verified).toBe(false);
		expect(result.brokenAt).toBe(target.id);
		expect(await service.verifyAuditChain('tenant-a')).toBe(false);
	});
});

describe('sandbox PostgreSQL tenant boundary', () => {
	it('refuses a write that forced row security assigns to another tenant', async () => {
		const database = await sandboxFixture();

		await expect(
			database.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO sandbox_sessions
							 (id, tenant_id, account_id, module_id, title, blueprint,
							  driver, mode, state, created_at, updated_at)
							 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
						parameters: [
							'forged',
							'tenant-b',
							'account-owner',
							'sales.orders',
							'Forged',
							'new-module@1.0.0',
							'claude',
							'loopback',
							'draft',
							Date.now(),
							Date.now(),
						],
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			),
		).rejects.toBeDefined();
	});

	it('refuses any runtime statement without a tenant context', async () => {
		const database = await sandboxFixture();

		await expect(
			database.runtime.transaction(async () => undefined, { access: 'read' }),
		).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
	});

	it('hides another tenant rows from a tenant-scoped read', async () => {
		const database = await sandboxFixture();
		const service = new SandboxService(
			database.repository,
			directory({ 'account-owner': FULL_SCOPES }),
		);
		await service.registerSession({
			tenantId: 'tenant-a',
			accountId: 'account-owner',
			sessionId: 'session-1',
			moduleId: 'sales.orders',
			title: 'Sales orders',
			blueprint: 'new-module@1.0.0',
			driver: 'claude',
			mode: 'loopback',
		});

		expect(
			(await service.listSessions('tenant-a', 10)).map((session) => session.id),
		).toEqual(['session-1']);
		expect(await service.listSessions('tenant-b', 10)).toEqual([]);

		/* The unfiltered read is the control: it returns the row under the owning
		   tenant, so an empty result under the other tenant is the policy and not
		   a broken query. */
		const unfiltered = (tenantId: string) =>
			database.runtime.transaction(
				(transaction) =>
					transaction.query<{ id: string }>({
						text: 'SELECT id FROM sandbox_sessions',
					}),
				{ access: 'read', tenantId },
			);
		expect((await unfiltered('tenant-a')).rows).toEqual([{ id: 'session-1' }]);
		expect((await unfiltered('tenant-b')).rows).toEqual([]);
	});
});
