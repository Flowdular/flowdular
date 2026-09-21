import type {
	AgentExecutionDefinition,
	AgentExecutionEvent,
	AgentOutputContract,
	AgentRunTrigger,
	AgentUsage,
	JsonValue,
} from '@flowdular/harness';
import type { Actor, UserActor } from '@flowdular/kernel';
import type { RunTimelineEntry } from './run-timeline.ts';

export type { AgentRunTrigger } from '@flowdular/harness';

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

/**
 * Where the maximum tool allowlist comes from. `declared` is the module's own
 * source and is content-stable, so drift at one definition revision fails boot.
 * `registry` is the deployment's registered tool catalog, which changes with
 * the composed module set rather than with this module's source, so it is not
 * part of the definition's executable content.
 */
export type ModuleAgentAllowlistSource = 'declared' | 'registry';

export interface ModuleAgentDefinitionInput {
	readonly moduleId: string;
	readonly key: string;
	readonly definitionRevision: number;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly allowedTools: readonly string[];
	readonly allowlistSource?: ModuleAgentAllowlistSource;
	readonly limits: ModuleAgentExecutionLimits;
}

export interface ModuleAgentDefinition
	extends Readonly<ModuleAgentDefinitionInput> {
	readonly id: string;
	readonly allowlistSource: ModuleAgentAllowlistSource;
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
	| 'anthropic'
	| 'typesafe';

/* Kinds that answer typed questions instead of generating text. Such a
   connection is stored and sealed like any other and is never an agent's
   model: it streams nothing and calls no tool. */
export type DecisionProviderKind = 'typesafe';

export const DECISION_PROVIDER_KINDS: readonly DecisionProviderKind[] = [
	'typesafe',
];

/* A predicate, so a caller that refused a decision kind is left holding the
   language-model kinds the provider contracts accept. */
export function isDecisionProviderKind(
	kind: AgentProviderKind,
): kind is DecisionProviderKind {
	return (DECISION_PROVIDER_KINDS as readonly string[]).includes(kind);
}

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
	/* Consent for the caller kind, set by an owner beside the credential. A
	   language-model connection carries it too and ignores it. */
	readonly allowWorkflows: boolean;
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
	readonly allowWorkflows?: boolean;
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
	readonly allowWorkflows?: boolean;
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
	readonly procedureIds: readonly string[];
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

export interface AgentRevisionProcedure {
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
	readonly procedures: readonly AgentRevisionProcedure[];
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
	readonly procedureIds: readonly string[];
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
	readonly procedureSnapshots: readonly AgentProcedureSnapshot[];
	readonly usage: AgentUsage | null;
	readonly failureCode: string | null;
	readonly failureMessage: string | null;
	readonly attempt: number;
	readonly queuedAt: number;
	readonly startedAt: number | null;
	readonly completedAt: number | null;
	readonly leaseExpiresAt: number | null;
}

export type AgentProcedureStatus = 'draft' | 'active' | 'archived';

export interface AgentProcedure {
	readonly id: string;
	readonly tenantId: string;
	readonly key: string;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly requiredTools: readonly string[];
	readonly status: AgentProcedureStatus;
	readonly revision: number;
	readonly createdBy: string;
	readonly createdAt: number;
	readonly updatedBy: string;
	readonly updatedAt: number;
}

export interface AgentProcedureSnapshot {
	readonly id: string;
	readonly key: string;
	readonly name: string;
	readonly revision: number;
	readonly requiredTools: readonly string[];
}

export interface CreateAgentProcedureInput {
	readonly key: string;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly requiredTools: readonly string[];
	readonly status: AgentProcedureStatus;
}

export interface UpdateAgentProcedureInput extends CreateAgentProcedureInput {
	readonly expectedRevision: number;
}

/* Deprecated for the 0.x line. New code uses the procedure names; these keep a
   consumer that still imports the skill-era spelling compiling. */
/** @deprecated Use AgentProcedure. */
export type AgentSkill = AgentProcedure;
/** @deprecated Use AgentProcedureStatus. */
export type AgentSkillStatus = AgentProcedureStatus;
/** @deprecated Use AgentProcedureSnapshot. */
export type AgentSkillSnapshot = AgentProcedureSnapshot;
/** @deprecated Use AgentRevisionProcedure. */
export type AgentRevisionSkill = AgentRevisionProcedure;
/** @deprecated Use CreateAgentProcedureInput. */
export type CreateAgentSkillInput = CreateAgentProcedureInput;
/** @deprecated Use UpdateAgentProcedureInput. */
export type UpdateAgentSkillInput = UpdateAgentProcedureInput;

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
		| 'agent-action'
		| 'assistant-thread';
	readonly subjectId: string;
	readonly metadata: Readonly<Record<string, string | number | boolean>>;
	readonly occurredAt: number;
	readonly previousHash: string | null;
	readonly eventHash: string;
}

/**
 * A conversation with the workspace assistant. It belongs to one workspace and
 * to the member who started it; no owner-level permission opens its text.
 */
export interface AssistantThread {
	readonly id: string;
	readonly tenantId: string;
	readonly accountId: string;
	readonly title: string;
	readonly turnCount: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export type AssistantTurnStatus = 'pending' | 'answered' | 'failed';

/**
 * One question and the answer it received. Both are the turn's own text beside
 * the run id, so the thread still reads once run retention has swept the run.
 */
export interface AssistantTurn {
	readonly id: string;
	readonly threadId: string;
	readonly tenantId: string;
	readonly accountId: string;
	readonly sequence: number;
	readonly question: string;
	readonly answer: string | null;
	readonly runId: string | null;
	readonly status: AssistantTurnStatus;
	readonly failureCode: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface AssistantConversation {
	readonly thread: AssistantThread;
	readonly turns: readonly AssistantTurn[];
}

export interface AssistantThreadListQuery {
	readonly limit: number;
	readonly after: { readonly updatedAt: number; readonly id: string } | null;
}

/** What one turn's run reported once it reached a terminal state. */
export interface AssistantTurnOutcome {
	readonly answer: string | null;
	readonly status: Exclude<AssistantTurnStatus, 'pending'>;
	readonly failureCode: string | null;
	readonly settledAt: number;
}

/**
 * What the header entry needs to choose between a conversation and the locked
 * state, and where to send a member who must configure what is missing.
 */
export interface AssistantReadiness {
	readonly enabled: boolean;
	readonly permitted: boolean;
	readonly providerReady: boolean;
	readonly bindingConfigured: boolean;
	readonly ready: boolean;
	readonly agentId: string;
	/** The screen that carries the missing configuration, or null when ready. */
	readonly configureHref: string | null;
	readonly lockedReason:
		| 'disabled'
		| 'forbidden'
		| 'provider-missing'
		| 'binding-missing'
		| null;
}

export type ListDirection = 'asc' | 'desc';

export type AgentListSort = 'name' | 'updatedAt';

/* One page of tenant definitions. `after` is the keyset of the last row of the
   previous page: the collation key SQL computed for a name sort, so a cursor
   never carries a JavaScript lowercase that PostgreSQL would order elsewhere. */
export interface AgentListQuery {
	readonly sort: AgentListSort;
	readonly direction: ListDirection;
	readonly search: string | null;
	readonly limit: number;
	readonly after: {
		readonly sortValue: string | number;
		readonly id: string;
	} | null;
}

export interface AgentListPage {
	readonly agents: readonly AgentDefinition[];
	/** The keyset of the last row, from which the caller signs the next cursor. */
	readonly last: {
		readonly nameKey: string;
		readonly updatedAt: number;
		readonly id: string;
	} | null;
}

export interface AgentRunListQuery {
	readonly direction: ListDirection;
	readonly status: AgentRunStatus | null;
	readonly agentId: string | null;
	readonly trigger: AgentRunTrigger | null;
	readonly search: string | null;
	readonly limit: number;
	readonly after: { readonly queuedAt: number; readonly id: string } | null;
}

export interface AgentAuditListQuery {
	readonly limit: number;
	readonly after: {
		readonly occurredAt: number;
		readonly sequence: number;
	} | null;
}

/* Reports whether the tenant hash chain reproduces, and the id of the first
   row that does not. The same walk backs the audit-verify CLI and the HTTP
   endpoint, so the two can never disagree. */
export interface AuditChainVerification {
	readonly verified: boolean;
	readonly brokenAt: string | null;
}
