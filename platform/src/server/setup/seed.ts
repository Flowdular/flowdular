import type { DatabaseProvider } from '@flowdular/database';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
} from '@flowdular/module-auth/server';
import {
	GREENFIELD_ACCOUNTS,
	GREENFIELD_TENANTS,
	GREENFIELD_TENANT_SLUGS,
} from '@flowdular/module-auth/greenfield';

/* The demo accounts are defined once, by auth.core, so the product never ships
   two sets that drift apart. This seeds them into a database that has just
   been migrated; unlike "flowdular auth greenfield" it resets nothing and stops
   when it finds a workspace that already exists. */

export const FIRST_RUN_OPERATOR = 'setup:first-run';

export interface SeededAccount {
	readonly email: string;
	readonly password: string;
	readonly displayName: string;
	readonly role: string;
	readonly scopes: readonly string[];
}

export interface FirstRunSeed {
	readonly workspace: { readonly name: string; readonly slug: string };
	readonly accounts: readonly SeededAccount[];
}

export class SetupSeedError extends Error {
	constructor(
		readonly code: 'DATABASE_NOT_EMPTY',
		message: string,
	) {
		super(message);
		this.name = 'SetupSeedError';
	}
}

/**
 * Migrates auth.core, then creates the demo workspace, its owner, and one
 * reduced-scope member. Both accounts go through AuthService, so they hold the
 * scopes their role defines and every row the provisioning path audits.
 */
export async function seedFirstRun(
	databases: DatabaseProvider,
	environment: NodeJS.ProcessEnv,
	workspaceRoot: string,
): Promise<FirstRunSeed> {
	const runtime = createAuthRuntime({
		...authRuntimeOptionsFromEnvironment(environment, workspaceRoot),
		databases,
	});
	try {
		const service = await runtime.service();
		const existing = await service.listTenants();
		if (existing.length > 0) {
			throw new SetupSeedError(
				'DATABASE_NOT_EMPTY',
				`This database already holds ${existing.length} workspace${
					existing.length === 1 ? '' : 's'
				}. Setup does not reset an existing installation. Point this deployment at that database and sign in, or choose an empty one.`,
			);
		}
		const provisioned = await service.provisionWorkspace({
			name: GREENFIELD_TENANTS.operations,
			slug: GREENFIELD_TENANT_SLUGS.operations,
			ownerEmail: GREENFIELD_ACCOUNTS.admin.email,
			ownerDisplayName: GREENFIELD_ACCOUNTS.admin.displayName,
			password: GREENFIELD_ACCOUNTS.admin.password,
			operator: FIRST_RUN_OPERATOR,
		});
		const member = await service.createTenantMember(
			{
				tenantId: provisioned.workspace.tenantId,
				email: GREENFIELD_ACCOUNTS.user.email,
				displayName: GREENFIELD_ACCOUNTS.user.displayName,
				password: GREENFIELD_ACCOUNTS.user.password,
				role: 'member',
			},
			{
				accountId: provisioned.owner.accountId,
				tenantId: provisioned.workspace.tenantId,
				email: provisioned.owner.email,
				role: provisioned.owner.role,
				scopes: provisioned.owner.scopes,
			},
		);
		return {
			workspace: {
				name: provisioned.workspace.name,
				slug: provisioned.workspace.slug,
			},
			accounts: [
				{
					email: provisioned.owner.email,
					password: GREENFIELD_ACCOUNTS.admin.password,
					displayName: provisioned.owner.displayName,
					role: provisioned.owner.role,
					scopes: provisioned.owner.scopes,
				},
				{
					email: member.email,
					password: GREENFIELD_ACCOUNTS.user.password,
					displayName: member.displayName,
					role: member.role,
					scopes: member.scopes,
				},
			],
		};
	} finally {
		await runtime.dispose();
	}
}
