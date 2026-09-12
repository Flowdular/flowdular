import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import {
	IMPORT_PORTS_CAPABILITY,
	type ImportPorts,
} from '@flowdular/module-import';
import {
	SEARCH_PROVIDERS_CAPABILITY,
	type SearchProviderRegistry,
} from '@flowdular/module-search';
import { createUserRoutes } from './api/endpoints.ts';
import { createMemberImportPort } from './services/member-import.ts';
import { createMemberSearchProvider } from './services/member-search.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	/* search.core is a declared dependency, so it has composed and its registry
	   is still open. The capability stays optional all the same: a deployment
	   that leaves search out still composes this module. */
	context.capabilities
		.get<SearchProviderRegistry>(SEARCH_PROVIDERS_CAPABILITY)
		?.register('users.core', [createMemberSearchProvider(context.auth)]);
	/* Same contract for import.core: declared dependency, optional capability,
	   registration while the registry is open. */
	context.capabilities
		.get<ImportPorts>(IMPORT_PORTS_CAPABILITY)
		?.register('users.core', [createMemberImportPort(context.auth)]);
	return { routes: createUserRoutes(context.auth) };
}
