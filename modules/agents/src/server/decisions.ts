import type {
	DecisionQuestion,
	DecisionResult,
} from '@flowdular/harness/decisions';
import type {
	AgentDecisionCaller,
	AgentDecisionService,
} from '../services/decision-service.ts';

export const AGENT_DECISIONS_CAPABILITY = 'agents.decisions.v1';

export interface AgentDecisionAsk {
	readonly tenantId: string;
	readonly caller: AgentDecisionCaller;
	readonly state: string;
	readonly questions: Readonly<Record<string, DecisionQuestion>>;
}

/* The answers plus the connection that produced them, so a caller can record
   which of its workspace's providers answered without reading them itself. */
export interface AgentDecisionAnswers extends DecisionResult {
	readonly connection: { readonly id: string; readonly key: string };
}

/**
 * Typed questions for one workspace. A consumer resolves it optionally: an
 * absent capability, a workspace that has not turned decisions on and a
 * provider failure all leave the caller on its own deterministic path.
 */
export interface AgentDecisions {
	available(tenantId: string): Promise<boolean>;
	ask(request: AgentDecisionAsk): Promise<AgentDecisionAnswers>;
}

export function createAgentDecisions(
	service: () => AgentDecisionService | Promise<AgentDecisionService>,
): AgentDecisions {
	return {
		async available(tenantId) {
			return (await service()).available(tenantId);
		},
		async ask(request) {
			return (await service()).ask(request);
		},
	};
}
