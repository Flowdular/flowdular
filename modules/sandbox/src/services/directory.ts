import type { AuthRuntime } from '@flowdular/module-auth/server';

export interface SandboxDirectoryMember {
	readonly accountId: string;
	readonly email: string;
	readonly displayName: string;
	readonly role: string;
	readonly status: 'active' | 'disabled';
}

/* The only cross-module read sandbox.core performs. It uses the auth.core
   service contract and never opens the authentication database. */
export interface SandboxDirectory {
	listMembers(tenantId: string): Promise<readonly SandboxDirectoryMember[]>;
	listScopes(accountId: string, tenantId: string): Promise<readonly string[]>;
	/** The scopes of many members in one auth read, keyed by account id. */
	listScopesForMembers(
		accountIds: readonly string[],
		tenantId: string,
	): Promise<ReadonlyMap<string, readonly string[]>>;
}

export function directoryFromAuthRuntime(auth: AuthRuntime): SandboxDirectory {
	return {
		listMembers: async (tenantId) =>
			(await (await auth.service()).listTenantMembers(tenantId)).map(
				(member) => ({
					accountId: member.accountId,
					email: member.email,
					displayName: member.displayName,
					role: member.role,
					status: member.status,
				}),
			),
		listScopes: async (accountId, tenantId) =>
			(await auth.service()).listMembershipScopes(accountId, tenantId),
		listScopesForMembers: async (accountIds, tenantId) => {
			const wanted = new Set(accountIds);
			const scopes = new Map<string, readonly string[]>();
			for (const member of await (
				await auth.service()
			).listTenantMembers(tenantId)) {
				if (wanted.has(member.accountId))
					scopes.set(member.accountId, member.scopes);
			}
			return scopes;
		},
	};
}
