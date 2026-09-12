import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import { serverLogger } from '@flowdular/server';
import type { DocumentAttachments } from '@flowdular/module-documents';
import { createImportCsvSource } from '../services/csv-source.ts';
import { ImportService } from '../services/import-service.ts';
import { ImportRunner } from '../services/import-runner.ts';
import {
	DatabaseImportRepository,
	migrateImportDatabase,
} from '../services/database-repository.ts';
import type { ImportRepository } from '../services/repository.ts';
import {
	createImportPortRegistry,
	type ImportPortRegistry,
} from '../services/port-registry.ts';

/**
 * How often the job poll runs. A constant rather than a setting: the spec
 * declares `maxRows` and `batchSize` and no cadence, and an operator who needs
 * a different one is asking for a spec change, not a knob.
 */
export const IMPORT_POLL_INTERVAL_MS = 2_000;

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

	const pass = async (): Promise<void> => {
		const runner = new ImportRunner({
			repository: await repository(),
			service,
		});
		await runner.tick();
	};

	/* One background pass on its own interval. A pass never overlaps itself, and
	   a failed pass never stops the interval: the next one finds the same work. */
	let inFlight: Promise<void> | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	const tick = (): Promise<void> => {
		if (disposed || inFlight) return inFlight ?? Promise.resolve();
		const pending = pass()
			.catch((error: unknown) => {
				serverLogger().error('import poll failed', {
					module: 'import.core',
					err: error,
				});
			})
			.finally(() => {
				if (inFlight === pending) inFlight = undefined;
			});
		inFlight = pending;
		return pending;
	};

	const stop = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	const quiesce = async () => {
		stop();
		await inFlight;
	};

	return {
		ports,
		service,
		repository,
		tick,
		start() {
			if (disposed || timer) return;
			void tick();
			timer = setInterval(
				() => void tick(),
				options.pollIntervalMs ?? IMPORT_POLL_INTERVAL_MS,
			);
			timer.unref?.();
		},
		stop,
		quiesce,
		async dispose() {
			if (disposed) return;
			disposed = true;
			await quiesce();
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
