import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import type { StoragePort } from '@flowdular/storage';
import { DocumentsService } from '../services/documents-service.ts';
import {
	DatabaseDocumentsRepository,
	migrateDocumentsDatabase,
} from '../services/database-repository.ts';
import type { DocumentsRepository } from '../services/repository.ts';

export interface DocumentsRuntimeOptions {
	/** Platform-owned provider. Modules never receive a DSN or a pool. */
	readonly databases: DatabaseProvider;
	readonly purpose: Exclude<DatabaseProviderRequest['purpose'], 'migration'>;
	/** Platform-owned object storage; the module never sees an adapter. */
	readonly storage: StoragePort;
	/** Live tenant quota in bytes, read again for every upload. */
	readonly quotaBytes: (tenantId: string) => number;
	/** Live platform read URL lifetime in seconds. */
	readonly readUrlSeconds: () => number;
	/** Test seam: an already migrated repository, so no lease is taken. */
	readonly repository?: DocumentsRepository;
}

export interface DocumentsRuntime {
	service(): Promise<DocumentsService>;
	dispose(): Promise<void>;
}

export function createDocumentsRuntime(
	options: DocumentsRuntimeOptions,
): DocumentsRuntime {
	let disposed = false;
	let runtimeLeasePromise: Promise<DatabaseAdapterLease> | undefined;
	let servicePromise: Promise<DocumentsService> | undefined;

	/* Schema work runs on the migrator role and that lease is released before the
	   runtime one is taken, so request handling never holds a schema owner. */
	const openRepository = async (): Promise<DocumentsRepository> => {
		if (options.repository) return options.repository;
		const migrationLease = await options.databases.acquire({
			namespace: 'documents.core',
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
			await migrateDocumentsDatabase(migrationLease.database);
		} finally {
			await migrationLease.release();
		}
		runtimeLeasePromise = options.databases.acquire({
			namespace: 'documents.core',
			purpose: options.purpose,
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
			},
		});
		return new DatabaseDocumentsRepository(
			(await runtimeLeasePromise).database,
		);
	};

	const initialize = async (): Promise<DocumentsService> =>
		new DocumentsService({
			repository: await openRepository(),
			storage: options.storage,
			quotaBytes: options.quotaBytes,
			readUrlSeconds: options.readUrlSeconds,
		});

	return {
		service: () => {
			if (disposed) {
				return Promise.reject(new Error('Documents runtime is disposed.'));
			}
			servicePromise ??= initialize();
			return servicePromise;
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			/* An open still in flight would assign its lease after this read, so
			   settle it first; a failed open must not surface as an unhandled
			   rejection during teardown. */
			await servicePromise?.catch(() => undefined);
			servicePromise = undefined;
			if (!runtimeLeasePromise) return;
			await (await runtimeLeasePromise).release();
			runtimeLeasePromise = undefined;
		},
	};
}
