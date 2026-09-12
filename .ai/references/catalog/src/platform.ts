import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/sdk/modules/auth/server';
import { platformVariableRegistry } from '@flowdular/sdk/kernel';
import { registerCatalogVariableSource } from './domain/variables.ts';
import { catalogDataClasses } from './services/data-classes.ts';
import {
	catalogAgentTools,
	createCatalogRoutes,
	createCatalogRuntime,
} from './server/index.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createCatalogRuntime({
		databases: context.databases,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
	});
	const tools = catalogAgentTools(runtime);
	context.agentTools.register(tools);
	registerCatalogVariableSource(
		platformVariableRegistry(context.capabilities),
		tools,
	);
	context.dataClasses.declare(catalogDataClasses(() => runtime.service()));
	return {
		routes: createCatalogRoutes(context.auth, runtime),
		dispose: () => runtime.dispose(),
	};
}
