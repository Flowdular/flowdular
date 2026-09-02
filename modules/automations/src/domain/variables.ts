import {
	validateTemplate,
	type VariableDefinition,
	type VariableSource,
} from '@coreloom/contracts';
import {
	createPlatformVariableRegistry,
	VariableResolutionError,
	type Actor,
	type PlatformVariableRegistry,
} from '@coreloom/kernel';
import type { AgentRunQueue } from '@coreloom/module-agents/server';
import { AUTOMATIONS_PERMISSIONS } from '../acl/permissions.ts';
import type { AutomationSchedule } from './types.ts';
import { AutomationsServiceError } from '../services/automations-service.ts';

/* The agent name comes from the agents.run-queue public capability. It is
   tenant-scoped by that service, and it is only offered to a principal who can
   manage the schedule that selected the agent. This keeps the linked field on
   the same read boundary as the schedule editor. */
export const AUTOMATION_LOCAL_VARIABLE_SOURCE: VariableSource = {
	id: 'automations.schedule-local',
	variables: [
		{
			key: 'context.today',
			label: 'Run date (UTC)',
			kind: 'date',
			sample: '2026-09-02',
			description: 'The UTC calendar date on which this run is queued.',
		},
		{
			key: 'context.now',
			label: 'Run time (UTC)',
			kind: 'date',
			sample: '2026-09-02T09:30:00.000Z',
			description: 'The UTC timestamp at which this run is queued.',
		},
		{
			key: 'automation.schedule.id',
			label: 'Schedule ID',
			kind: 'identifier',
			scope: AUTOMATIONS_PERMISSIONS.manage,
			description: 'The stable identifier of this schedule.',
		},
		{
			key: 'automation.schedule.label',
			label: 'Schedule label',
			kind: 'text',
			scope: AUTOMATIONS_PERMISSIONS.manage,
			description: 'The label from this schedule editor.',
		},
	],
};

export const AUTOMATION_AGENT_VARIABLE_SOURCE: VariableSource = {
	id: 'automations.schedule-agent',
	variables: [
		{
			key: 'agent.name',
			label: 'Agent name',
			kind: 'text',
			scope: AUTOMATIONS_PERMISSIONS.manage,
			description:
				'The selected agent name, read through the agents run queue.',
		},
	],
};

export const AUTOMATION_SCHEDULE_VARIABLE_SOURCE: VariableSource = {
	id: 'automations.schedule',
	variables: [
		...AUTOMATION_LOCAL_VARIABLE_SOURCE.variables,
		...AUTOMATION_AGENT_VARIABLE_SOURCE.variables,
	],
};

export const AUTOMATION_SCHEDULE_VARIABLES =
	AUTOMATION_SCHEDULE_VARIABLE_SOURCE.variables;

const scheduleVariableRegistry = createPlatformVariableRegistry();
scheduleVariableRegistry.register(AUTOMATION_LOCAL_VARIABLE_SOURCE);
scheduleVariableRegistry.register(AUTOMATION_AGENT_VARIABLE_SOURCE);

export function scheduleVariablesForScopes(
	scopes: readonly string[],
): readonly VariableDefinition[] {
	return scheduleVariableRegistry.list(scopes);
}

export function validateScheduleTemplate(
	template: string,
	scopes: readonly string[],
): void {
	const report = validateTemplate(
		template,
		AUTOMATION_SCHEDULE_VARIABLES,
		scopes,
	);
	if (report.unknown.length > 0) {
		throw new AutomationsServiceError(
			'UNKNOWN_TEMPLATE_VARIABLE',
			`Unknown template variable: ${report.unknown.join(', ')}.`,
		);
	}
	if (report.forbidden.length > 0) {
		throw new AutomationsServiceError(
			'FORBIDDEN_TEMPLATE_VARIABLE',
			`You cannot use template variable: ${report.forbidden.join(', ')}.`,
			403,
		);
	}
}

/* The agent lookup is registered as a source resolver, not performed by the
   template consumer. It receives the tenant and explicit agentId binding from
   the shared registry, then reads only through agents.run-queue. */
export function registerScheduleVariableSource(
	registry: PlatformVariableRegistry,
	runQueue: () => AgentRunQueue,
): PlatformVariableRegistry {
	registry.register(AUTOMATION_LOCAL_VARIABLE_SOURCE);
	registry.register(AUTOMATION_AGENT_VARIABLE_SOURCE, {
		requiredBindings: { 'agent.name': ['agentId'] },
		resolve: async (context) => {
			if (!context.keys.includes('agent.name')) return {};
			if (context.signal.aborted) {
				throw new VariableResolutionError(
					'VARIABLE_RESOLUTION_ABORTED',
					'Variable resolution was aborted.',
				);
			}
			const agent = runQueue()
				.listAgents(context.tenantId)
				.find((candidate) => candidate.id === context.bindings.agentId);
			if (!agent) {
				throw new VariableResolutionError(
					'VARIABLE_VALUE_UNAVAILABLE',
					'A variable value is unavailable.',
				);
			}
			return { 'agent.name': agent.name };
		},
	});
	return registry;
}

export function createScheduleVariableRegistry(
	runs: AgentRunQueue,
): PlatformVariableRegistry {
	return registerScheduleVariableSource(
		createPlatformVariableRegistry(),
		() => runs,
	);
}

export async function resolveScheduleTemplate(
	registry: PlatformVariableRegistry,
	template: string,
	schedule: Pick<AutomationSchedule, 'tenantId' | 'agentId' | 'id' | 'label'>,
	now: number,
	actor: Actor,
	permissionSnapshot: readonly string[],
	signal: AbortSignal,
): Promise<string> {
	return registry.resolve(template, {
		tenantId: schedule.tenantId,
		actor,
		permissionSnapshot,
		signal,
		bindings: { agentId: schedule.agentId },
		values: {
			'context.today': new Date(now).toISOString().slice(0, 10),
			'context.now': new Date(now).toISOString(),
			'automation.schedule.id': schedule.id,
			'automation.schedule.label': schedule.label,
		},
	});
}
