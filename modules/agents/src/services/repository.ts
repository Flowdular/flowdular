import type {
	AgentExecutionEvent,
	AgentExecutionResult,
} from '@coreloom/harness';
import type {
	AgentAuditEvent,
	AgentDefinition,
	AgentRun,
	AgentRunDetail,
	AgentRunExecution,
	AgentSkill,
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

export interface RecoverableRun {
	readonly tenantId: string;
	readonly runId: string;
}

export interface AgentRepository {
	listAgents(tenantId: string): readonly AgentDefinition[];
	getAgent(tenantId: string, agentId: string): AgentDefinition | null;
	createAgent(agent: AgentDefinition): AgentDefinition;
	updateAgent(agent: AgentDefinition): AgentDefinition;
	listSkills(tenantId: string): readonly AgentSkill[];
	getSkill(tenantId: string, skillId: string): AgentSkill | null;
	createSkill(skill: AgentSkill): AgentSkill;
	updateSkill(skill: AgentSkill): AgentSkill;
	listRuns(tenantId: string, limit: number): readonly AgentRun[];
	getRun(tenantId: string, runId: string): AgentRunDetail | null;
	findRunByIdempotencyKey(
		tenantId: string,
		idempotencyKey: string,
	): AgentRun | null;
	enqueueRun(run: AgentRunExecution, idempotencyKey: string | null): AgentRun;
	listRecoverableRuns(now: number, limit: number): readonly RecoverableRun[];
	claimRun(
		tenantId: string,
		runId: string,
		workerId: string,
		now: number,
		leaseExpiresAt: number,
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
	): void;
	failRun(
		tenantId: string,
		runId: string,
		workerId: string,
		code: string,
		message: string,
		completedAt: number,
	): void;
	/* Returns the status the run had, or null when it was already terminal. */
	cancelRun(
		tenantId: string,
		runId: string,
		message: string,
		completedAt: number,
	): AgentRun['status'] | null;
	appendAuditEvent(
		event: Omit<
			AgentAuditEvent,
			'id' | 'sequence' | 'previousHash' | 'eventHash'
		>,
	): AgentAuditEvent;
	listAuditEvents(tenantId: string, limit: number): readonly AgentAuditEvent[];
	verifyAuditChain(tenantId: string): boolean;
}
