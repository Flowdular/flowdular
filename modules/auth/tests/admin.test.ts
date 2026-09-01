import { describe, expect, it } from 'vitest';
import { OWNER_SCOPES } from '../src/acl/scopes.ts';
import type { AuthActor } from '../src/domain/types.ts';
import { createAuthRuntime } from '../src/server/runtime.ts';
import { AuthService } from '../src/services/auth-service.ts';
import { SqliteAuthRepository } from '../src/services/sqlite-repository.ts';
import { fastHash } from './helpers.ts';

async function workspace(now: { value: number } = { value: 1_000 }) {
	const repository = new SqliteAuthRepository(':memory:');
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
		expect(() =>
			service.assignMemberRole(member, owner.accountId, 'member'),
		).toThrow(/Only an owner/);
		expect(() =>
			service.setMemberStatus(member, owner.accountId, 'disabled'),
		).toThrow(/Only an owner/);
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
		const disabled = service.setMemberStatus(
			owner,
			member.accountId,
			'disabled',
		);
		expect(disabled.status).toBe('disabled');
		expect(service.resolveSession(session.token)).toBeNull();
		await expect(
			service.signIn({
				email: 'member@example.com',
				password: 'member password long',
			}),
		).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
		expect(
			service.setMemberStatus(owner, member.accountId, 'active').status,
		).toBe('active');
		expect(() =>
			service.setMemberStatus(owner, owner.accountId, 'disabled'),
		).toThrow(/your profile/);
		expect(() => service.removeMember(owner, owner.accountId)).toThrow(
			/your profile/,
		);
		const promoted = service.assignMemberRole(owner, member.accountId, 'owner');
		expect(promoted.role).toBe('owner');
		expect(promoted.scopes).toEqual([...OWNER_SCOPES].sort());
		service.removeMember(
			{ ...member, role: 'owner', scopes: OWNER_SCOPES },
			owner.accountId,
		);
		expect(() =>
			service.removeMember(
				{ ...member, role: 'owner', scopes: OWNER_SCOPES },
				member.accountId,
			),
		).toThrow(/your profile/);
		expect(service.listTenantMembers(owner.tenantId)).toHaveLength(1);
		expect(service.findAccountAccess('owner@example.com')).toBeNull();
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
		service.setMemberStatus(secondActor, owner.accountId, 'disabled');
		expect(() =>
			service.assignMemberRole(owner, second.accountId, 'member'),
		).toThrow(/at least one active owner/);
		expect(() =>
			service.setMemberStatus(owner, second.accountId, 'disabled'),
		).toThrow(/at least one active owner/);
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
		expect(service.resolveSession(before.token)).toBeNull();
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
			service.resolveSession(temporary.token)?.passwordChangeRequired,
		).toBe(false);
		await expect(
			service.resetMemberPassword(owner, member.accountId, 'short'),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });
	});

	it('bounds membership scopes to grantable ones and to the actor', async () => {
		const { service, owner, member } = await workspace();
		expect(() =>
			service.setMembershipScopes(owner, member.accountId, ['made.up.scope']),
		).toThrow(/cannot be granted/);
		const updated = service.setMembershipScopes(owner, member.accountId, [
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
		service.setMembershipScopes(owner, manager.accountId, managerScopes);
		const managerActor: AuthActor = {
			accountId: manager.accountId,
			tenantId: owner.tenantId,
			email: manager.email,
			role: 'member',
			scopes: managerScopes,
		};
		expect(() =>
			service.setMembershipScopes(managerActor, member.accountId, [
				'auth.tokens.manage',
			]),
		).toThrow(/do not hold/);
		expect(
			service.setMembershipScopes(managerActor, member.accountId, [
				'users.members.read',
			]).scopes,
		).toEqual(['users.members.read']);
		expect(service.listGrantableScopes(owner.tenantId)).toContain(
			'system.settings.manage',
		);
	});

	it('ends idle sessions before their absolute expiry', async () => {
		const now = { value: 1_000 };
		const { service, issued, policy } = await workspace(now);
		now.value += policy.sessionIdleMs - 1;
		expect(service.resolveSession(issued.token)).not.toBeNull();
		now.value += policy.sessionIdleMs + 1;
		expect(service.resolveSession(issued.token)).toBeNull();
	});
});

describe('custom roles', () => {
	it('creates, assigns, updates, and protects roles', async () => {
		const { service, owner, member } = await workspace();
		const role = service.createRole(owner, {
			tenantId: owner.tenantId,
			key: 'auditor',
			name: 'Auditor',
			description: 'Reads audit trails',
			scopes: ['auth.audit.read', 'users.members.read'],
		});
		expect(role.builtin).toBe(false);
		expect(() =>
			service.createRole(owner, {
				tenantId: owner.tenantId,
				key: 'owner',
				name: 'Owner again',
				description: '',
				scopes: ['users.members.read'],
			}),
		).toThrow(/built in/);
		expect(() =>
			service.createRole(owner, {
				tenantId: owner.tenantId,
				key: 'auditor',
				name: 'Duplicate',
				description: '',
				scopes: ['users.members.read'],
			}),
		).toThrow(/already exists/);
		expect(() =>
			service.createRole(owner, {
				tenantId: owner.tenantId,
				key: 'wide',
				name: 'Wide',
				description: '',
				scopes: ['not.grantable.scope'],
			}),
		).toThrow(/cannot be granted/);
		const assigned = service.assignMemberRole(
			owner,
			member.accountId,
			'auditor',
		);
		expect(assigned.role).toBe('auditor');
		expect(assigned.roleId).toBe(role.id);
		expect(assigned.scopes).toEqual(['auth.audit.read', 'users.members.read']);
		expect(() => service.deleteRole(owner, role.id)).toThrow(/Reassign/);
		const updated = service.updateRole(owner, {
			tenantId: owner.tenantId,
			id: role.id,
			scopes: ['auth.audit.read'],
		});
		expect(updated.scopes).toEqual(['auth.audit.read']);
		expect(
			service.listMembershipScopes(member.accountId, owner.tenantId),
		).toEqual(['auth.audit.read']);
		const builtin = service
			.listRoles(owner.tenantId)
			.find((entry) => entry.key === 'owner')!;
		expect(() =>
			service.updateRole(owner, {
				tenantId: owner.tenantId,
				id: builtin.id,
				name: 'Renamed',
			}),
		).toThrow(/Built-in/);
		expect(() => service.deleteRole(owner, builtin.id)).toThrow(/Built-in/);
		service.assignMemberRole(owner, member.accountId, 'member');
		service.deleteRole(owner, role.id);
		expect(service.listRoles(owner.tenantId).map((entry) => entry.key)).toEqual(
			['owner', 'member'],
		);
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
		const role = service.createRole(owner, {
			tenantId: owner.tenantId,
			key: 'auditor',
			name: 'Auditor',
			description: '',
			scopes: ['auth.audit.read'],
		});
		expect(
			service.listRoles(otherActor.tenantId).map((entry) => entry.key),
		).toEqual(['owner', 'member']);
		expect(() =>
			service.updateRole(otherActor, {
				tenantId: otherActor.tenantId,
				id: role.id,
				name: 'Stolen',
			}),
		).toThrow(/does not exist/);
		expect(() => service.deleteRole(otherActor, role.id)).toThrow(
			/does not exist/,
		);
		expect(() =>
			service.assignMemberRole(otherActor, owner.accountId, 'auditor'),
		).toThrow(/not a member/);
	});

	it('records an audit trail for administrative actions', async () => {
		const { service, owner, member } = await workspace();
		service.updateMemberDisplayName(owner, member.accountId, 'Renamed Member');
		service.assignMemberRole(owner, member.accountId, 'owner');
		const page = service.queryAudit({ tenantId: owner.tenantId, limit: 10 });
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
			databasePath: ':memory:',
			secureCookies: false,
			sessionTtlMs: 3_600_000,
			allowSignUp: true,
			emailConfirmation: false,
			signInProviders: [],
		});
		const issued = await runtime.service().signUp({
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
		const events = runtime
			.service()
			.queryAudit({ tenantId, limit: 10 })
			.events.filter((event) => event.action === 'settings.updated');
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({
			actorLabel: 'owner@example.com',
			subjectType: 'setting',
			subjectId: 'auth.core.sessionIdleMinutes',
			metadata: { cleared: true },
		});
		expect(events[1]?.metadata).toEqual({ cleared: false });
	});
});
