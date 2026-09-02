import type {
	AgentExecutionDefinition,
	AgentExecutionEvent,
	AgentOutputContract,
	AgentRunTrigger,
	AgentUsage,
	JsonValue,
} from '@coreloom/harness';
import type { Actor, UserActor } from '@coreloom/kernel';
import type { RunTimelineEntry } from './run-timeline.ts';

export type { AgentRunTrigger } from '@coreloom/harness';

export type AgentStatus = 'draft' | 'active' | 'paused' | 'archived';

export type AgentOwnership =
	| { readonly kind: 'tenant' }
	| {
			readonly kind: 'module';
			readonly moduleId: string;
			readonly definitionRevision: number;
	  };

export interface ModuleAgentExecutionLimits {
	readonly maxSteps: number;
	readonly timeoutMs: number;
	readonly temperature: number;
	readonly maxOutputTokens: number;
}

export interface ModuleAgentDefinitionInput {
	readonly moduleId: string;
	readonly key: string;
	readonly definitionRevision: number;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly allowedTools: readonly string[];
	readonly limits: ModuleAgentExecutionLimits;
}

export interface ModuleAgentDefinition
	extends Readonly<ModuleAgentDefinitionInput> {
	readonly id: string;
	readonly ownership: {
		readonly kind: 'module';
		readonly moduleId: string;
		readonly definitionRevision: number;
	};
}

export interface ModuleAgentBinding {
	readonly tenantId: string;
	readonly agentId: string;
	readonly provider: string;
	readonly model: string;
	readonly enabledTools: readonly string[];
	readonly status: 'active' | 'paused';
	readonly moduleDefinitionRevision: number;
	readonly executableRevision: number;
	readonly revision: number;
	readonly updatedBy: string;
	readonly updatedAt: number;
}

export interface UpdateModuleAgentBindingInput {
	readonly agentId: string;
	readonly provider: string;
	readonly model: string;
	readonly enabledTools: readonly string[];
	readonly status: 'active' | 'paused';
	/* Zero creates the first binding. Positive values are optimistic concurrency. */
	readonly expectedRevision: number;
}

export interface ModuleAgentView {
	readonly id: string;
	readonly tenantId: string;
	readonly key: string;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly provider: string | null;
	readonly model: string | null;
	readonly allowedTools: readonly string[];
	readonly enabledTools: readonly string[];
	readonly limits: ModuleAgentExecutionLimits;
	readonly status: 'unconfigured' | 'active' | 'paused' | 'unavailable';
	readonly revision: number | null;
	readonly bindingRevision: number | null;
	readonly unavailableReason: string | null;
	readonly ownership: {
		readonly kind: 'module';
		readonly moduleId: string;
		readonly definitionRevision: number;
	};
}

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

/* Served representation of a tenant-created business agent. Persistence and
   mutation inputs remain unchanged while list consumers get the same explicit
   ownership discriminator as module-owned agents. */
export interface TenantAgentView extends AgentDefinition {
	readonly ownership: { readonly kind: 'tenant' };
}

export interface AgentRevisionSkill {
	readonly id: string;
	readonly key: string;
	readonly name: string;
	readonly revision: number;
	readonly instructions: string;
	readonly requiredTools: readonly string[];
}

/* An immutable executable definition. Runs at an exact revision read this
	store and never reconstruct historical behavior from the mutable agent row. */
export interface AgentDefinitionRevision {
	readonly tenantId: string;
	readonly agentId: string;
	readonly revision: number;
	readonly key: string;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly provider: string;
	readonly model: string;
	readonly allowedTools: readonly string[];
	readonly skills: readonly AgentRevisionSkill[];
	readonly maxSteps: number;
	readonly timeoutMs: number;
	readonly temperature: number;
	readonly maxOutputTokens: number;
	readonly status: AgentStatus;
	readonly ownership: AgentOwnership;
	readonly moduleDefinitionRevision: number | null;
	readonly retainedBy: string;
	readonly retainedAt: number;
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
	readonly structuredOutput: JsonValue | null;
	readonly outputContract: AgentOutputContract;
	readonly workflowRunId: string | null;
	readonly provider: string;
	readonly model: string;
	readonly requestedBy: string;
	/* Full authority identity. requestedBy remains the stable display-compatible
	   id for older API consumers. */
	readonly requestedActor: Actor;
	/* Audit provenance is separate from the live authorization authority. */
	readonly authorizationSubject: UserActor | null;
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

/* What a reader of one run receives. The stored events stay whole in
   `AgentRunDetail`; this shape carries them folded, so a streamed answer
   crosses the wire as one bounded entry instead of one row per token. */
export interface AgentRunTimeline extends AgentRun {
	readonly timeline: readonly RunTimelineEntry[];
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

export type AgentActionStatus =
	| 'queued'
	| 'running'
	| 'succeeded'
	| 'failed'
	| 'cancelled';

export interface AgentActionInvocation {
	readonly id: string;
	readonly tenantId: string;
	readonly workflowRunId: string;
	readonly nodeRunId: string;
	readonly actionId: string;
	readonly contractVersion: number;
	readonly actor: Actor;
	readonly authorizationSubject: UserActor | null;
	readonly permissionSnapshot: readonly string[];
	readonly input: JsonValue;
	readonly idempotencyKey: string;
	readonly requestHash: string;
	readonly status: AgentActionStatus;
	readonly output: JsonValue | null;
	readonly code: string | null;
	readonly attempt: number;
	readonly queuedAt: number;
	readonly startedAt: number | null;
	readonly completedAt: number | null;
	readonly leaseExpiresAt: number | null;
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

export interface AgentUsageBucket {
	readonly runs: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly costMicroUsd: number;
	/* Runs whose model has no published price; excluded from the cost. */
	readonly unpricedRuns: number;
}

export interface AgentUsageDay extends AgentUsageBucket {
	readonly day: string;
}

export interface AgentUsageAgent extends AgentUsageBucket {
	readonly agentId: string;
	readonly agentName: string;
}

export interface AgentUsageSummary {
	readonly from: string;
	readonly to: string;
	readonly days: readonly AgentUsageDay[];
	readonly agents: readonly AgentUsageAgent[];
	readonly month: AgentUsageBucket & { readonly from: string };
	readonly caps: {
		readonly monthlyCostMicroUsd: number;
		readonly agentMonthlyCostMicroUsd: number;
	};
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
		| 'agent-skill'
		| 'agent-schedule'
		| 'agent-trigger'
		| 'agent-action';
	readonly subjectId: string;
	readonly metadata: Readonly<Record<string, string | number | boolean>>;
	readonly occurredAt: number;
	readonly previousHash: string | null;
	readonly eventHash: string;
}

export interface AgentAuditPage {
	readonly events: readonly AgentAuditEvent[];
	/** `${occurredAt}:${sequence}` of the last event, or null when exhausted. */
	readonly nextCursor: string | null;
}

/* Reports whether the tenant hash chain reproduces, and the id of the first
   row that does not. The same walk backs the audit-verify CLI and the HTTP
   endpoint, so the two can never disagree. */
export interface AuditChainVerification {
	readonly verified: boolean;
	readonly brokenAt: string | null;
}
