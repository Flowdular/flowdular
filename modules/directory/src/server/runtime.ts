import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import type { DirectoryAuthPort } from '../services/auth-port.ts';
import {
	DatabaseDirectoryRepository,
	migrateDirectoryDatabase,
} from '../services/database-repository.ts';
import { DirectoryAdministrationService } from '../services/directory-service.ts';
import { ScimProvisioningService } from '../services/provisioning-service.ts';
import { ScimRateLimiter } from '../services/rate-limiter.ts';
import type { DirectoryRepository } from '../services/repository.ts';
import { ScimTokenService } from '../services/token-service.ts';

export interface DirectoryRuntimeOptions {
	/** Platform-owned provider. Modules never receive a DSN or a pool. */
	readonly databases: DatabaseProvider;
	readonly purpose: Exclude<DatabaseProviderRequest['purpose'], 'migration'>;
	/** The auth.core administration surface every provisioning write goes through. */
	readonly auth: DirectoryAuthPort;
	readonly now?: () => number;
	readonly limiter?: ScimRateLimiter;
	readonly repository?: DirectoryRepository;
}

export interface DirectoryRuntime {
	/** Lives with the runtime, so revoking a lease also drops its windows. */
	readonly limiter: ScimRateLimiter;
	tokens(): Promise<ScimTokenService>;
	provisioning(): Promise<ScimProvisioningService>;
	administration(): Promise<DirectoryAdministrationService>;
	dispose(): Promise<void>;
}

interface Services {
	readonly tokens: ScimTokenService;
	readonly provisioning: ScimProvisioningService;
	readonly administration: DirectoryAdministrationService;
}

export function createDirectoryRuntime(
	options: DirectoryRuntimeOptions,
): DirectoryRuntime {
	const now = options.now ?? Date.now;
	const limiter = options.limiter ?? new ScimRateLimiter();
	let disposed = false;
	let runtimeLeasePromise: Promise<DatabaseAdapterLease> | undefined;
	let servicesPromise: Promise<Services> | undefined;

	const compose = (repository: DirectoryRepository): Services => ({
		tokens: new ScimTokenService(repository, now),
		provisioning: new ScimProvisioningService(repository, options.auth, now),
		administration: new DirectoryAdministrationService(
			repository,
			options.auth,
			now,
		),
	});

	/* Schema work runs on the migrator role and that lease is released before the
	   runtime one is taken, so request handling never holds a schema owner. */
	const initialize = async (): Promise<Services> => {
		if (options.repository) return compose(options.repository);
		const migrationLease = await options.databases.acquire({
			namespace: 'directory.core',
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
			await migrateDirectoryDatabase(migrationLease.database);
		} finally {
			await migrationLease.release();
		}
		runtimeLeasePromise = options.databases.acquire({
			namespace: 'directory.core',
			purpose: options.purpose,
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
			},
		});
		const lease = await runtimeLeasePromise;
		return compose(new DatabaseDirectoryRepository(lease.database));
	};

	const services = (): Promise<Services> => {
		if (disposed) {
			return Promise.reject(new Error('Directory runtime is disposed.'));
		}
		return (servicesPromise ??= initialize());
	};

	return {
		limiter,
		tokens: async () => (await services()).tokens,
		provisioning: async () => (await services()).provisioning,
		administration: async () => (await services()).administration,
		async dispose() {
			if (disposed) return;
			disposed = true;
			/* An initialization still in flight would assign its lease after this
			   read, so settle it first; a failed open must not surface as an
			   unhandled rejection during teardown. */
			await servicesPromise?.catch(() => undefined);
			const lease = await runtimeLeasePromise?.catch(() => undefined);
			await lease?.release();
			runtimeLeasePromise = undefined;
			servicesPromise = undefined;
		},
	};
}
