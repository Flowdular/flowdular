import type { DatabaseProvider } from '@flowdular/database';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
} from '@flowdular/module-auth/server';
/* First-run provisioning uses the same audited auth service as the operator
   CLI. The operator chooses the first owner; no demo credentials are shipped. */

export const FIRST_RUN_OPERATOR = 'setup:first-run';

export interface SeededAccount {
	readonly email: string;
	readonly displayName: string;
	readonly role: string;
	readonly scopes: readonly string[];
}

export interface FirstRunOwner {
	readonly workspaceName: string;
	readonly workspaceSlug: string;
	readonly ownerEmail: string;
	readonly ownerName: string;
	readonly ownerPassword: string;
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
 * Migrates auth.core, then creates the chosen workspace and its owner. The
 * database must still have no workspace, so a stale session cannot re-provision
 * an existing installation.
 */
export async function seedFirstRun(
	databases: DatabaseProvider,
	environment: NodeJS.ProcessEnv,
	workspaceRoot: string,
	owner: FirstRunOwner,
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
			name: owner.workspaceName,
			slug: owner.workspaceSlug,
			ownerEmail: owner.ownerEmail,
			ownerDisplayName: owner.ownerName,
			password: owner.ownerPassword,
			operator: FIRST_RUN_OPERATOR,
		});
		return {
			workspace: {
				name: provisioned.workspace.name,
				slug: provisioned.workspace.slug,
			},
			accounts: [
				{
					email: provisioned.owner.email,
					displayName: provisioned.owner.displayName,
					role: provisioned.owner.role,
					scopes: provisioned.owner.scopes,
				},
			],
		};
	} finally {
		await runtime.dispose();
	}
}
