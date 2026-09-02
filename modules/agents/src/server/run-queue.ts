import type {
	AgentOwnership,
	AgentDefinition,
	AgentRun,
	EnqueueAgentRunInput,
} from '../domain/types.ts';
import type { Actor } from '@coreloom/kernel';
import type { AgentService } from '../services/agent-service.ts';

export const AGENT_RUN_QUEUE_CAPABILITY = 'agents.run-queue';

export interface AgentRunQueueAgent {
	readonly id: string;
	readonly name: string;
	readonly status: AgentDefinition['status'];
	readonly allowedTools: readonly string[];
	readonly revision: number;
	readonly ownership: AgentOwnership;
}

export interface AgentRunInvocationContext {
	readonly tenantId: string;
	readonly actor: Actor;
	readonly permissionSnapshot: readonly string[];
}

export interface AgentRunQueue {
	listAgents(tenantId: string): readonly AgentRunQueueAgent[];
	enqueue(
		context: AgentRunInvocationContext,
		input: EnqueueAgentRunInput,
	): Promise<AgentRun>;
	enqueueWithOutcome(
		context: AgentRunInvocationContext,
		input: EnqueueAgentRunInput,
	): Promise<{ readonly run: AgentRun; readonly created: boolean }>;
}

export function createAgentRunQueue(
	service: AgentService | (() => AgentService),
): AgentRunQueue {
	const current = () => (typeof service === 'function' ? service() : service);
	return {
		listAgents(tenantId) {
			const service = current();
			return [
				...service
					.listAgents(tenantId)
					.map(({ id, name, status, allowedTools, revision }) => ({
						id,
						name,
						status,
						allowedTools,
						revision,
						ownership: { kind: 'tenant' as const },
					})),
				...service
					.listModuleAgents(tenantId)
					.filter(
						(
							agent,
						): agent is typeof agent & {
							readonly status: 'active' | 'paused';
							readonly revision: number;
						} =>
							agent.revision !== null &&
							(agent.status === 'active' || agent.status === 'paused'),
					)
					.map((agent) => ({
						id: agent.id,
						name: agent.name,
						status: agent.status,
						allowedTools: agent.enabledTools,
						revision: agent.revision,
						ownership: agent.ownership,
					})),
			].sort((left, right) => left.id.localeCompare(right.id));
		},
		enqueue(context, input) {
			return current().enqueueRun(
				context.tenantId,
				context.actor,
				context.permissionSnapshot,
				input,
			);
		},
		enqueueWithOutcome(context, input) {
			return current().enqueueRunWithOutcome(
				context.tenantId,
				context.actor,
				context.permissionSnapshot,
				input,
			);
		},
	};
}
