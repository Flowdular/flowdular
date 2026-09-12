import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import {
	REPORTS_PROVIDERS_CAPABILITY,
	type ReportProviderRegistry,
} from './domain/providers.ts';
import { createReportsRoutes, createReportsRuntime } from './server/index.ts';
import { REPORTS_MODULE_SETTINGS, reportsBudget } from './settings.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createReportsRuntime({
		budget: () => reportsBudget(context.settings),
	});
	/* Registered while this module composes so every provider module, which
	   declares reports.core as a dependency and therefore composes later, finds
	   the registry open. `start` runs once every module has composed, which is
	   exactly when the provider list is final. */
	context.capabilities.register<ReportProviderRegistry>(
		REPORTS_PROVIDERS_CAPABILITY,
		{
			register: (moduleId, providers) =>
				runtime.providers.register(moduleId, providers),
		},
	);
	/* reports.core holds no rows: it composes what the owning modules answer
	   and keeps nothing. The empty declaration is how a workspace sees that. */
	context.dataClasses.declare('reports.core', []);
	return {
		routes: createReportsRoutes(context.auth, runtime),
		settings: REPORTS_MODULE_SETTINGS,
		start: () => runtime.start(),
	};
}
