import {
	createDatabaseProvider,
	databaseProviderConfigFromEnvironment,
	type ConfiguredDatabaseProvider,
	type DatabaseProviderConfig,
	type DatabaseProviderFactories,
} from '@flowdular/sdk/database';
import { createPgliteCluster } from '@flowdular/sdk/database-pglite';
import { Pool } from 'pg';

export { databaseProviderConfigFromEnvironment };

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
