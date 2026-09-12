import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import manifest from '../module.json' with { type: 'json' };
import { SEARCH_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'search.navigation',
			label: 'Search',
			href: '/search',
			order: 15,
			permission: SEARCH_PERMISSIONS.read,
		},
	],
	permissions: Object.values(SEARCH_PERMISSIONS),
} satisfies RegisteredModule;

export { SEARCH_PERMISSIONS } from './acl/permissions.ts';

/* The cross-module contract. A provider module imports the identifier and the
   types from here and resolves the registry through the capability registry;
   nothing else in this module is meant to be imported by another one. */
export {
	SEARCH_PROVIDERS_CAPABILITY,
	SEARCH_PROVIDER_LIMITS,
} from './domain/providers.ts';
export type {
	SearchHit,
	SearchPrincipal,
	SearchProvider,
	SearchProviderPage,
	SearchProviderQuery,
	SearchProviderRegistry,
} from './domain/providers.ts';

export { SEARCH_LIMITS } from './domain/types.ts';
export type {
	RecentQuery,
	SearchCursor,
	SearchProviderSummary,
	SearchResultHit,
	SearchResultPage,
} from './domain/types.ts';

export { SearchServiceError } from './services/service-error.ts';
