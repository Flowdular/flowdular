import { flowdularEnvironment } from '@flowdular/kernel/runtime-config';
import process from 'node:process';
import { resolve } from 'node:path';
import {
	createDatabaseProvider,
	databaseProviderConfigFromEnvironment,
	type ConfiguredDatabaseAdapter,
	type ConfiguredDatabaseProvider,
	type DatabaseProviderConfig,
	type DatabaseProviderFactories,
	type DatabaseReadiness,
} from '@flowdular/database';
import { createPgliteCluster } from '@flowdular/database-pglite';
import { Pool } from 'pg';

export { databaseProviderConfigFromEnvironment };
export type {
	ConfiguredDatabaseAdapter as PlatformDatabaseAdapter,
	ConfiguredDatabaseProvider as PlatformDatabaseProvider,
	DatabaseProviderConfig as PlatformDatabaseProviderConfig,
	DatabaseProviderFactories as PlatformDatabaseProviderFactories,
	DatabaseReadiness as PlatformDatabaseReadiness,
};

/* The deployable owns both PostgreSQL drivers: node-postgres for a deployment
   and the embedded build for a local run. @flowdular/database stays driver free,
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

/**
 * Whether this deployment names a database at all. It decides which routes the
 * platform composes at boot: first-run setup, or the application.
 *
 * Only a deployment that names nothing is a first run. A configured database
 * that does not answer is an outage, and boot fails the way it does today,
 * because a running deployment must never fall back to a screen that can
 * re-point it.
 */
export function platformDatabaseConfigured(
	environment: NodeJS.ProcessEnv,
): boolean {
	environment = flowdularEnvironment(environment);
	const configured = environment.FD_DATABASE_ADAPTER?.trim();
	const adapter =
		configured && configured.length > 0
			? configured
			: environment.NODE_ENV === 'production'
				? 'postgresql'
				: 'pglite';
	/* The embedded database needs no connection details, so choosing it is
	   itself the configuration. An unknown adapter id is a configuration error
	   the provider reports; it is not an uninstalled deployment. */
	if (adapter !== 'postgresql') return true;
	return (environment.FD_DATABASE_URL?.trim() ?? '').length > 0;
}

/**
 * Loads `<workspaceRoot>/.env` into the process environment. A value the real
 * environment already sets wins, so an orchestrator always overrides a file the
 * first-run setup wrote earlier.
 */
export function loadPlatformEnvironmentFile(workspaceRoot: string): void {
	Object.assign(process.env, flowdularEnvironment(process.env));
	try {
		process.loadEnvFile(resolve(workspaceRoot, '.env'));
		Object.assign(process.env, flowdularEnvironment(process.env));
	} catch {
		/* Absent or unreadable. The real environment is the authority either
		   way, and a deployment that sets everything needs no file. */
	}
}
