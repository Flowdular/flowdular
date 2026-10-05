import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { AuthActor } from '../src/domain/types.ts';
import { AuthService } from '../src/services/auth-service.ts';
import { fastHash } from './helpers.ts';
import {
	closeAuthTestDatabases,
	createAuthTestDatabase,
	type AuthTestDatabase,
} from './support/database.ts';

const OWNER_DECISIONS = [
	'decisions.definitions.read',
	'decisions.definitions.manage',
	'decisions.invocations.manage',
	'decisions.invocations.read',
	'decisions.connections.manage',
	'decisions.connections.read',
].sort();
const MEMBER_DECISIONS = [
	'decisions.definitions.read',
	'decisions.invocations.read',
].sort();

let database: AuthTestDatabase | undefined;
afterEach(async () => {
	await database?.dispose();
	database = undefined;
});
afterAll(closeAuthTestDatabases);

async function fixture() {
	database = await createAuthTestDatabase();
	return new AuthService(database.repository, { passwordHash: fastHash });
}

function decisions(scopes: readonly string[]): string[] {
	return scopes.filter((scope) => scope.startsWith('decisions.')).sort();
}

function actor(principal: {
	readonly accountId: string;
	readonly tenantId: string;
	readonly email: string;
	readonly scopes: readonly string[];
}): AuthActor {
	return {
		accountId: principal.accountId,
		tenantId: principal.tenantId,
		email: principal.email,
		role: 'owner',
		scopes: principal.scopes,
	};
}

describe('decisions.core default scopes', () => {
	it('AUTH-DECISIONS-NEW-WORKSPACE-SCOPES seeds sign-up and operator workspaces, built-in roles, and no custom role', async () => {
		const service = await fixture();
		const signedUp = (
			await service.signUp({
				email: 'signup-owner@example.test',
				password: 'correct horse battery staple',
				displayName: 'Sign-up Owner',
				organizationName: 'Sign-up workspace',
				organizationSlug: 'signup-workspace',
			})
		).principal;
		const provisioned = await service.provisionWorkspace({
			name: 'Provisioned workspace',
			slug: 'provisioned-workspace',
			ownerEmail: 'operator-owner@example.test',
			ownerDisplayName: 'Operator Owner',
			password: 'operator chosen password',
			operator: 'cli:operator',
		});

		for (const [tenantId, owner] of [
			[signedUp.tenantId, signedUp],
			[
				provisioned.workspace.tenantId,
				{ ...provisioned.owner, tenantId: provisioned.workspace.tenantId },
			],
		] as const) {
			expect(decisions(owner.scopes)).toEqual(OWNER_DECISIONS);
			const roles = await service.listRoles(tenantId);
			expect(
				decisions(roles.find((role) => role.key === 'owner')!.scopes),
			).toEqual(OWNER_DECISIONS);
			expect(
				decisions(roles.find((role) => role.key === 'member')!.scopes),
			).toEqual(MEMBER_DECISIONS);
			const member = await service.createTenantMember(
				{
					tenantId,
					email: 'member-' + tenantId + '@example.test',
					password: 'steady tangerine harbor',
					displayName: 'Member',
					role: 'member',
				},
				actor(owner),
			);
			expect(decisions(member.scopes)).toEqual(MEMBER_DECISIONS);
			const custom = await service.createRole(actor(owner), {
				tenantId,
				key: 'reader',
				name: 'Reader',
				description: 'A workspace-defined role',
				scopes: ['auth.profile.read'],
			});
			expect(decisions(custom.scopes)).toEqual([]);
		}
	});

	it('AUTH-DECISIONS-EXPLICIT-INVOCATION-GRANT keeps the built-in member and issued tokens below an explicit custom role', async () => {
		const service = await fixture();
		const owner = (
			await service.signUp({
				email: 'owner@example.test',
				password: 'correct horse battery staple',
				displayName: 'Owner',
				organizationName: 'Decision workspace',
				organizationSlug: 'decision-workspace',
			})
		).principal;
		const member = await service.createTenantMember(
			{
				tenantId: owner.tenantId,
				email: 'member@example.test',
				password: 'steady tangerine harbor',
				displayName: 'Member',
				role: 'member',
			},
			actor(owner),
		);
		expect(decisions(member.scopes)).toEqual(MEMBER_DECISIONS);
		expect(member.scopes).not.toContain('decisions.invocations.manage');
		expect(member.scopes).not.toContain('decisions.connections.read');

		const readToken = await service.issueApiToken({
			tenantId: owner.tenantId,
			accountId: member.accountId,
			label: 'Read only decisions',
			scopes: ['decisions.definitions.read', 'decisions.invocations.manage'],
			expiresAt: null,
			createdBy: owner.accountId,
		});
		expect(
			decisions((await service.resolveApiToken(readToken.token))!.scopes),
		).toEqual(['decisions.definitions.read']);

		const role = await service.createRole(actor(owner), {
			tenantId: owner.tenantId,
			key: 'invoker',
			name: 'Invoker',
			description: 'Explicit decision invocation',
			scopes: ['decisions.invocations.manage'],
		});
		const assigned = await service.assignMemberRole(
			actor(owner),
			member.accountId,
			role.key,
		);
		expect(decisions(assigned.scopes)).toEqual([
			'decisions.invocations.manage',
		]);
		expect(
			decisions((await service.resolveApiToken(readToken.token))?.scopes ?? []),
		).toEqual([]);
		const invokeToken = await service.issueApiToken({
			tenantId: owner.tenantId,
			accountId: member.accountId,
			label: 'Explicit invocation',
			scopes: ['decisions.invocations.manage'],
			expiresAt: null,
			createdBy: owner.accountId,
		});
		expect(
			decisions((await service.resolveApiToken(invokeToken.token))!.scopes),
		).toEqual(['decisions.invocations.manage']);
		await service.assignMemberRole(actor(owner), member.accountId, 'member');
		expect(await service.resolveApiToken(invokeToken.token)).toBeNull();
	});
});
