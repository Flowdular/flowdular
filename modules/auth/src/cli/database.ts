import { resolve } from 'node:path';
import {
	createDatabaseProvider,
	databaseProviderConfigFromEnvironment,
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseProvider,
	type DatabaseProviderConfig,
} from '@flowdular/database';
import { createPgliteCluster } from '@flowdular/database-pglite';
import { Pool } from 'pg';

export const MIGRATION_REQUIREMENTS = {
	dialectIds: [DATABASE_DIALECT_IDS.postgresql],
	capabilities: [
		DATABASE_CAPABILITY_IDS.MIGRATION_LOCK,
		DATABASE_CAPABILITY_IDS.SCHEMA_INTROSPECTION,
		DATABASE_CAPABILITY_IDS.TRANSACTIONAL_DDL,
	],
} as const;

export interface CliDatabase {
	readonly config: DatabaseProviderConfig;
	/** Where the data lives, for the evidence an operator command reports. */
	readonly location: string;
	create(): DatabaseProvider;
}

/* The CLI protocol carries no provider, so an operator command opens the same
   database the platform would open from this workspace and this environment.
   The drivers are supplied here for the same reason the deployable supplies
   them: @flowdular/database owns none. */
export function localDatabaseProvider(workspaceRoot: string): CliDatabase {
	const config = databaseProviderConfigFromEnvironment(
		process.env,
		workspaceRoot,
	);
	return {
		config,
		location:
			config.adapter === 'pglite'
				? (config.pglite?.dataDirectory ??
					resolve(workspaceRoot, '.flowdular', 'data', 'pglite'))
				: 'the configured PostgreSQL database',
		create: () =>
			createDatabaseProvider(config, {
				postgresPool: (options) => new Pool(options),
				pgliteCluster: (options) => createPgliteCluster(options),
			}),
	};
}
