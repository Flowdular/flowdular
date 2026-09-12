import type {
	AuthActor,
	CreateTenantMemberWithoutPasswordInput,
	TenantMember,
} from '@flowdular/module-auth';
import type { AuthRuntime } from '@flowdular/module-auth/server';

/**
 * Exactly the auth.core administration surface directory.core uses. Accounts,
 * memberships, roles and their audit trail stay auth.core's; this module owns
 * only the SCIM mapping and never opens another module's database.
 */
export interface DirectoryAuthPort {
	/** Resolves the `:workspace` path segment to a trusted tenant id. */
	findTenantId(reference: string): Promise<string | null>;
	/** A provisioned user signs in through a provider, so one has to be enabled. */
	hasEnabledIdentityProvider(tenantId: string): Promise<boolean>;
	listRoleKeys(tenantId: string): Promise<readonly string[]>;
	listMembers(tenantId: string): Promise<readonly TenantMember[]>;
	/** Active memberships of the account behind an address, across workspaces. */
	countAccountMemberships(email: string): Promise<number | null>;
	/** Creates a member holding no password; only a provider can sign it in. */
	createMember(
		actor: AuthActor,
		input: {
			readonly email: string;
			readonly displayName: string;
			readonly role: string;
		},
	): Promise<TenantMember>;
	setDisplayName(
		actor: AuthActor,
		accountId: string,
		displayName: string,
	): Promise<void>;
	assignRole(
		actor: AuthActor,
		accountId: string,
		roleKey: string,
	): Promise<void>;
	setMembershipStatus(
		actor: AuthActor,
		accountId: string,
		status: 'active' | 'disabled',
	): Promise<void>;
}

/**
 * A SCIM operation acts as the token, not as a person. The port only accepts
 * `AuthActor`, so the token id travels in both identity fields and reaches the
 * auth trail as the actor label; there is no service-actor entry point on the
 * administration port yet.
 */
export function scimActor(tenantId: string, tokenId: string): AuthActor {
	const identity = `scim-token:${tokenId}`;
	return {
		accountId: identity,
		tenantId,
		email: identity,
		/* The token is created by an owner and inherits that authority, so it can
		   act on owners; the last-owner rule inside auth.core still refuses the
		   change that would leave the workspace without one. */
		role: 'owner',
		scopes: [],
	};
}

export function authPortFromRuntime(auth: AuthRuntime): DirectoryAuthPort {
	return {
		async findTenantId(reference) {
			return (
				(await (await auth.service()).findTenant(reference))?.tenantId ?? null
			);
		},
		async hasEnabledIdentityProvider(tenantId) {
			const service = await auth.service();
			if ((await service.identityProviders.listEnabled(tenantId)).length > 0) {
				return true;
			}
			/* A deployment-wide provider is offered to every workspace, so it
			   satisfies the same requirement as a workspace-owned one. */
			return auth.oidcProviders.length > 0;
		},
		async listRoleKeys(tenantId) {
			return (await (await auth.service()).listRoles(tenantId)).map(
				(role) => role.key,
			);
		},
		async listMembers(tenantId) {
			return (await auth.service()).listTenantMembers(tenantId);
		},
		async countAccountMemberships(email) {
			const access = await (await auth.service()).findAccountAccess(email);
			return access === null ? null : access.tenants.length;
		},
		async createMember(actor, input) {
			/* No secret is drawn at all: auth.core stores an unusable credential
			   marker, so no password can match it and none can leak. The member
			   signs in through an identity provider of the workspace; where the
			   workspace has none enabled, the public password reset is the
			   activation path that sets the first one (D-SCIM-RESET). */
			const record: CreateTenantMemberWithoutPasswordInput = {
				tenantId: actor.tenantId,
				email: input.email,
				displayName: input.displayName,
				role: input.role,
			};
			return (await auth.service()).createTenantMemberWithoutPassword(
				record,
				actor,
			);
		},
		async setDisplayName(actor, accountId, displayName) {
			await (
				await auth.service()
			).updateMemberDisplayName(actor, accountId, displayName);
		},
		async assignRole(actor, accountId, roleKey) {
			await (await auth.service()).assignMemberRole(actor, accountId, roleKey);
		},
		async setMembershipStatus(actor, accountId, status) {
			await (
				await auth.service()
			).setMembershipStatus(actor, accountId, status);
		},
	};
}
