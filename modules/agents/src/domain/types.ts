import type {
	AgentExecutionDefinition,
	AgentExecutionEvent,
	AgentRunTrigger,
	AgentUsage,
} from '@coreloom/harness';

export type { AgentRunTrigger } from '@coreloom/harness';

export type AgentStatus = 'draft' | 'active' | 'paused' | 'archived';

export type AgentProviderKind =
	| 'local-simulation'
	| 'vercel'
	| 'azure'
	| 'openai'
	| 'openai-compatible'
	| 'anthropic';

/* What a model is allowed to do. Sent by clients, stored as configuration. */
export interface AgentProviderModelConfiguration {
	readonly id: string;
	readonly label: string;
	readonly enabled: boolean;
	readonly supportsTools: boolean;
	readonly supportsStreaming: boolean;
	readonly supportsWebSearch: boolean;
	/* Reasoning models reject a custom temperature and only accept their own
	   default. Absent means the model accepts one. */
	readonly supportsTemperature?: boolean;
}

/* Evidence, not configuration: proven per model, because one model answering
   says nothing about another one on the same connection. */
export interface AgentModelReadiness {
	readonly status: 'unknown' | 'healthy' | 'unhealthy';
	readonly latencyMs: number | null;
	readonly errorCode: string | null;
	readonly checkedAt: number | null;
}

export interface AgentProviderModel extends AgentProviderModelConfiguration {
	readonly supportsTemperature: boolean;
	readonly readiness: AgentModelReadiness;
}

export interface AgentProviderConnection {
	readonly id: string;
	readonly tenantId: string;
	readonly key: string;
	readonly name: string;
	readonly kind: AgentProviderKind;
	readonly enabled: boolean;
	readonly resourceName: string | null;
	readonly baseURL: string | null;
	readonly models: readonly AgentProviderModel[];
	readonly credentialConfigured: boolean;
	readonly credentialRevision: number;
	readonly revision: number;
	readonly createdBy: string;
	readonly createdAt: number;
	readonly updatedBy: string;
	readonly updatedAt: number;
}

export interface CreateAgentProviderInput {
	readonly key: string;
	readonly name: string;
	readonly kind: Exclude<AgentProviderKind, 'local-simulation'>;
	readonly credential: string;
	readonly resourceName?: string;
	readonly baseURL?: string;
	readonly models: readonly AgentProviderModelConfiguration[];
}

export interface UpdateAgentProviderInput {
	readonly id: string;
	readonly expectedRevision: number;
	readonly name: string;
	readonly enabled: boolean;
	readonly credential?: string;
	readonly resourceName?: string;
	readonly baseURL?: string;
	readonly models: readonly AgentProviderModelConfiguration[];
}

export interface AgentDefinition {
	readonly id: string;
	readonly tenantId: string;
	readonly key: string;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly provider: string;
	readonly model: string;
	readonly allowedTools: readonly string[];
	readonly skillIds: readonly string[];
	readonly maxSteps: number;
	readonly timeoutMs: number;
	readonly temperature: number;
	readonly maxOutputTokens: number;
	readonly status: AgentStatus;
	readonly revision: number;
	readonly createdBy: string;
	readonly createdAt: number;
	readonly updatedBy: string;
	readonly updatedAt: number;
}

export interface CreateAgentInput {
	readonly key: string;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly provider: string;
	readonly model: string;
	readonly allowedTools: readonly string[];
	readonly skillIds: readonly string[];
	readonly maxSteps: number;
	readonly timeoutMs: number;
	readonly temperature: number;
	/* Absent means the tenant default, 4096 unless an admin changed it. */
	readonly maxOutputTokens?: number;
	readonly status: AgentStatus;
}

export interface UpdateAgentInput extends CreateAgentInput {
	readonly expectedRevision: number;
}

export type AgentRunStatus =
	| 'queued'
	| 'running'
	| 'succeeded'
	| 'failed'
	| 'cancelled';

export interface AgentRun {
	readonly id: string;
	readonly tenantId: string;
	readonly agentId: string;
	readonly agentName: string;
	readonly agentRevision: number;
	readonly trigger: AgentRunTrigger;
	readonly status: AgentRunStatus;
	readonly input: string;
	readonly output: string | null;
	readonly provider: string;
	readonly model: string;
	readonly requestedBy: string;
	readonly permissionSnapshot: readonly string[];
	readonly toolGrants: readonly string[];
	readonly skillSnapshots: readonly AgentSkillSnapshot[];
	readonly usage: AgentUsage | null;
	readonly failureCode: string | null;
	readonly failureMessage: string | null;
	readonly attempt: number;
	readonly queuedAt: number;
	readonly startedAt: number | null;
	readonly completedAt: number | null;
	readonly leaseExpiresAt: number | null;
}

export type AgentSkillStatus = 'draft' | 'active' | 'archived';

export interface AgentSkill {
	readonly id: string;
	readonly tenantId: string;
	readonly key: string;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly requiredTools: readonly string[];
	readonly status: AgentSkillStatus;
	readonly revision: number;
	readonly createdBy: string;
	readonly createdAt: number;
	readonly updatedBy: string;
	readonly updatedAt: number;
}

export interface AgentSkillSnapshot {
	readonly id: string;
	readonly key: string;
	readonly name: string;
	readonly revision: number;
	readonly requiredTools: readonly string[];
}

export interface CreateAgentSkillInput {
	readonly key: string;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly requiredTools: readonly string[];
	readonly status: AgentSkillStatus;
}

export interface UpdateAgentSkillInput extends CreateAgentSkillInput {
	readonly expectedRevision: number;
}

export interface AgentRunDetail extends AgentRun {
	readonly events: readonly AgentExecutionEvent[];
}

export interface EnqueueAgentRunInput {
	readonly agentId: string;
	readonly trigger: AgentRunTrigger;
	readonly input: string;
	readonly toolGrants: readonly string[];
	readonly idempotencyKey?: string;
}

export interface AgentRunExecution {
	readonly run: AgentRun;
	readonly definition: AgentExecutionDefinition;
}

/* What the playground shows about the process that executes runs. */
export interface AgentWorkerStatus {
	readonly workerId: string;
	readonly online: boolean;
	readonly concurrency: number;
	readonly inFlight: number;
	readonly leaseMs: number;
	readonly lastDrainAt: number | null;
}

export interface AgentAuditEvent {
	readonly id: string;
	readonly tenantId: string;
	readonly sequence: number;
	readonly actorId: string;
	readonly action: string;
	readonly subjectType:
		| 'agent'
		| 'agent-run'
		| 'agent-provider'
		| 'agent-skill';
	readonly subjectId: string;
	readonly metadata: Readonly<Record<string, string | number | boolean>>;
	readonly occurredAt: number;
	readonly previousHash: string | null;
	readonly eventHash: string;
}
