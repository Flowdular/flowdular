import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { OWNER_SCOPES } from '../src/acl/scopes.ts';
import type { AuthActor } from '../src/domain/types.ts';
import { createAuthRuntime } from '../src/server/runtime.ts';
import { AuthService } from '../src/services/auth-service.ts';
import { fastHash } from './helpers.ts';
import {
	authTestProvider,
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

/* Every case here runs against an embedded PostgreSQL, whose first boot alone
   outlasts the default per-test timeout. */

async function workspace(now: { value: number } = { value: 1_000 }) {
	const database = await createAuthTestDatabase();
	open.add(database);
	const repository = database.repository;
	const policy = {
		sessionTtlMs: 12 * 60 * 60 * 1000,
		sessionIdleMs: 2 * 60 * 60 * 1000,
		passwordMinLength: 12,
	};
	const service = new AuthService(repository, {
		passwordHash: fastHash,
		policy: () => policy,
		now: () => now.value,
	});
	const issued = await service.signUp({
		email: 'owner@example.com',
		password: 'correct horse battery staple',
		displayName: 'Ada Owner',
		organizationName: 'Example Operations',
		organizationSlug: 'example-operations',
	});
	const owner: AuthActor = {
		accountId: issued.principal.accountId,
		tenantId: issued.principal.tenantId,
		email: issued.principal.email,
		role: 'owner',
		scopes: issued.principal.scopes,
	};
	const created = await service.createTenantMember(
		{
			tenantId: owner.tenantId,
			email: 'member@example.com',
			password: 'member password long',
			displayName: 'Mem Ber',
			role: 'member',
		},
		owner,
	);
	const member: AuthActor = {
		accountId: created.accountId,
		tenantId: owner.tenantId,
		email: created.email,
		role: 'member',
		scopes: created.scopes,
	};
	return { repository, service, owner, member, issued, policy, now };
}

describe('member administration', () => {
	it('caps the owner role to owners and forbids editing owners as a member', async () => {
		const { service, owner, member } = await workspace();
		await expect(
			service.createTenantMember(
				{
					tenantId: owner.tenantId,
					email: 'second@example.com',
					password: 'another long password',
					displayName: 'Second',
					role: 'owner',
				},
				member,
			),
		).rejects.toMatchObject({ code: 'OWNER_REQUIRED', status: 403 });
		await expect(
			service.assignMemberRole(member, owner.accountId, 'member'),
		).rejects.toThrow(/Only an owner/);
		await expect(
			service.setMemberStatus(member, owner.accountId, 'disabled'),
		).rejects.toThrow(/Only an owner/);
		await expect(
			service.createTenantMember(
				{
					tenantId: 'another-tenant',
					email: 'third@example.com',
					password: 'another long password',
					displayName: 'Third',
					role: 'member',
				},
				owner,
			),
		).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
	});

	it('disables, re-enables, and removes members while keeping one owner', async () => {
		const { service, owner, member } = await workspace();
		const session = await service.signIn({
			email: 'member@example.com',
			password: 'member password long',
		});
		const disabled = await service.setMemberStatus(
			owner,
			member.accountId,
			'disabled',
		);
		expect(disabled.status).toBe('disabled');
		expect(await service.resolveSession(session.token)).toBeNull();
		await expect(
			service.signIn({
				email: 'member@example.com',
				password: 'member password long',
			}),
		).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
		expect(
			(await service.setMemberStatus(owner, member.accountId, 'active')).status,
		).toBe('active');
		await expect(
			service.setMemberStatus(owner, owner.accountId, 'disabled'),
		).rejects.toThrow(/your profile/);
		await expect(service.removeMember(owner, owner.accountId)).rejects.toThrow(
			/your profile/,
		);
		const promoted = await service.assignMemberRole(
			owner,
			member.accountId,
			'owner',
		);
		expect(promoted.role).toBe('owner');
		expect(promoted.scopes).toEqual([...OWNER_SCOPES].sort());
		await service.removeMember(
			{ ...member, role: 'owner', scopes: OWNER_SCOPES },
			owner.accountId,
		);
		await expect(
			service.removeMember(
				{ ...member, role: 'owner', scopes: OWNER_SCOPES },
				member.accountId,
			),
		).rejects.toThrow(/your profile/);
		expect(await service.listTenantMembers(owner.tenantId)).toHaveLength(1);
		expect(await service.findAccountAccess('owner@example.com')).toBeNull();
	});

	it('refuses to demote or disable the last active owner', async () => {
		const { service, owner } = await workspace();
		const second = await service.createTenantMember(
			{
				tenantId: owner.tenantId,
				email: 'second@example.com',
				password: 'another long password',
				displayName: 'Second Owner',
				role: 'owner',
			},
			owner,
		);
		const secondActor: AuthActor = {
			accountId: second.accountId,
			tenantId: owner.tenantId,
			email: second.email,
			role: 'owner',
			scopes: second.scopes,
		};
		await service.setMemberStatus(secondActor, owner.accountId, 'disabled');
		await expect(
			service.assignMemberRole(owner, second.accountId, 'member'),
		).rejects.toThrow(/at least one active owner/);
		await expect(
			service.setMemberStatus(owner, second.accountId, 'disabled'),
		).rejects.toThrow(/at least one active owner/);
	});

	it('resets a password with a forced change and clears it on change', async () => {
		const { service, owner, member } = await workspace();
		const before = await service.signIn({
			email: 'member@example.com',
			password: 'member password long',
		});
		const reset = await service.resetMemberPassword(
			owner,
			member.accountId,
			'temporary password 123',
		);
		expect(reset.passwordChangeRequired).toBe(true);
		expect(await service.resolveSession(before.token)).toBeNull();
		const temporary = await service.signIn({
			email: 'member@example.com',
			password: 'temporary password 123',
		});
		expect(temporary.passwordChangeRequired).toBe(true);
		await service.changePassword({
			accountId: member.accountId,
			currentPassword: 'temporary password 123',
			newPassword: 'a brand new password',
			keepSessionToken: temporary.token,
		});
		expect(
			(await service.resolveSession(temporary.token))?.passwordChangeRequired,
		).toBe(false);
		await expect(
			service.resetMemberPassword(owner, member.accountId, 'short'),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });
	});

	it('bounds membership scopes to grantable ones and to the actor', async () => {
		const { service, owner, member } = await workspace();
		await expect(
			service.setMembershipScopes(owner, member.accountId, ['made.up.scope']),
		).rejects.toThrow(/cannot be granted/);
		const updated = await service.setMembershipScopes(owner, member.accountId, [
			'users.members.read',
			'auth.audit.read',
		]);
		expect(updated.scopes).toEqual(['auth.audit.read', 'users.members.read']);
		const managerScopes = ['users.members.manage', 'users.members.read'];
		const manager = await service.createTenantMember(
			{
				tenantId: owner.tenantId,
				email: 'manager@example.com',
				password: 'manager password long',
				displayName: 'Man Ager',
				role: 'member',
			},
			owner,
		);
		await service.setMembershipScopes(owner, manager.accountId, managerScopes);
		const managerActor: AuthActor = {
			accountId: manager.accountId,
			tenantId: owner.tenantId,
			email: manager.email,
			role: 'member',
			scopes: managerScopes,
		};
		await expect(
			service.setMembershipScopes(managerActor, member.accountId, [
				'auth.tokens.manage',
			]),
		).rejects.toThrow(/do not hold/);
		expect(
			(
				await service.setMembershipScopes(managerActor, member.accountId, [
					'users.members.read',
				])
			).scopes,
		).toEqual(['users.members.read']);
		expect(await service.listGrantableScopes(owner.tenantId)).toContain(
			'system.settings.manage',
		);
	});

	it('ends idle sessions before their absolute expiry', async () => {
		const now = { value: 1_000 };
		const { service, issued, policy } = await workspace(now);
		now.value += policy.sessionIdleMs - 1;
		expect(await service.resolveSession(issued.token)).not.toBeNull();
		now.value += policy.sessionIdleMs + 1;
		expect(await service.resolveSession(issued.token)).toBeNull();
	});
});

describe('custom roles', () => {
	it('creates, assigns, updates, and protects roles', async () => {
		const { service, owner, member } = await workspace();
		const role = await service.createRole(owner, {
			tenantId: owner.tenantId,
			key: 'auditor',
			name: 'Auditor',
			description: 'Reads audit trails',
			scopes: ['auth.audit.read', 'users.members.read'],
		});
		expect(role.builtin).toBe(false);
		await expect(
			service.createRole(owner, {
				tenantId: owner.tenantId,
				key: 'owner',
				name: 'Owner again',
				description: '',
				scopes: ['users.members.read'],
			}),
		).rejects.toThrow(/built in/);
		await expect(
			service.createRole(owner, {
				tenantId: owner.tenantId,
				key: 'auditor',
				name: 'Duplicate',
				description: '',
				scopes: ['users.members.read'],
			}),
		).rejects.toThrow(/already exists/);
		await expect(
			service.createRole(owner, {
				tenantId: owner.tenantId,
				key: 'wide',
				name: 'Wide',
				description: '',
				scopes: ['not.grantable.scope'],
			}),
		).rejects.toThrow(/cannot be granted/);
		const assigned = await service.assignMemberRole(
			owner,
			member.accountId,
			'auditor',
		);
		expect(assigned.role).toBe('auditor');
		expect(assigned.roleId).toBe(role.id);
		expect(assigned.scopes).toEqual(['auth.audit.read', 'users.members.read']);
		await expect(service.deleteRole(owner, role.id)).rejects.toThrow(
			/Reassign/,
		);
		const updated = await service.updateRole(owner, {
			tenantId: owner.tenantId,
			id: role.id,
			scopes: ['auth.audit.read'],
		});
		expect(updated.scopes).toEqual(['auth.audit.read']);
		expect(
			await service.listMembershipScopes(member.accountId, owner.tenantId),
		).toEqual(['auth.audit.read']);
		const builtin = (await service.listRoles(owner.tenantId)).find(
			(entry) => entry.key === 'owner',
		)!;
		await expect(
			service.updateRole(owner, {
				tenantId: owner.tenantId,
				id: builtin.id,
				name: 'Renamed',
			}),
		).rejects.toThrow(/Built-in/);
		await expect(service.deleteRole(owner, builtin.id)).rejects.toThrow(
			/Built-in/,
		);
		await service.assignMemberRole(owner, member.accountId, 'member');
		await service.deleteRole(owner, role.id);
		expect(
			(await service.listRoles(owner.tenantId)).map((entry) => entry.key),
		).toEqual(['owner', 'member']);
	});

	it('keeps roles invisible and unassignable across tenants', async () => {
		const { service, owner } = await workspace();
		const other = await service.signUp({
			email: 'other@example.com',
			password: 'correct horse battery staple',
			displayName: 'Other Owner',
			organizationName: 'Other',
			organizationSlug: 'other-workspace',
		});
		const otherActor: AuthActor = {
			accountId: other.principal.accountId,
			tenantId: other.principal.tenantId,
			email: other.principal.email,
			role: 'owner',
			scopes: other.principal.scopes,
		};
		const role = await service.createRole(owner, {
			tenantId: owner.tenantId,
			key: 'auditor',
			name: 'Auditor',
			description: '',
			scopes: ['auth.audit.read'],
		});
		expect(
			(await service.listRoles(otherActor.tenantId)).map((entry) => entry.key),
		).toEqual(['owner', 'member']);
		await expect(
			service.updateRole(otherActor, {
				tenantId: otherActor.tenantId,
				id: role.id,
				name: 'Stolen',
			}),
		).rejects.toThrow(/does not exist/);
		await expect(service.deleteRole(otherActor, role.id)).rejects.toThrow(
			/does not exist/,
		);
		await expect(
			service.assignMemberRole(otherActor, owner.accountId, 'auditor'),
		).rejects.toThrow(/not a member/);
	});

	it('records an audit trail for administrative actions', async () => {
		const { service, owner, member } = await workspace();
		await service.updateMemberDisplayName(
			owner,
			member.accountId,
			'Renamed Member',
		);
		await service.assignMemberRole(owner, member.accountId, 'owner');
		const page = await service.queryAudit({
			tenantId: owner.tenantId,
			limit: 10,
		});
		expect(page.events.map((event) => event.action)).toEqual([
			'users.member.role',
			'users.member.updated',
			'users.member.created',
			'auth.sign-in.succeeded',
		]);
		expect(page.events[0]?.actorLabel).toBe('owner@example.com');
		expect(JSON.stringify(page.events)).not.toMatch(/password/);
	});
});

describe('settings audit', () => {
	it('appends settings.updated when the shared runtime commits a change', async () => {
		const runtime = createAuthRuntime({
			databases: await authTestProvider(),
			secureCookies: false,
			sessionTtlMs: 3_600_000,
			allowSignUp: true,
			emailConfirmation: false,
			signInProviders: [],
		});
		try {
			const issued = await (
				await runtime.service()
			).signUp({
				email: 'owner@example.com',
				password: 'correct horse battery staple',
				displayName: 'Ada Owner',
				organizationName: 'Example Operations',
				organizationSlug: 'example-operations',
			});
			const { accountId, tenantId } = issued.principal;
			runtime.moduleSettings.set(
				tenantId,
				'auth.core',
				'sessionIdleMinutes',
				45,
				accountId,
			);
			runtime.moduleSettings.set(
				tenantId,
				'auth.core',
				'sessionIdleMinutes',
				null,
				accountId,
			);
			/* The settings change listener is synchronous and the audit row lands
			   after it returns, so the trail is read once the write has arrived. */
			const events = await vi.waitFor(
				async () => {
					const page = await (
						await runtime.service()
					).queryAudit({ tenantId, limit: 10 });
					const settings = page.events.filter(
						(event) => event.action === 'settings.updated',
					);
					expect(settings).toHaveLength(2);
					return settings;
				},
				{ timeout: 5_000, interval: 25 },
			);
			expect(events[0]).toMatchObject({
				actorLabel: 'owner@example.com',
				subjectType: 'setting',
				subjectId: 'auth.core.sessionIdleMinutes',
				metadata: { cleared: true },
			});
			expect(events[1]?.metadata).toEqual({ cleared: false });
		} finally {
			await runtime.dispose();
		}
	});
});
