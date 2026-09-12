export { createSearchRoutes, endpoints } from '../api/endpoints.ts';
export {
	DatabaseSearchRepository,
	migrateSearchDatabase,
} from '../services/database-repository.ts';
export { createSearchRuntime } from './runtime.ts';
export type { SearchRuntime, SearchRuntimeOptions } from './runtime.ts';
export { createSearchProviderRegistry } from '../services/provider-registry.ts';
export type {
	MutableSearchProviderRegistry,
	RegisteredSearchProvider,
} from '../services/provider-registry.ts';
export { normalizeQuery, SearchService } from '../services/search-service.ts';
export type {
	SearchBudget,
	SearchQueryInput,
	SearchServiceOptions,
} from '../services/search-service.ts';
export type {
	ExportedRecentQuery,
	RecordQueryInput,
	SearchRepository,
} from '../services/repository.ts';
export { searchDataClasses } from '../domain/data-classes.ts';
export { SEARCH_MODULE_SETTINGS, searchBudget } from '../settings.ts';
