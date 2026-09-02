import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@coreloom/module-auth/server';
import { platformVariableRegistry } from '@coreloom/kernel';
import { registerPartyVariableSource } from './domain/variables.ts';
import {
	createPartiesRuntime,
	createPartyRoutes,
	partiesAgentTools,
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
	const tools = partiesAgentTools(runtime);
	context.agentTools.register(tools);
	registerPartyVariableSource(
		platformVariableRegistry(context.capabilities),
		tools,
	);
	return {
		routes: createPartyRoutes(context.auth, runtime),
		dispose: () => runtime.dispose(),
	};
}
