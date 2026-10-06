import type { DatabaseProvider } from '@flowdular/sdk/database';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
} from '@flowdular/sdk/modules/auth/server';
import { readModuleCatalog } from '@flowdular/sdk/modules/system/server';
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
	/** Enabled modules whose permissions setup could not grant to the owner. */
	readonly ungrantedModules: readonly string[];
}

export class SetupSeedError extends Error {
	constructor(
		readonly code: 'DATABASE_NOT_EMPTY' | 'SETUP_IN_PROGRESS',
		message: string,
	) {
		super(message);
		this.name = 'SetupSeedError';
	}
}

/* A driver message can carry a host or a connection string, so only a code
   from a fixed alphabet is logged, such as a SQLSTATE or an errno name. */
function stableCode(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
	return error instanceof Error ? error.name : 'unknown';
}

/**
 * Migrates auth.core, then creates the chosen workspace and its owner, and
 * grants that owner the permissions the enabled modules declare. The database
 * must still have no workspace, so a stale session cannot re-provision an
 * existing installation.
 */
export async function seedFirstRun(
	databases: DatabaseProvider,
	environment: NodeJS.ProcessEnv,
	workspaceRoot: string,
	owner: FirstRunOwner,
): Promise<FirstRunSeed> {
	const enabled = readModuleCatalog(workspaceRoot).filter(
		(entry) => entry.enabled,
	);
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
		/* An application's own modules declare permissions the owner defaults
		   cannot carry, and the grant module enable runs found no workspace
		   before this one. The workspace is committed and first run is over, so
		   a failed grant is reported with its repair command rather than failing
		   a setup that cannot run again. */
		const held = new Set(provisioned.owner.scopes);
		const pending = enabled.filter((entry) =>
			entry.permissions.some((permission) => !held.has(permission.id)),
		);
		let scopes = provisioned.owner.scopes;
		let ungrantedModules: readonly string[] = [];
		if (pending.length > 0) {
			try {
				const grants = await service.grantModuleScopes(
					pending.flatMap((entry) =>
						entry.permissions.map((permission) => permission.id),
					),
				);
				scopes = [
					...scopes,
					...(grants.find(
						(grant) => grant.accountId === provisioned.owner.accountId,
					)?.granted ?? []),
				];
			} catch (error) {
				ungrantedModules = pending.map((entry) => entry.id);
				console.warn(
					`First-run setup could not grant the owner the permissions of ${ungrantedModules.join(', ')} (${stableCode(error)}).`,
				);
			}
		}
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
					scopes,
				},
			],
			ungrantedModules,
		};
	} finally {
		await runtime.dispose();
	}
}

/**
 * Runs a first-run seed under a PostgreSQL advisory lock, so two processes on
 * one database cannot both pass the empty check above and each create a first
 * workspace. A second claimant is refused, not queued. The lock is held by its
 * own transaction, and the seed runs outside that transaction's async context
 * because an adapter refuses nested use from inside one.
 */
export async function claimFirstRun<T>(
	databases: DatabaseProvider,
	seed: () => Promise<T>,
): Promise<T> {
	const lease = await databases.acquire({
		namespace: 'platform.setup',
		purpose: 'migration',
	});
	try {
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let report!: (claimed: boolean) => void;
		const reported = new Promise<boolean>((resolve) => {
			report = resolve;
		});
		const held = lease.database.transaction(async (transaction) => {
			const result = await transaction.query<{ claimed: boolean }>({
				text: 'SELECT pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) AS claimed',
				parameters: ['flowdular-first-run', 'platform.setup'],
			});
			report(result.rows[0]?.claimed === true);
			await released;
		});
		if (!(await Promise.race([reported, held.then(() => false)]))) {
			release();
			await held;
			throw new SetupSeedError(
				'SETUP_IN_PROGRESS',
				'Another setup is creating the first workspace right now. Wait a moment, then reload this page.',
			);
		}
		try {
			return await seed();
		} finally {
			release();
			/* The lock transaction writes nothing, so once the seed has settled a
			   failure to end it cannot change the outcome. */
			await held.catch(() => undefined);
		}
	} finally {
		await lease.release();
	}
}
