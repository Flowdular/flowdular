import type {
	AgentExecutionEvent,
	AgentExecutionResult,
} from '@coreloom/harness';
import type {
	AgentAuditEvent,
	AgentAuditPage,
	AgentDefinition,
	AgentDefinitionRevision,
	ModuleAgentBinding,
	ModuleAgentDefinition,
	AgentActionInvocation,
	AgentRun,
	AgentRunDetail,
	AgentRunExecution,
	AgentSkill,
	AgentUsageAgent,
	AgentUsageBucket,
	AgentUsageDay,
	AuditChainVerification,
} from '../domain/types.ts';

export class DuplicateAgentKeyError extends Error {
	constructor() {
		super('An agent with this key already exists in the active tenant.');
		this.name = 'DuplicateAgentKeyError';
	}
}

export class DuplicateAgentSkillKeyError extends Error {
	constructor() {
		super('An agent skill with this key already exists in the active tenant.');
		this.name = 'DuplicateAgentSkillKeyError';
	}
}

export class DuplicateRunIdempotencyKeyError extends Error {
	constructor() {
		super(
			'A run with this idempotency key already exists in the active tenant.',
		);
		this.name = 'DuplicateRunIdempotencyKeyError';
	}
}

export class DuplicateActionIdempotencyKeyError extends Error {
	constructor() {
		super('An action invocation with this idempotency key already exists.');
		this.name = 'DuplicateActionIdempotencyKeyError';
	}
}

export class ModuleAgentBindingConflictError extends Error {
	constructor() {
		super('The module agent binding was changed by another request.');
		this.name = 'ModuleAgentBindingConflictError';
	}
}

export interface RecoverableRun {
	readonly tenantId: string;
	readonly runId: string;
}

export interface CompletedRunCost {
	readonly day: string;
	readonly costMicroUsd: number | null;
}

export type PendingAgentAuditEvent = Omit<
	AgentAuditEvent,
	'id' | 'sequence' | 'previousHash' | 'eventHash'
>;

export interface AgentRepository {
	reconcileModuleAgents(
		definitions: readonly ModuleAgentDefinition[],
		reconciledAt: number,
	): void;
	listModuleAgentBindings(tenantId: string): readonly ModuleAgentBinding[];
	getModuleAgentBinding(
		tenantId: string,
		agentId: string,
	): ModuleAgentBinding | null;
	saveModuleAgentBinding(
		binding: ModuleAgentBinding,
		definition: ModuleAgentDefinition,
		expectedRevision: number,
		audit: PendingAgentAuditEvent,
	): ModuleAgentBinding;
	listAgents(tenantId: string): readonly AgentDefinition[];
	getAgent(tenantId: string, agentId: string): AgentDefinition | null;
	getAgentRevision(
		tenantId: string,
		agentId: string,
		revision: number,
	): AgentDefinitionRevision | null;
	listAgentRevisions(tenantId: string): readonly AgentDefinitionRevision[];
	createAgent(agent: AgentDefinition): AgentDefinition;
	updateAgent(agent: AgentDefinition): AgentDefinition;
	deleteAgent(tenantId: string, agentId: string): boolean;
	agentUsage(
		tenantId: string,
		agentId: string,
	): {
		readonly runs: number;
		readonly pendingRuns: number;
		readonly assignments: number;
	};
	providerUsage(
		tenantId: string,
		providerId: string,
	): { readonly definitions: number; readonly pendingRuns: number };
	listSkills(tenantId: string): readonly AgentSkill[];
	getSkill(tenantId: string, skillId: string): AgentSkill | null;
	createSkill(skill: AgentSkill): AgentSkill;
	updateSkill(skill: AgentSkill): AgentSkill;
	deleteSkill(tenantId: string, skillId: string): boolean;
	skillUsage(
		tenantId: string,
		skillId: string,
	): { readonly assignments: number; readonly activeDefinitions: number };
	listRuns(tenantId: string, limit: number): readonly AgentRun[];
	getRun(tenantId: string, runId: string): AgentRunDetail | null;
	listRunEvents(
		tenantId: string,
		runId: string,
		afterSequence: number,
	): readonly AgentExecutionEvent[];
	findRunByIdempotencyKey(
		tenantId: string,
		idempotencyKey: string,
	): AgentRun | null;
	enqueueRun(
		run: AgentRunExecution,
		idempotencyKey: string | null,
		audit: PendingAgentAuditEvent,
	): AgentRun;
	listRecoverableRuns(now: number, limit: number): readonly RecoverableRun[];
	claimRun(
		tenantId: string,
		runId: string,
		workerId: string,
		now: number,
		leaseExpiresAt: number,
		audit: PendingAgentAuditEvent,
	): AgentRunExecution | null;
	renewLease(
		tenantId: string,
		runId: string,
		workerId: string,
		leaseExpiresAt: number,
	): boolean;
	consumeRunGrant(input: {
		readonly grantId: string;
		readonly tokenHash: string;
		readonly tenantId: string;
		readonly runId: string;
		readonly workerId: string;
		readonly providerId: string;
		readonly modelId: string;
		readonly issuedAt: number;
		readonly expiresAt: number;
		readonly consumedAt: number;
	}): boolean;
	appendRunEvent(
		tenantId: string,
		runId: string,
		event: AgentExecutionEvent,
	): void;
	completeRun(
		tenantId: string,
		runId: string,
		workerId: string,
		result: AgentExecutionResult,
		audit: PendingAgentAuditEvent,
	): void;
	failRun(
		tenantId: string,
		runId: string,
		workerId: string,
		code: string,
		message: string,
		completedAt: number,
		audit: PendingAgentAuditEvent,
	): void;
	/* Returns the status the run had, or null when it was already terminal. */
	cancelRun(
		tenantId: string,
		runId: string,
		message: string,
		completedAt: number,
		audit: PendingAgentAuditEvent,
	): AgentRun['status'] | null;
	enqueueAction(
		invocation: AgentActionInvocation,
		audit: PendingAgentAuditEvent,
	): AgentActionInvocation;
	getAction(
		tenantId: string,
		invocationId: string,
	): AgentActionInvocation | null;
	findActionByIdempotencyKey(
		tenantId: string,
		idempotencyKey: string,
	): AgentActionInvocation | null;
	listRecoverableActions(
		now: number,
		limit: number,
	): readonly { readonly tenantId: string; readonly invocationId: string }[];
	claimAction(
		tenantId: string,
		invocationId: string,
		workerId: string,
		now: number,
		leaseExpiresAt: number,
		audit: PendingAgentAuditEvent,
	): AgentActionInvocation | null;
	renewActionLease(
		tenantId: string,
		invocationId: string,
		workerId: string,
		leaseExpiresAt: number,
	): boolean;
	completeAction(
		tenantId: string,
		invocationId: string,
		workerId: string,
		output: import('@coreloom/harness').JsonValue,
		completedAt: number,
		audit: PendingAgentAuditEvent,
	): boolean;
	failAction(
		tenantId: string,
		invocationId: string,
		workerId: string,
		code: string,
		completedAt: number,
		audit: PendingAgentAuditEvent,
	): boolean;
	cancelAction(
		tenantId: string,
		invocationId: string,
		completedAt: number,
		audit: PendingAgentAuditEvent,
	): AgentActionInvocation['status'] | null;
	appendAuditEvent(event: PendingAgentAuditEvent): AgentAuditEvent;
	listAuditEvents(tenantId: string, limit: number): readonly AgentAuditEvent[];
	/* Keyset page over the tenant trail, newest first, cursor `occurredAt:sequence`. */
	pageAuditEvents(
		tenantId: string,
		cursor: { readonly occurredAt: number; readonly sequence: number } | null,
		limit: number,
	): AgentAuditPage;
	verifyAuditChain(tenantId: string): boolean;
	verifyAuditChainDetailed(tenantId: string): AuditChainVerification;
	usageByDay(
		tenantId: string,
		fromDay: string,
		toDay: string,
	): readonly AgentUsageDay[];
	usageByAgent(
		tenantId: string,
		fromDay: string,
		toDay: string,
	): readonly AgentUsageAgent[];
	/* One indexed aggregate; `agentId` narrows it to a single agent's spend. */
	usageTotal(
		tenantId: string,
		fromDay: string,
		agentId: string | null,
	): AgentUsageBucket;
}
