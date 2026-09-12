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
import {
	tenantTimeZone,
	TENANT_TIME_ZONE_KEY,
	TENANT_TIME_ZONE_MODULE_ID,
} from './domain/time-zone.ts';
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
		timeZone: (tenantId) => tenantTimeZone(context.settings, tenantId),
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
	/* The workspace zone is the real signal for when a cron slot lands, so a
	   change to it moves the pending slots of that workspace at once instead of
	   waiting for each schedule to fire in the zone it no longer uses. */
	const stopWatchingTimeZone = context.settings.onChange((change) => {
		if (
			change.moduleId !== TENANT_TIME_ZONE_MODULE_ID ||
			change.key !== TENANT_TIME_ZONE_KEY
		) {
			return;
		}
		runtime.retimeSchedules(change.tenantId);
	});
	return {
		routes: createAutomationsRoutes(context.auth, runtime),
		settings: automationsModuleSettingsFromEnvironment(context.environment),
		start: () => runtime.start(),
		stop: () => runtime.quiesce(),
		dispose: async () => {
			stopWatchingTimeZone();
			await runtime.dispose();
		},
	};
}
