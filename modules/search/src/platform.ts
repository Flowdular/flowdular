import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import { SEARCH_PROVIDERS_CAPABILITY } from './domain/providers.ts';
import type { SearchProviderRegistry } from './domain/providers.ts';
import { searchDataClasses } from './domain/data-classes.ts';
import { createSearchRoutes, createSearchRuntime } from './server/index.ts';
import { searchBudget, SEARCH_MODULE_SETTINGS } from './settings.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createSearchRuntime({
		databases: context.databases,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
		budget: () => searchBudget(context.settings),
	});
	/* Registered while this module composes so every provider module, which
	   declares search.core as a dependency and therefore composes later, finds
	   the registry open. `start` runs once every module has composed, which is
	   exactly when the provider list is final. */
	context.capabilities.register<SearchProviderRegistry>(
		SEARCH_PROVIDERS_CAPABILITY,
		{
			register: (moduleId, providers) =>
				runtime.providers.register(moduleId, providers),
		},
	);
	context.dataClasses.declare(searchDataClasses(() => runtime.repository()));
	return {
		routes: createSearchRoutes(context.auth, runtime),
		settings: SEARCH_MODULE_SETTINGS,
		start: () => runtime.start(),
		dispose: () => runtime.dispose(),
	};
}
