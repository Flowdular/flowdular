import {
	createDatabaseProvider,
	databaseProviderConfigFromEnvironment,
	databaseResetPlan,
	resetDatabase,
	type ConfiguredDatabaseProvider,
	type DatabaseProviderConfig,
} from '@flowdular/database';
import {
	failure,
	success,
	type CommandEnvelope,
} from '@flowdular/cli-protocol';
import { createPgliteCluster } from '@flowdular/database-pglite';
import { Pool } from 'pg';
import type { Workspace } from './workspace.ts';

interface NamespaceReset {
	readonly namespace: string;
	readonly tables: readonly string[];
}

function enabledNamespaces(workspace: Workspace): readonly string[] {
	const enabled =
		(workspace.config.modules as { enabled?: string[] } | undefined)?.enabled ??
		[];
	return [...enabled].sort((left, right) => left.localeCompare(right));
}

/* The operator CLI owns the same drivers the deployable does, so a command sees
   exactly the database the application would open. */
export function createCliDatabaseProvider(
	config: DatabaseProviderConfig,
): ConfiguredDatabaseProvider {
	return createDatabaseProvider(config, {
		postgresPool: (options) => new Pool(options),
		pgliteCluster: (options) => createPgliteCluster(options),
	});
}

/* One shared database means one reset. Scoping it to a module would drop every
   other module's tables under a flag that promised not to. */
async function resetOne(
	databases: ConfiguredDatabaseProvider,
	namespace: string,
	apply: boolean,
): Promise<NamespaceReset> {
	const lease = await databases.acquire({ namespace, purpose: 'migration' });
	try {
		const tables = await databaseResetPlan(lease.database);
		if (apply && tables.length > 0) {
			await resetDatabase(lease.database, {
				intent: 'confirmed-destructive-reset',
			});
		}
		return { namespace, tables };
	} finally {
		await lease.release();
	}
}

export async function databaseReset(
	workspace: Workspace,
	moduleId: string | undefined,
	apply: boolean,
): Promise<CommandEnvelope> {
	let config: DatabaseProviderConfig;
	try {
		config = databaseProviderConfigFromEnvironment(process.env, workspace.root);
	} catch (error) {
		return failure(
			'DATABASE_CONFIGURATION_INVALID',
			error instanceof Error ? error.message : String(error),
		);
	}
	const namespaces = enabledNamespaces(workspace);
	if (moduleId && !namespaces.includes(moduleId)) {
		return failure(
			'MODULE_NOT_ENABLED',
			`"${moduleId}" is not an enabled module of this workspace.`,
		);
	}
	if (moduleId) {
		return failure(
			'SCOPE_UNSUPPORTED',
			`Every module shares one database, so a reset cannot be scoped to ${moduleId}. Run it without --module.`,
		);
	}
	/* One database holds every namespace, so a single lease already sees every
	   table and any enabled namespace names the same database. */
	const target = namespaces[0];
	if (!target) {
		return failure(
			'NO_ENABLED_MODULES',
			'This workspace has no enabled module, so there is no database to reset.',
		);
	}

	const databases = createCliDatabaseProvider(config);
	const results: NamespaceReset[] = [];
	try {
		results.push(await resetOne(databases, target, apply));
	} catch (error) {
		return failure(
			'DATABASE_RESET_FAILED',
			error instanceof Error ? error.message : String(error),
		);
	} finally {
		await databases.dispose();
	}

	const tables = results.reduce((total, one) => total + one.tables.length, 0);
	return success({
		adapter: config.adapter,
		applied: apply,
		namespaces: results,
		droppedTables: tables,
		evidence: results.map((one) => one.namespace),
		...(apply
			? {}
			: {
					note:
						tables === 0
							? 'No table would be dropped.'
							: `${tables} table(s) would be dropped. Use --apply --confirm reset-database to continue.`,
				}),
	});
}
