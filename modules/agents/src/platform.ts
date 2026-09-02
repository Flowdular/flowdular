import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@coreloom/module-auth/server';
import type { ModuleSettingsDeclaration } from '@coreloom/kernel';
import type { AgentTool } from '@coreloom/harness';
import type { ModuleAgentDefinition } from './domain/types.ts';
import {
	AGENT_ACTION_EXECUTION_CAPABILITY,
	AGENT_RUN_EXECUTION_CAPABILITY,
	agentRuntimeOptionsFromEnvironment,
	AGENT_RUN_QUEUE_CAPABILITY,
	createAgentRunQueue,
	createAgentRoutes,
	createAgentRuntime,
} from './server/index.ts';
import {
	agentSettings,
	agentsModuleSettingsFromEnvironment,
} from './settings.ts';

/* Business modules register tools in `context.agentTools` from their own
   compositions, some of them after this one ran. The registry is therefore
   read when the platform calls `start()`, never at composition time. The
   field is read structurally until the composition contract carries it. */
interface AgentToolRegistry {
	list(): readonly AgentTool[];
}

function toolsFromContext(
	context: PlatformServerContext,
): readonly AgentTool[] {
	return (
		(context as { agentTools?: AgentToolRegistry }).agentTools?.list() ?? []
	);
}

export type AgentServerComposition = PlatformServerComposition & {
	readonly settings: ModuleSettingsDeclaration;
	prepare(): void;
	/* Called by the platform once every module is composed. Recovery of
	   interrupted runs starts here, not on the first request. */
	start(): void;
};

export function createServerComposition(
	context: PlatformServerContext,
): AgentServerComposition {
	const runtime = createAgentRuntime({
		...agentRuntimeOptionsFromEnvironment(
			context.environment,
			context.workspaceRoot,
		),
		tools: () => toolsFromContext(context),
		moduleAgents: () =>
			context.agentDefinitions.list() as readonly ModuleAgentDefinition[],
		authorizeToolAccess: ({ tenantId, actor }) =>
			context.auth.authorizeAgentToolAccess(tenantId, actor),
		settings: agentSettings(context),
	});
	context.capabilities.register(
		AGENT_RUN_QUEUE_CAPABILITY,
		createAgentRunQueue(() => runtime.service()),
	);
	context.capabilities.register(
		AGENT_RUN_EXECUTION_CAPABILITY,
		runtime.revisionExecution(),
	);
	context.capabilities.register(
		AGENT_ACTION_EXECUTION_CAPABILITY,
		runtime.actions(),
	);
	return {
		routes: createAgentRoutes(context.auth, runtime),
		settings: agentsModuleSettingsFromEnvironment(context.environment),
		prepare: () => runtime.prepare(),
		start: () => runtime.start(),
		stop: () => runtime.quiesce(),
		dispose: () => runtime.dispose(),
	};
}
