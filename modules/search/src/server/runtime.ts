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
	createSearchProviderRegistry,
	type MutableSearchProviderRegistry,
} from '../services/provider-registry.ts';
import type { SearchRepository } from '../services/repository.ts';
import {
	SearchService,
	type SearchBudget,
} from '../services/search-service.ts';
import {
	DatabaseSearchRepository,
	migrateSearchDatabase,
} from '../services/database-repository.ts';

export interface SearchRuntimeOptions {
	/** Platform-owned provider. Modules never receive a DSN or a pool. */
	readonly databases: DatabaseProvider;
	readonly purpose?:
		| Exclude<DatabaseProviderRequest['purpose'], 'migration'>
		| undefined;
	/** Live platform settings, read again for every query. */
	readonly budget: () => SearchBudget;
	readonly repository?: SearchRepository;
	readonly now?: () => number;
}

export interface SearchRuntime {
	/** The registry providers register into while modules compose. */
	readonly providers: MutableSearchProviderRegistry;
	service(): Promise<SearchService>;
	repository(): Promise<SearchRepository>;
	/** Closes registration. Called once every module has composed. */
	start(): void;
	dispose(): Promise<void>;
}

export function createSearchRuntime(
	options: SearchRuntimeOptions,
): SearchRuntime {
	const providers = createSearchProviderRegistry();
	let disposed = false;
	let lease: DatabaseAdapterLease | undefined;
	let repositoryPromise: Promise<SearchRepository> | undefined;
	let service: SearchService | undefined;

	/* Schema work runs on the migrator role and that lease is released before the
	   runtime one is taken, so request handling never holds a schema owner. */
	const openRepository = async (): Promise<SearchRepository> => {
		if (options.repository) return options.repository;
		const migration = await options.databases.acquire({
			namespace: 'search.core',
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
			await migrateSearchDatabase(migration.database);
		} finally {
			await migration.release();
		}
		const runtimeLease = await options.databases.acquire({
			namespace: 'search.core',
			purpose: options.purpose ?? 'runtime',
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
			},
		});
		lease = runtimeLease;
		return new DatabaseSearchRepository(runtimeLease.database);
	};

	const repository = (): Promise<SearchRepository> => {
		if (disposed) {
			return Promise.reject(new Error('Search runtime is disposed.'));
		}
		return (repositoryPromise ??= openRepository());
	};

	return {
		providers,
		repository,
		async service() {
			const store = await repository();
			return (service ??= new SearchService({
				registry: providers,
				repository: store,
				budget: options.budget,
				...(options.now ? { now: options.now } : {}),
			}));
		},
		start() {
			providers.seal();
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			/* An open still in flight would assign its lease after this read, so
			   settle it first; a failed open must not surface as an unhandled
			   rejection during teardown. */
			await repositoryPromise?.catch(() => undefined);
			await lease?.release();
			lease = undefined;
			repositoryPromise = undefined;
			service = undefined;
		},
	};
}
