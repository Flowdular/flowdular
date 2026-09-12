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
import { ExportService } from '../services/export-service.ts';
import { createExportJobRunner } from '../services/export-runner.ts';
import {
	DatabaseExportRepository,
	migrateExportsDatabase,
} from '../services/database-repository.ts';
import type { ExportRepository } from '../services/repository.ts';
import {
	createExportListRegistry,
	type ExportListRegistry,
} from '../services/list-registry.ts';

export interface ExportsRuntimeOptions {
	/** Platform-owned provider. Modules never receive a DSN or a pool. */
	readonly databases: DatabaseProvider;
	readonly purpose: Exclude<DatabaseProviderRequest['purpose'], 'migration'>;
	/** Platform-owned object storage; this module writes under its own id. */
	readonly storage: StoragePort;
	readonly maxRows: () => number;
	readonly maxBytes: () => number;
	/** The object ceiling the platform configured the storage port with. */
	readonly maxObjectBytes: () => number;
	/** Test seams: an already migrated repository, and a faster poll. */
	readonly repository?: ExportRepository;
	readonly pollIntervalMs?: number;
	readonly claimTimeoutMs?: number;
}

export interface ExportsRuntime {
	readonly lists: ExportListRegistry;
	service(): Promise<ExportService>;
	repository(): Promise<ExportRepository>;
	/** One poll pass, for a test that must not wait on a timer. */
	tick(): Promise<void>;
	start(): void;
	stop(): void;
	quiesce(): Promise<void>;
	dispose(): Promise<void>;
}

export function createExportsRuntime(
	options: ExportsRuntimeOptions,
): ExportsRuntime {
	const lists = createExportListRegistry();
	let disposed = false;
	let leases: DatabaseAdapterLease[] = [];
	let repositoryPromise: Promise<ExportRepository> | undefined;
	let servicePromise: Promise<ExportService> | undefined;

	/* Schema work runs on the migrator role and that lease is released before the
	   runtime one is taken, so request handling never holds a schema owner. */
	const openRepository = async (): Promise<ExportRepository> => {
		if (options.repository) return options.repository;
		const migrationLease = await options.databases.acquire({
			namespace: 'exports.core',
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
			await migrateExportsDatabase(migrationLease.database);
		} finally {
			await migrationLease.release();
		}
		const acquire = (purpose: DatabaseProviderRequest['purpose']) =>
			options.databases.acquire({
				namespace: 'exports.core',
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
		return new DatabaseExportRepository({
			runtime: runtimeLease.database,
			background: backgroundLease.database,
		});
	};

	const repository = (): Promise<ExportRepository> => {
		if (disposed)
			return Promise.reject(new Error('Exports runtime is disposed.'));
		repositoryPromise ??= openRepository();
		return repositoryPromise;
	};

	const service = (): Promise<ExportService> => {
		if (disposed)
			return Promise.reject(new Error('Exports runtime is disposed.'));
		servicePromise ??= repository().then(
			(resolved) =>
				new ExportService({
					repository: resolved,
					lists,
					storage: options.storage,
					maxRows: options.maxRows,
					maxBytes: options.maxBytes,
					maxObjectBytes: options.maxObjectBytes,
				}),
		);
		return servicePromise;
	};

	/* The platform runner owns the loop: the interval and its unref, the guard
	   against overlapping passes, the bound on claims, the renewal timer, the
	   backoff and the drain. This module keeps its table, its statements and its
	   stale window. */
	const jobs = createExportJobRunner({
		repository,
		service,
		pollIntervalMs: options.pollIntervalMs,
		claimTimeoutMs: options.claimTimeoutMs,
	});

	return {
		lists,
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
