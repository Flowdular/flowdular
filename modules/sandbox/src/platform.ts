import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@coreloom/module-auth/server';
import {
	createSandboxRoutes,
	createSandboxRuntime,
	sandboxRuntimeOptionsFromEnvironment,
} from './server/index.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createSandboxRuntime(
		sandboxRuntimeOptionsFromEnvironment(
			context.environment,
			context.workspaceRoot,
		),
	);
	return { routes: createSandboxRoutes(context.auth, runtime) };
}
