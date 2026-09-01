import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@coreloom/module-auth/server';
import {
	catalogRuntimeOptionsFromEnvironment,
	createCatalogRoutes,
	createCatalogRuntime,
} from './server/index.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createCatalogRuntime(
		catalogRuntimeOptionsFromEnvironment(
			context.environment,
			context.workspaceRoot,
		),
	);
	return { routes: createCatalogRoutes(context.auth, runtime) };
}
