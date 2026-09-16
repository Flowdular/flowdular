import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	AdaptersService,
	type AdaptersServiceOptions,
} from '../services/adapters-service.ts';
import type {
	ConnectorCalls,
	ExportLists,
	ImportWriter,
	MeterRegistry,
} from '../services/capabilities.ts';
import {
	DatabaseAdaptersRepository,
	migrateAdaptersDatabase,
} from '../services/database-repository.ts';
import {
	createAdapterCatalogue,
	type AdapterCatalogue,
} from '../services/registry.ts';
import type { AdaptersRepository } from '../services/repository.ts';
import {
	createAdapterRunRunner,
	createAdapterScheduleRunner,
} from '../services/runners.ts';

export interface AdaptersRuntimeOptions {
	/** Platform-owned provider. Modules never receive a DSN or a pool. */
	readonly databases: DatabaseProvider;
	readonly purpose: Exclude<DatabaseProviderRequest['purpose'], 'migration'>;
	readonly calls: () => ConnectorCalls | undefined;
	readonly writer: () => ImportWriter | undefined;
	readonly lists: () => ExportLists | undefined;
	readonly meters: () => MeterRegistry | undefined;
	readonly principal: (
		tenantId: string,
		accountId: string,
	) => Promise<AuthPrincipal | null>;
	readonly timeZone: (tenantId: string) => Promise<string>;
	readonly recordedAllowed: boolean;
	/** Test seams. */
	readonly repository?: AdaptersRepository;
	readonly pollIntervalMs?: number;
	readonly claimTimeoutMs?: number;
	readonly heartbeatEveryMs?: number;
	readonly now?: () => number;
	readonly service?: Partial<
		Pick<AdaptersServiceOptions, 'newId' | 'random' | 'sleep'>
	>;
}

export interface AdaptersRuntime {
	readonly catalogue: AdapterCatalogue;
	service(): Promise<AdaptersService>;
	repository(): Promise<AdaptersRepository>;
	/** One pass of each loop, for a test that must not wait on a timer. */
	tickRuns(): Promise<void>;
	tickSchedule(): Promise<void>;
	start(): void;
	stop(): void;
	quiesce(): Promise<void>;
	dispose(): Promise<void>;
}

export function createAdaptersRuntime(
	options: AdaptersRuntimeOptions,
): AdaptersRuntime {
	const catalogue = createAdapterCatalogue();
	let disposed = false;
	let leases: DatabaseAdapterLease[] = [];
	let repositoryPromise: Promise<AdaptersRepository> | undefined;
	let servicePromise: Promise<AdaptersService> | undefined;

	/* Schema work runs on the migrator role and that lease is released before the
	   runtime ones are taken, so request handling never holds a schema owner. */
	const openRepository = async (): Promise<AdaptersRepository> => {
		if (options.repository) return options.repository;
		const migration = await options.databases.acquire({
			namespace: 'adapters.core',
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
			await migrateAdaptersDatabase(migration.database);
		} finally {
			await migration.release();
		}
		const acquire = (purpose: DatabaseProviderRequest['purpose']) =>
			options.databases.acquire({
				namespace: 'adapters.core',
				purpose,
				requirements: {
					dialectIds: [DATABASE_DIALECT_IDS.postgresql],
					capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
				},
			});
		const runtimeLease = await acquire(options.purpose);
		/* Both routing reads cross workspaces; every write that follows uses the
		   tenant the routing row named. */
		const backgroundLease = await acquire('background');
		leases = [runtimeLease, backgroundLease];
		return new DatabaseAdaptersRepository({
			runtime: runtimeLease.database,
			background: backgroundLease.database,
		});
	};

	const repository = (): Promise<AdaptersRepository> => {
		if (disposed) {
			return Promise.reject(new Error('Adapters runtime is disposed.'));
		}
		repositoryPromise ??= openRepository();
		return repositoryPromise;
	};

	const runs = createAdapterRunRunner({
		repository,
		service: () => service(),
		pollIntervalMs: options.pollIntervalMs,
		claimTimeoutMs: options.claimTimeoutMs,
		heartbeatEveryMs: options.heartbeatEveryMs,
		now: options.now,
	});
	const schedule = createAdapterScheduleRunner({
		repository,
		service: () => service(),
		pollIntervalMs: options.pollIntervalMs,
		now: options.now,
	});

	const service = (): Promise<AdaptersService> => {
		if (disposed) {
			return Promise.reject(new Error('Adapters runtime is disposed.'));
		}
		servicePromise ??= repository().then(
			(resolved) =>
				new AdaptersService({
					repository: resolved,
					catalogue,
					calls: options.calls,
					writer: options.writer,
					lists: options.lists,
					meters: options.meters,
					principal: options.principal,
					timeZone: options.timeZone,
					recordedAllowed: options.recordedAllowed,
					onQueued: () => runs.wake(),
					...(options.now ? { now: options.now } : {}),
					...options.service,
				}),
		);
		return servicePromise;
	};

	return {
		catalogue,
		service,
		repository,
		async tickRuns() {
			await runs.tick();
		},
		async tickSchedule() {
			await schedule.tick();
		},
		start() {
			runs.start();
			schedule.start();
		},
		stop() {
			runs.stop();
			schedule.stop();
		},
		async quiesce() {
			await Promise.all([runs.quiesce(), schedule.quiesce()]);
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			await Promise.all([runs.dispose(), schedule.dispose()]);
			/* An open still in flight would assign its leases after this read, so
			   settle it first; a failed open must not surface during teardown. */
			await repositoryPromise?.catch(() => undefined);
			for (const lease of leases) await lease.release();
			leases = [];
			repositoryPromise = undefined;
			servicePromise = undefined;
		},
	};
}
