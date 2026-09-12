import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import { AccessService } from '../services/access-service.ts';
import {
	DatabaseAccessRepository,
	migrateAccessDatabase,
} from '../services/database-repository.ts';
import type { AccessDirectory } from '../services/directory.ts';
import type { AccessRepository } from '../services/repository.ts';

export interface AccessRuntimeOptions {
	/** Platform-owned provider. Modules never receive a DSN or a pool. */
	readonly databases: DatabaseProvider;
	readonly purpose: Exclude<DatabaseProviderRequest['purpose'], 'migration'>;
	/** Where who-holds-what is read from; auth.core in a composed platform. */
	readonly directory: AccessDirectory;
	readonly now?: () => number;
	/** Supplied by tests that own the lease themselves. */
	readonly repository?: AccessRepository;
}

export interface AccessRuntime {
	service(): Promise<AccessService>;
	dispose(): Promise<void>;
}

export function createAccessRuntime(
	options: AccessRuntimeOptions,
): AccessRuntime {
	let disposed = false;
	let runtimeLeasePromise: Promise<DatabaseAdapterLease> | undefined;
	let servicePromise: Promise<AccessService> | undefined;

	const build = (repository: AccessRepository): AccessService =>
		new AccessService({
			repository,
			directory: options.directory,
			...(options.now ? { now: options.now } : {}),
		});

	/* Schema work runs on the migrator role and that lease is released before the
	   runtime one is taken, so request handling never holds a schema owner. */
	const initialize = async (): Promise<AccessService> => {
		if (options.repository) return build(options.repository);
		const migrationLease = await options.databases.acquire({
			namespace: 'access.core',
			purpose: 'migration',
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [
					DATABASE_CAPABILITY_IDS.MIGRATION_LOCK,
					DATABASE_CAPABILITY_IDS.SCHEMA_INTROSPECTION,
					DATABASE_CAPABILITY_IDS.TRANSACTIONAL_DDL,
				],
			},
		});
		try {
			await migrateAccessDatabase(migrationLease.database);
		} finally {
			await migrationLease.release();
		}
		runtimeLeasePromise = options.databases.acquire({
			namespace: 'access.core',
			purpose: options.purpose,
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [
					DATABASE_CAPABILITY_IDS.TRANSACTIONS,
					DATABASE_CAPABILITY_IDS.TENANT_CONTEXT,
				],
			},
		});
		const lease = await runtimeLeasePromise;
		return build(new DatabaseAccessRepository(lease.database));
	};

	return {
		service: () => {
			if (disposed) {
				return Promise.reject(new Error('Access runtime is disposed.'));
			}
			servicePromise ??= initialize();
			return servicePromise;
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			if (!runtimeLeasePromise) {
				await servicePromise?.catch(() => undefined);
			}
			if (!runtimeLeasePromise) return;
			const lease = await runtimeLeasePromise;
			await lease.release();
			runtimeLeasePromise = undefined;
			servicePromise = undefined;
		},
	};
}
