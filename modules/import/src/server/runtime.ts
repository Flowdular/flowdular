import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import type { DocumentAttachments } from '@flowdular/module-documents';
import { createImportCsvSource } from '../services/csv-source.ts';
import { ImportService } from '../services/import-service.ts';
import { createImportJobRunner } from '../services/import-runner.ts';
import {
	DatabaseImportRepository,
	migrateImportDatabase,
} from '../services/database-repository.ts';
import type { ImportRepository } from '../services/repository.ts';
import {
	createImportPortRegistry,
	type ImportPortRegistry,
} from '../services/port-registry.ts';

export interface ImportRuntimeOptions {
	/** Platform-owned provider. Modules never receive a DSN or a pool. */
	readonly databases: DatabaseProvider;
	readonly purpose: Exclude<DatabaseProviderRequest['purpose'], 'migration'>;
	/** Resolved lazily: documents.core registers it while the platform composes. */
	readonly attachments: () => DocumentAttachments | null;
	readonly maxRows: () => number;
	readonly batchSize: () => number;
	/** Test seams: an already migrated repository, and a second handle for it. */
	readonly repository?: ImportRepository;
	readonly pollIntervalMs?: number;
}

export interface ImportRuntime {
	readonly ports: ImportPortRegistry;
	service(): Promise<ImportService>;
	repository(): Promise<ImportRepository>;
	/** One poll pass, for a test that must not wait on a timer. */
	tick(): Promise<void>;
	start(): void;
	stop(): void;
	quiesce(): Promise<void>;
	dispose(): Promise<void>;
}

export function createImportRuntime(
	options: ImportRuntimeOptions,
): ImportRuntime {
	const ports = createImportPortRegistry();
	let disposed = false;
	let leases: DatabaseAdapterLease[] = [];
	let repositoryPromise: Promise<ImportRepository> | undefined;
	let servicePromise: Promise<ImportService> | undefined;

	/* Schema work runs on the migrator role and that lease is released before the
	   runtime one is taken, so request handling never holds a schema owner. */
	const openRepository = async (): Promise<ImportRepository> => {
		if (options.repository) return options.repository;
		const migrationLease = await options.databases.acquire({
			namespace: 'import.core',
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
			await migrateImportDatabase(migrationLease.database);
		} finally {
			await migrationLease.release();
		}
		const acquire = (purpose: DatabaseProviderRequest['purpose']) =>
			options.databases.acquire({
				namespace: 'import.core',
				purpose,
				requirements: {
					dialectIds: [DATABASE_DIALECT_IDS.postgresql],
					capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
				},
			});
		const runtimeLease = await acquire(options.purpose);
		/* The job poll reads across tenants; every write that follows uses the
		   tenant carried by the routing row it returned. */
		const backgroundLease = await acquire('background');
		leases = [runtimeLease, backgroundLease];
		return new DatabaseImportRepository({
			runtime: runtimeLease.database,
			background: backgroundLease.database,
		});
	};

	const repository = (): Promise<ImportRepository> => {
		if (disposed)
			return Promise.reject(new Error('Import runtime is disposed.'));
		repositoryPromise ??= openRepository();
		return repositoryPromise;
	};

	const service = (): Promise<ImportService> => {
		if (disposed)
			return Promise.reject(new Error('Import runtime is disposed.'));
		servicePromise ??= repository().then(
			(resolved) =>
				new ImportService({
					repository: resolved,
					ports,
					source: createImportCsvSource({
						attachments: options.attachments,
					}),
					maxRows: options.maxRows,
					batchSize: options.batchSize,
				}),
		);
		return servicePromise;
	};

	/* The platform runner owns the loop: the interval and its unref, the guard
	   against overlapping passes, the bound on claims, the renewal timer, the
	   backoff and the drain. This module keeps its table, its statements and its
	   stale window. */
	const jobs = createImportJobRunner({
		repository,
		service,
		pollIntervalMs: options.pollIntervalMs,
	});

	return {
		ports,
		service,
		repository,
		async tick() {
			await jobs.tick();
		},
		start: () => jobs.start(),
		stop: () => jobs.stop(),
		quiesce: () => jobs.quiesce(),
		async dispose() {
			if (disposed) return;
			disposed = true;
			await jobs.dispose();
			/* An open still in flight would assign its leases after this read, so
			   settle it first; a failed open must not surface as an unhandled
			   rejection during teardown. */
			await repositoryPromise?.catch(() => undefined);
			for (const lease of leases) await lease.release();
			leases = [];
			repositoryPromise = undefined;
			servicePromise = undefined;
		},
	};
}
