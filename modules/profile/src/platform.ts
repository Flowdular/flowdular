import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@coreloom/module-auth/server';
import {
	createProfileRoutes,
	createProfileRuntime,
	profileRuntimeOptionsFromEnvironment,
} from './server/index.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createProfileRuntime(
		profileRuntimeOptionsFromEnvironment(
			context.environment,
			context.workspaceRoot,
		),
	);
	return { routes: createProfileRoutes(context.auth, runtime) };
}
