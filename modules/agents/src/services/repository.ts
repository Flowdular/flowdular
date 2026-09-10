import type {
	AgentExecutionEvent,
	AgentExecutionResult,
} from '@flowdular/harness';
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
	AgentProcedure,
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

export class DuplicateAgentProcedureKeyError extends Error {
	constructor() {
		super(
			'An agent procedure with this key already exists in the active tenant.',
		);
		this.name = 'DuplicateAgentProcedureKeyError';
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
	close(): Promise<void>;
	reconcileModuleAgents(
		definitions: readonly ModuleAgentDefinition[],
		reconciledAt: number,
	): Promise<void>;
	listModuleAgentBindings(
		tenantId: string,
	): Promise<readonly ModuleAgentBinding[]>;
	getModuleAgentBinding(
		tenantId: string,
		agentId: string,
	): Promise<ModuleAgentBinding | null>;
	saveModuleAgentBinding(
		binding: ModuleAgentBinding,
		definition: ModuleAgentDefinition,
		expectedRevision: number,
		audit: PendingAgentAuditEvent,
	): Promise<ModuleAgentBinding>;
	listAgents(tenantId: string): Promise<readonly AgentDefinition[]>;
	getAgent(tenantId: string, agentId: string): Promise<AgentDefinition | null>;
	getAgentRevision(
		tenantId: string,
		agentId: string,
		revision: number,
	): Promise<AgentDefinitionRevision | null>;
	listAgentRevisions(
		tenantId: string,
	): Promise<readonly AgentDefinitionRevision[]>;
	createAgent(agent: AgentDefinition): Promise<AgentDefinition>;
	updateAgent(agent: AgentDefinition): Promise<AgentDefinition>;
	deleteAgent(tenantId: string, agentId: string): Promise<boolean>;
	agentUsage(
		tenantId: string,
		agentId: string,
	): Promise<{
		readonly runs: number;
		readonly pendingRuns: number;
		readonly assignments: number;
	}>;
	providerUsage(
		tenantId: string,
		providerId: string,
	): Promise<{ readonly definitions: number; readonly pendingRuns: number }>;
	listProcedures(tenantId: string): Promise<readonly AgentProcedure[]>;
	getProcedure(
		tenantId: string,
		procedureId: string,
	): Promise<AgentProcedure | null>;
	createProcedure(skill: AgentProcedure): Promise<AgentProcedure>;
	updateProcedure(skill: AgentProcedure): Promise<AgentProcedure>;
	deleteProcedure(tenantId: string, procedureId: string): Promise<boolean>;
	procedureUsage(
		tenantId: string,
		procedureId: string,
	): Promise<{
		readonly assignments: number;
		readonly activeDefinitions: number;
	}>;
	listRuns(tenantId: string, limit: number): Promise<readonly AgentRun[]>;
	getRun(tenantId: string, runId: string): Promise<AgentRunDetail | null>;
	listRunEvents(
		tenantId: string,
		runId: string,
		afterSequence: number,
	): Promise<readonly AgentExecutionEvent[]>;
	findRunByIdempotencyKey(
		tenantId: string,
		idempotencyKey: string,
	): Promise<AgentRun | null>;
	enqueueRun(
		run: AgentRunExecution,
		idempotencyKey: string | null,
		audit: PendingAgentAuditEvent,
	): Promise<AgentRun>;
	listRecoverableRuns(
		now: number,
		limit: number,
	): Promise<readonly RecoverableRun[]>;
	claimRun(
		tenantId: string,
		runId: string,
		workerId: string,
		now: number,
		leaseExpiresAt: number,
		audit: PendingAgentAuditEvent,
	): Promise<AgentRunExecution | null>;
	renewLease(
		tenantId: string,
		runId: string,
		workerId: string,
		leaseExpiresAt: number,
	): Promise<boolean>;
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
	}): Promise<boolean>;
	appendRunEvent(
		tenantId: string,
		runId: string,
		event: AgentExecutionEvent,
	): Promise<void>;
	completeRun(
		tenantId: string,
		runId: string,
		workerId: string,
		result: AgentExecutionResult,
		audit: PendingAgentAuditEvent,
	): Promise<void>;
	failRun(
		tenantId: string,
		runId: string,
		workerId: string,
		code: string,
		message: string,
		completedAt: number,
		audit: PendingAgentAuditEvent,
	): Promise<void>;
	/* Returns the status the run had, or null when it was already terminal. */
	cancelRun(
		tenantId: string,
		runId: string,
		message: string,
		completedAt: number,
		audit: PendingAgentAuditEvent,
	): Promise<AgentRun['status'] | null>;
	enqueueAction(
		invocation: AgentActionInvocation,
		audit: PendingAgentAuditEvent,
	): Promise<AgentActionInvocation>;
	getAction(
		tenantId: string,
		invocationId: string,
	): Promise<AgentActionInvocation | null>;
	findActionByIdempotencyKey(
		tenantId: string,
		idempotencyKey: string,
	): Promise<AgentActionInvocation | null>;
	listRecoverableActions(
		now: number,
		limit: number,
	): Promise<
		readonly { readonly tenantId: string; readonly invocationId: string }[]
	>;
	claimAction(
		tenantId: string,
		invocationId: string,
		workerId: string,
		now: number,
		leaseExpiresAt: number,
		audit: PendingAgentAuditEvent,
	): Promise<AgentActionInvocation | null>;
	renewActionLease(
		tenantId: string,
		invocationId: string,
		workerId: string,
		leaseExpiresAt: number,
	): Promise<boolean>;
	completeAction(
		tenantId: string,
		invocationId: string,
		workerId: string,
		output: import('@flowdular/harness').JsonValue,
		completedAt: number,
		audit: PendingAgentAuditEvent,
	): Promise<boolean>;
	failAction(
		tenantId: string,
		invocationId: string,
		workerId: string,
		code: string,
		completedAt: number,
		audit: PendingAgentAuditEvent,
	): Promise<boolean>;
	cancelAction(
		tenantId: string,
		invocationId: string,
		completedAt: number,
		audit: PendingAgentAuditEvent,
	): Promise<AgentActionInvocation['status'] | null>;
	appendAuditEvent(event: PendingAgentAuditEvent): Promise<AgentAuditEvent>;
	listAuditEvents(
		tenantId: string,
		limit: number,
	): Promise<readonly AgentAuditEvent[]>;
	/* Keyset page over the tenant trail, newest first, cursor `occurredAt:sequence`. */
	pageAuditEvents(
		tenantId: string,
		cursor: { readonly occurredAt: number; readonly sequence: number } | null,
		limit: number,
	): Promise<AgentAuditPage>;
	verifyAuditChain(tenantId: string): Promise<boolean>;
	verifyAuditChainDetailed(tenantId: string): Promise<AuditChainVerification>;
	usageByDay(
		tenantId: string,
		fromDay: string,
		toDay: string,
	): Promise<readonly AgentUsageDay[]>;
	usageByAgent(
		tenantId: string,
		fromDay: string,
		toDay: string,
	): Promise<readonly AgentUsageAgent[]>;
	/* One indexed aggregate; `agentId` narrows it to a single agent's spend. */
	usageTotal(
		tenantId: string,
		fromDay: string,
		agentId: string | null,
	): Promise<AgentUsageBucket>;
}
