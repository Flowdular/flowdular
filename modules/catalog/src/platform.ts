import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@coreloom/module-auth/server';
import { platformVariableRegistry } from '@coreloom/kernel';
import { registerCatalogVariableSource } from './domain/variables.ts';
import {
	catalogAgentTools,
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
	const tools = catalogAgentTools(runtime);
	context.agentTools.register(tools);
	registerCatalogVariableSource(
		platformVariableRegistry(context.capabilities),
		tools,
	);
	return {
		routes: createCatalogRoutes(context.auth, runtime),
		dispose: () => runtime.dispose(),
	};
}
