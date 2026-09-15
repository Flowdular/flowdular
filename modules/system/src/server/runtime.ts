import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import {
	DatabaseModuleActivationRepository,
	migrateSystemDatabase,
} from '../services/database-repository.ts';
import {
	ModuleActivationService,
	type ModuleActivationServiceOptions,
} from '../services/module-activation-service.ts';
import type { ModuleActivationRepository } from '../services/repository.ts';

export interface SystemRuntimeOptions
	extends Omit<ModuleActivationServiceOptions, 'repository'> {
	/** Platform-owned provider. Modules never receive a DSN or a pool. */
	readonly databases: DatabaseProvider;
	readonly purpose: Exclude<DatabaseProviderRequest['purpose'], 'migration'>;
	/** Supplied by tests that own the lease themselves. */
	readonly repository?: ModuleActivationRepository;
}

export interface SystemRuntime {
	service(): Promise<ModuleActivationService>;
	dispose(): Promise<void>;
}

export function createSystemRuntime(
	options: SystemRuntimeOptions,
): SystemRuntime {
	let disposed = false;
	let runtimeLeasePromise: Promise<DatabaseAdapterLease> | undefined;
	let servicePromise: Promise<ModuleActivationService> | undefined;
	const { databases, purpose, repository, ...serviceOptions } = options;

	const build = (store: ModuleActivationRepository): ModuleActivationService =>
		new ModuleActivationService({ ...serviceOptions, repository: store });

	/* Schema work runs on the migrator role and that lease is released before the
	   runtime one is taken, so request handling never holds a schema owner. */
	const initialize = async (): Promise<ModuleActivationService> => {
		if (repository) return build(repository);
		const migrationLease = await databases.acquire({
			namespace: 'system.core',
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
			await migrateSystemDatabase(migrationLease.database);
		} finally {
			await migrationLease.release();
		}
		runtimeLeasePromise = databases.acquire({
			namespace: 'system.core',
			purpose,
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [
					DATABASE_CAPABILITY_IDS.TRANSACTIONS,
					DATABASE_CAPABILITY_IDS.TENANT_CONTEXT,
				],
			},
		});
		const lease = await runtimeLeasePromise;
		return build(new DatabaseModuleActivationRepository(lease.database));
	};

	return {
		service: () => {
			if (disposed) {
				return Promise.reject(new Error('System runtime is disposed.'));
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
