import { beforeEach, describe, expect, it } from 'vitest';
import { SandboxService } from '../src/services/sandbox-service.ts';
import { SandboxServiceError } from '../src/services/sandbox-service-error.ts';
import { SqliteSandboxRepository } from '../src/services/sqlite-repository.ts';
import type {
	SandboxDirectory,
	SandboxDirectoryMember,
} from '../src/services/directory.ts';

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
		listMembers: (tenantId) => (tenantId === 'tenant-a' ? members : []),
		listScopes: (accountId) => scopes[accountId] ?? [],
	};
}

const FULL_SCOPES = [
	'sandbox.access.use',
	'sandbox.sessions.read',
	'sandbox.preview.data',
	'sandbox.modules.eject',
];

describe('sandbox access grants', () => {
	let service: SandboxService;

	beforeEach(() => {
		service = new SandboxService(
			new SqliteSandboxRepository(':memory:'),
			directory({ 'account-owner': FULL_SCOPES, 'account-member': [] }),
		);
	});

	it('grants every sandbox capability the membership holds', () => {
		const grant = service.grant({
			tenantId: 'tenant-a',
			actorId: 'account-owner',
			accountId: 'account-owner',
		});
		expect(grant.capabilities).toEqual(FULL_SCOPES);
		expect(grant.revokedAt).toBeNull();
	});

	it('never widens a grant beyond the scopes of the membership', () => {
		const service_ = new SandboxService(
			new SqliteSandboxRepository(':memory:'),
			directory({
				'account-member': ['sandbox.access.use', 'sandbox.sessions.read'],
			}),
		);
		const grant = service_.grant({
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

	it('refuses a grant for a membership without the access scope', () => {
		expect(() =>
			service.grant({
				tenantId: 'tenant-a',
				actorId: 'account-owner',
				accountId: 'account-member',
			}),
		).toThrow(SandboxServiceError);
	});

	it('refuses a grant for an account outside the tenant', () => {
		expect(() =>
			service.grant({
				tenantId: 'tenant-b',
				actorId: 'account-owner',
				accountId: 'account-owner',
			}),
		).toThrow(/not a member/);
	});

	it('authorizes only while the grant is active and the scope is held', () => {
		service.grant({
			tenantId: 'tenant-a',
			actorId: 'account-owner',
			accountId: 'account-owner',
		});
		expect(
			service.authorize('tenant-a', 'account-owner', FULL_SCOPES),
		).toMatchObject({ granted: true, capabilities: FULL_SCOPES });
		expect(
			service.authorize('tenant-a', 'account-owner', ['sandbox.sessions.read']),
		).toEqual({ granted: false, reason: 'scope-missing' });
		expect(
			service.authorize('tenant-a', 'account-unknown', FULL_SCOPES),
		).toEqual({ granted: false, reason: 'grant-missing' });

		service.revoke('tenant-a', 'account-owner', 'account-owner');
		expect(service.authorize('tenant-a', 'account-owner', FULL_SCOPES)).toEqual(
			{ granted: false, reason: 'grant-revoked' },
		);
	});

	it('denies an expired grant', () => {
		let now = 1_000_000;
		const expiring = new SandboxService(
			new SqliteSandboxRepository(':memory:'),
			directory({ 'account-owner': FULL_SCOPES }),
			{ now: () => now },
		);
		expiring.grant({
			tenantId: 'tenant-a',
			actorId: 'account-owner',
			accountId: 'account-owner',
			expiresAt: now + 60_000,
		});
		now += 60_001;
		expect(
			expiring.authorize('tenant-a', 'account-owner', FULL_SCOPES),
		).toEqual({ granted: false, reason: 'grant-expired' });
	});

	it('keeps grants, sessions, and audit events tenant scoped', () => {
		service.grant({
			tenantId: 'tenant-a',
			actorId: 'account-owner',
			accountId: 'account-owner',
		});
		expect(service.listGrants('tenant-b')).toHaveLength(0);
		expect(service.listSessions('tenant-b')).toHaveLength(0);
		expect(service.listAuditEvents('tenant-b')).toHaveLength(0);
	});
});

describe('sandbox sessions and audit', () => {
	it('records session lifecycle transitions in a verifiable chain', () => {
		const service = new SandboxService(
			new SqliteSandboxRepository(':memory:'),
			directory({ 'account-owner': FULL_SCOPES }),
		);
		const session = service.registerSession({
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

		const updated = service.updateSessionState(
			'tenant-a',
			'session-1',
			'previewing',
			'account-owner',
		);
		expect(updated.state).toBe('previewing');
		expect(service.verifyAuditChain('tenant-a')).toBe(true);
		expect(
			service.listAuditEvents('tenant-a').map((event) => event.action),
		).toContain('sandbox.session.state');
	});

	it('refuses a session transition from another tenant', () => {
		const service = new SandboxService(
			new SqliteSandboxRepository(':memory:'),
			directory({ 'account-owner': FULL_SCOPES }),
		);
		service.registerSession({
			tenantId: 'tenant-a',
			accountId: 'account-owner',
			sessionId: 'session-1',
			moduleId: 'sales.orders',
			title: 'Sales orders draft',
			blueprint: 'new-module@1.0.0',
			driver: 'claude-code',
			mode: 'loopback',
		});
		expect(() =>
			service.updateSessionState(
				'tenant-b',
				'session-1',
				'accepted',
				'account-owner',
			),
		).toThrow(/does not exist/);
	});
});

describe('sandbox session lifecycle', () => {
	function serviceWithSession() {
		const service = new SandboxService(
			new SqliteSandboxRepository(':memory:'),
			directory({ 'account-owner': FULL_SCOPES }),
		);
		service.registerSession({
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

	it('archives, restores, and deletes with named audit actions', () => {
		const service = serviceWithSession();
		const archived = service.archiveSession(
			'tenant-a',
			'session-1',
			'account-owner',
		);
		expect(archived.state).toBe('archived');
		expect(archived.archivedAt).not.toBeNull();

		const restored = service.updateSessionState(
			'tenant-a',
			'session-1',
			'previewing',
			'account-owner',
		);
		expect(restored.state).toBe('previewing');
		expect(restored.archivedAt).toBeNull();

		const deleted = service.deleteSession(
			'tenant-a',
			'session-1',
			'account-owner',
		);
		expect(deleted.state).toBe('deleted');
		expect(() =>
			service.updateSessionState(
				'tenant-a',
				'session-1',
				'draft',
				'account-owner',
			),
		).toThrow(/deleted/);

		const actions = service
			.listAuditEvents('tenant-a')
			.map((event) => event.action);
		expect(actions).toContain('sandbox.session.archived');
		expect(actions).toContain('sandbox.session.restored');
		expect(actions).toContain('sandbox.session.deleted');
		expect(service.verifyAuditChain('tenant-a')).toBe(true);
	});

	it('rejects a state the enum does not know before the database sees it', () => {
		const service = serviceWithSession();
		expect(() =>
			service.updateSessionState(
				'tenant-a',
				'session-1',
				'exploded' as never,
				'account-owner',
			),
		).toThrow(/not a sandbox session state/);
	});

	it('records an eject as module evidence in the chain', () => {
		const service = serviceWithSession();
		const event = service.recordEject(
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
		expect(service.verifyAuditChain('tenant-a')).toBe(true);
	});
});
