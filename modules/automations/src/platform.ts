import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@coreloom/module-auth/server';
import { platformVariableRegistry } from '@coreloom/kernel';
import {
	AGENT_RUN_QUEUE_CAPABILITY,
	type AgentRunQueue,
} from '@coreloom/module-agents/server';
import {
	createAutomationsRoutes,
	createAutomationsRuntime,
	automationsRuntimeOptionsFromEnvironment,
	AUTOMATION_TARGETS_CAPABILITY,
	createAutomationTargetRegistry,
} from './server/index.ts';
import { registerScheduleVariableSource } from './domain/variables.ts';
import {
	automationsModuleSettingsFromEnvironment,
	automationsSchedulerPollMs,
} from './settings.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const targets = createAutomationTargetRegistry();
	context.capabilities.register(AUTOMATION_TARGETS_CAPABILITY, targets);
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
		schedulerPollMs: () =>
			automationsSchedulerPollMs(context.settings, context.environment),
		variables: registerScheduleVariableSource(
			platformVariableRegistry(context.capabilities),
			runQueue,
		),
		targets,
	});
	return {
		routes: createAutomationsRoutes(context.auth, runtime),
		settings: automationsModuleSettingsFromEnvironment(context.environment),
		start: () => runtime.start(),
		stop: () => runtime.quiesce(),
		dispose: () => runtime.dispose(),
	};
}
