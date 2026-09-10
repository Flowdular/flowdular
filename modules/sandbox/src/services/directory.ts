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
	};
}
