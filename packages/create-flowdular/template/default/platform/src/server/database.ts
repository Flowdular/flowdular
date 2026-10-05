import {
	createDatabaseProvider,
	databaseProviderConfigFromEnvironment,
	type ConfiguredDatabaseProvider,
	type DatabaseProviderConfig,
	type DatabaseProviderFactories,
} from '@flowdular/sdk/database';
import { createPgliteCluster } from '@flowdular/sdk/database-pglite';
import { Pool } from 'pg';
import process from 'node:process';
import { resolve } from 'node:path';

export { databaseProviderConfigFromEnvironment };
export type PlatformDatabaseProvider = ConfiguredDatabaseProvider;

/* The deployable owns both PostgreSQL drivers: node-postgres for a deployment
   and the embedded build for a local run. @flowdular/sdk/database stays driver free,
   so every caller supplies them the same way. */
export function createPlatformDatabaseProvider(
	config: DatabaseProviderConfig,
	factories: DatabaseProviderFactories = {},
): ConfiguredDatabaseProvider {
	return createDatabaseProvider(config, {
		postgresPool: (options) => new Pool(options),
		pgliteCluster: (options) => createPgliteCluster(options),
		...factories,
	});
}

/** A missing PostgreSQL URL is an unconfigured installation. */
export function platformDatabaseConfigured(
	environment: NodeJS.ProcessEnv,
): boolean {
	const adapter =
		environment.FD_DATABASE_ADAPTER?.trim() ||
		(environment.NODE_ENV === 'production' ? 'postgresql' : 'pglite');
	return (
		adapter !== 'postgresql' || Boolean(environment.FD_DATABASE_URL?.trim())
	);
}

/** An orchestrator's environment takes precedence over the generated .env. */
export function loadPlatformEnvironmentFile(workspaceRoot: string): void {
	try {
		process.loadEnvFile(resolve(workspaceRoot, '.env'));
	} catch {
		// Container deployments configure the process without a workspace .env.
	}
}
