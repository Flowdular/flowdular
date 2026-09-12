import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import {
	EXPORT_LISTS_CAPABILITY,
	type ExportLists,
} from '@flowdular/module-exports';
import {
	IMPORT_PORTS_CAPABILITY,
	type ImportPorts,
} from '@flowdular/module-import';
import {
	SEARCH_PROVIDERS_CAPABILITY,
	type SearchProviderRegistry,
} from '@flowdular/module-search';
import { createUserRoutes } from './api/endpoints.ts';
import { createMemberListExport } from './services/member-export.ts';
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
	/* And for exports.core, except that its capability is optional and an
	   optional requirement does not order its provider first, so the registry may
	   not exist yet while this module composes. It is asked for twice, once here
	   and once at start, because exports.core registers during composition and
	   seals in its own start hook, which runs after this one whenever it composed
	   after this module. Without exports.core both attempts answer nothing and
	   the screens still work. The declaration opens no database and reads no
	   member either way: the list is walked later, under the principal the job
	   was started by. */
	let registered = false;
	const registerLists = (): void => {
		if (registered) return;
		const lists = context.capabilities.get<ExportLists>(
			EXPORT_LISTS_CAPABILITY,
		);
		if (!lists) return;
		registered = true;
		lists.register('users.core', [createMemberListExport(context.auth)]);
	};
	registerLists();
	return {
		routes: createUserRoutes(context.auth),
		start: () => registerLists(),
	};
}
