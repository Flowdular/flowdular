import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@coreloom/module-auth/server';
import {
	createPartiesRuntime,
	createPartyRoutes,
	partiesRuntimeOptionsFromEnvironment,
} from './server/index.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createPartiesRuntime(
		partiesRuntimeOptionsFromEnvironment(
			context.environment,
			context.workspaceRoot,
		),
	);
	return { routes: createPartyRoutes(context.auth, runtime) };
}
