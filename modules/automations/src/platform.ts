import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import { platformVariableRegistry } from '@flowdular/kernel';
import {
	AGENT_RUN_QUEUE_CAPABILITY,
	type AgentRunQueue,
} from '@flowdular/module-agents/server';
import {
	createAutomationsRoutes,
	createAutomationsRuntime,
	automationsRuntimeOptionsFromEnvironment,
	AUTOMATION_EXECUTION_CAPABILITY,
	AUTOMATION_TARGETS_CAPABILITY,
	createAutomationExecutionCapability,
	createAutomationTargetRegistry,
	createAutomationWorkflowActionTools,
	registerWorkflowAutomationTarget,
} from './server/index.ts';
import { registerScheduleVariableSource } from './domain/variables.ts';
import { automationsDataClasses } from './services/data-classes.ts';
import {
	automationsModuleSettingsFromEnvironment,
	automationsSchedulerPollMs,
} from './settings.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const targets = createAutomationTargetRegistry();
	context.capabilities.register(AUTOMATION_TARGETS_CAPABILITY, targets);
	registerWorkflowAutomationTarget(targets, context.capabilities);
	const runQueue = () => {
		const queue = context.capabilities.get<AgentRunQueue>(
			AGENT_RUN_QUEUE_CAPABILITY,
		);
		if (!queue) {
			throw new Error(
				'automations.core requires the agents.run-queue capability.',
			);
		}
		return queue;
	};
	const runtime = createAutomationsRuntime({
		...automationsRuntimeOptionsFromEnvironment(
			runQueue,
			context.environment,
			context.workspaceRoot,
		),
		databases: context.databases,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
		schedulerPollMs: () =>
			automationsSchedulerPollMs(context.settings, context.environment),
		variables: registerScheduleVariableSource(
			platformVariableRegistry(context.capabilities),
			runQueue,
		),
		targets,
	});
	const execution = createAutomationExecutionCapability(() =>
		runtime.scheduleService(),
	);
	context.capabilities.register(AUTOMATION_EXECUTION_CAPABILITY, execution);
	context.agentTools.register(
		createAutomationWorkflowActionTools(() => execution),
	);
	/* The export runs here, on this module's own leases and under its own tenant
	   transaction; the platform only holds the declaration. */
	context.dataClasses.declare(
		automationsDataClasses(() => runtime.repository()),
	);
	return {
		routes: createAutomationsRoutes(context.auth, runtime),
		settings: automationsModuleSettingsFromEnvironment(context.environment),
		start: () => runtime.start(),
		stop: () => runtime.quiesce(),
		dispose: () => runtime.dispose(),
	};
}
