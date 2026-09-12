import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import type { ModuleSettingsDeclaration } from '@flowdular/kernel';
import type { AgentTool } from '@flowdular/harness';
import {
	REPORTS_PROVIDERS_CAPABILITY,
	type ReportProviderRegistry,
} from '@flowdular/module-reports';
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
import { agentsDataClasses } from './services/data-classes.ts';
import { createAgentRunsReportProvider } from './services/reports.ts';
import {
	AGENT_METER_DECLARATIONS,
	METERING_METERS_CAPABILITY,
	type MeterRegistry,
} from './services/metering.ts';
import {
	NOTIFICATIONS_PUBLISH_CAPABILITY,
	type NotificationPublisher,
} from './services/notifications.ts';
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
	prepare(): Promise<void>;
	/* Called by the platform once every module is composed. Recovery of
	   interrupted runs starts here, not on the first request. */
	start(): void;
};

export function createServerComposition(
	context: PlatformServerContext,
): AgentServerComposition {
	/* agents.core requires metering.meters.v1, so the module registry composes
	   metering.core first and the registry is here to declare into. Declaring
	   happens once, while this module composes; every later use resolves the
	   registry again through the capability rather than holding this one. */
	const meters = () =>
		context.capabilities.get<MeterRegistry>(METERING_METERS_CAPABILITY);
	meters()?.declare('agents.core', AGENT_METER_DECLARATIONS);
	const runtime = createAgentRuntime({
		...agentRuntimeOptionsFromEnvironment(
			context.environment,
			context.workspaceRoot,
		),
		databases: context.databases,
		tools: () => toolsFromContext(context),
		moduleAgents: () =>
			context.agentDefinitions.list() as readonly ModuleAgentDefinition[],
		authorizeToolAccess: ({ tenantId, actor }) =>
			context.auth.authorizeAgentToolAccess(tenantId, actor),
		settings: agentSettings(context),
		/* notifications.core is optional and is not declared as a dependency.
		   The lookup happens when a run settles, so a module composed after
		   this one is found and an absent one is a no-op. */
		notifications: () =>
			context.capabilities.get<NotificationPublisher>(
				NOTIFICATIONS_PUBLISH_CAPABILITY,
			),
		meters,
	});
	/* The sweep, the export and the erasure run here, on this module's own
	   leases and under its own tenant transaction; the platform only holds the
	   declaration. */
	context.dataClasses.declare(agentsDataClasses(() => runtime.repository()));
	/* reports.core is a declared dependency, so it has composed and its registry
	   is still open. The capability stays optional all the same: a deployment
	   that leaves reports out still composes this module. */
	context.capabilities
		.get<ReportProviderRegistry>(REPORTS_PROVIDERS_CAPABILITY)
		?.register('agents.core', [
			createAgentRunsReportProvider(() => runtime.repository()),
		]);
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
