import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/services/auth-service.ts';
import { fastHash } from './helpers.ts';
import {
	closeAuthTestDatabases,
	createAuthTestDatabase,
	type AuthTestDatabase,
} from './support/database.ts';

let database: AuthTestDatabase | undefined;
afterEach(async () => {
	await database?.dispose();
	database = undefined;
});
afterAll(closeAuthTestDatabases);

const scope = 'workflows.definitions.read';
async function fixture() {
	database = await createAuthTestDatabase();
	const service = new AuthService(database.repository, {
		passwordHash: fastHash,
	});
	const owner = (
		await service.signUp({
			email: 'owner@example.test',
			password: 'fixture password',
			displayName: 'Owner',
			organizationName: 'Scope workspace',
			organizationSlug: 'scope-workspace',
		})
	).principal;
	return { service, owner, database };
}

describe('module scope grants', () => {
	it('does not lose a module grant while a new owner is being created', async () => {
		const { service, owner, database } = await fixture();
		let arrived!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			arrived = resolve;
		});
		const proceed = new Promise<void>((resolve) => {
			release = resolve;
		});
		const create = database.repository.createAccountInTenant.bind(
			database.repository,
		);
		const delayed = vi
			.spyOn(database.repository, 'createAccountInTenant')
			.mockImplementation(async (record) => {
				arrived();
				await proceed;
				return create(record);
			});
		const creating = service.createTenantMember(
			{
				tenantId: owner.tenantId,
				email: 'pending@example.test',
				password: 'fixture password',
				displayName: 'Pending owner',
				role: 'owner',
			},
			owner,
		);
		try {
			await entered;
			await service.grantModuleScopes([scope]);
		} finally {
			release();
			delayed.mockRestore();
		}
		expect((await creating).scopes).toContain(scope);
	});

	it('persists the grant in the owner role for later owners, without widening members', async () => {
		const { service, owner } = await fixture();
		await service.grantModuleScopes([scope, scope, 'invalid scope']);
		const second = await service.createTenantMember(
			{
				tenantId: owner.tenantId,
				email: 'second@example.test',
				password: 'fixture password',
				displayName: 'Second owner',
				role: 'owner',
			},
			owner,
		);
		const member = await service.createTenantMember(
			{
				tenantId: owner.tenantId,
				email: 'member@example.test',
				password: 'fixture password',
				displayName: 'Member',
				role: 'member',
			},
			owner,
		);
		expect(second.scopes).toContain(scope);
		expect(member.scopes).not.toContain(scope);
		const roles = await service.listRoles(owner.tenantId);
		expect(roles.find((role) => role.key === 'owner')?.scopes).toContain(scope);
		expect(roles.find((role) => role.key === 'member')?.scopes).not.toContain(
			scope,
		);
		expect(second.scopes).not.toContain('invalid scope');
		expect(await service.grantModuleScopes([scope])).toEqual([]);
	});

	it('repairs the owner role even when an earlier membership-only grant already exists', async () => {
		const { service, owner } = await fixture();
		await service.grantMembershipScopes(owner.accountId, owner.tenantId, [
			scope,
		]);
		expect(await service.grantModuleScopes([scope])).toEqual([]);
		expect(
			(await service.listRoles(owner.tenantId)).find(
				(role) => role.key === 'owner',
			)?.scopes,
		).toContain(scope);
	});

	it('rereads the owner role when adding an existing account or promoting a member', async () => {
		const { service, owner, database } = await fixture();
		const role = (await database.repository.findRoleByKey(
			owner.tenantId,
			'owner',
		))!;
		const other = (
			await service.signUp({
				email: 'joining@example.test',
				password: 'fixture password',
				displayName: 'Joining owner',
				organizationName: 'Joining workspace',
				organizationSlug: 'joining-workspace',
			})
		).principal;
		const member = await service.createTenantMember(
			{
				tenantId: owner.tenantId,
				email: 'promoted@example.test',
				password: 'fixture password',
				displayName: 'Promoted member',
				role: 'member',
			},
			owner,
		);
		await service.grantModuleScopes([scope]);
		const joined = await database.repository.createMembershipInTenant({
			accountId: other.accountId,
			tenantId: owner.tenantId,
			role: 'owner',
			roleId: role.id,
			scopes: role.scopes,
			createdAt: Date.now(),
		});
		expect(joined.scopes).toContain(scope);
		await database.repository.updateMembershipRole(
			member.accountId,
			owner.tenantId,
			'owner',
			role.id,
			role.scopes,
		);
		expect(
			await service.listMembershipScopes(member.accountId, owner.tenantId),
		).toContain(scope);
		const memberRole = (await database.repository.findRoleByKey(
			owner.tenantId,
			'member',
		))!;
		await database.repository.updateMembershipRole(
			member.accountId,
			owner.tenantId,
			'member',
			memberRole.id,
			['auth.profile.read'],
		);
		expect(
			await service.listMembershipScopes(member.accountId, owner.tenantId),
		).toEqual(['auth.profile.read']);
	});

	it('keeps a new workspace outside prior grants and preserves each tenant member ceiling', async () => {
		const { service, owner } = await fixture();
		await service.grantModuleScopes([scope]);
		const other = (
			await service.signUp({
				email: 'other@example.test',
				password: 'fixture password',
				displayName: 'Other owner',
				organizationName: 'Other workspace',
				organizationSlug: 'other-workspace',
			})
		).principal;
		expect(other.scopes).not.toContain(scope);
		const granted = await service.grantModuleScopes([scope]);
		expect(granted).toEqual([
			{
				tenantId: other.tenantId,
				accountId: other.accountId,
				granted: [scope],
			},
		]);
		for (const tenantId of [owner.tenantId, other.tenantId]) {
			expect(
				(await service.listRoles(tenantId)).find((role) => role.key === 'owner')
					?.scopes,
			).toContain(scope);
		}
	});

	it('unions concurrent module grants and reports only newly inserted membership scopes', async () => {
		const { service, owner } = await fixture();
		const second = 'workflows.definitions.manage';
		await Promise.all([
			service.grantModuleScopes([scope]),
			service.grantModuleScopes([second]),
		]);
		expect(
			await service.listMembershipScopes(owner.accountId, owner.tenantId),
		).toEqual(expect.arrayContaining([scope, second]));
		expect(
			(await service.listRoles(owner.tenantId)).find(
				(role) => role.key === 'owner',
			)?.scopes,
		).toEqual(expect.arrayContaining([scope, second]));
		expect(await service.grantModuleScopes([scope, second])).toEqual([]);
	});

	it('rolls the owner role back when membership insertion fails', async () => {
		const { service, owner, database } = await fixture();
		const before = await service.listRoles(owner.tenantId);
		const lease = await database.provider.acquire({
			namespace: 'auth.core',
			purpose: 'migration',
		});
		try {
			await lease.database.execute({
				text: `ALTER TABLE auth_membership_scopes ADD CONSTRAINT owner_scope_grant_fixture CHECK (scope <> 'workflows.definitions.read')`,
			});
			await expect(service.grantModuleScopes([scope])).rejects.toThrow();
			expect(await service.listRoles(owner.tenantId)).toEqual(before);
			expect(
				await service.listMembershipScopes(owner.accountId, owner.tenantId),
			).not.toContain(scope);
		} finally {
			await lease.database.execute({
				text: 'ALTER TABLE auth_membership_scopes DROP CONSTRAINT owner_scope_grant_fixture',
			});
			await lease.release();
		}
	});
});
