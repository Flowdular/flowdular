export { normalizeQuery, SearchService } from './search-service.ts';
export type {
	SearchBudget,
	SearchQueryInput,
	SearchServiceOptions,
} from './search-service.ts';
export { SearchServiceError } from './service-error.ts';
export { createSearchProviderRegistry } from './provider-registry.ts';
export type {
	MutableSearchProviderRegistry,
	RegisteredSearchProvider,
} from './provider-registry.ts';
export type {
	ExportedRecentQuery,
	RecordQueryInput,
	SearchRepository,
} from './repository.ts';
export {
	DatabaseSearchRepository,
	migrateSearchDatabase,
} from './database-repository.ts';
