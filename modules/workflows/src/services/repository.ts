import type { Actor, UserActor } from '@flowdular/kernel';
import type {
	JsonValue,
	WorkflowAuditEvent,
	WorkflowAuditVerification,
	WorkflowCostRollupV1,
	WorkflowDefinition,
	WorkflowDefinitionDetail,
	WorkflowEdgeTransfer,
	WorkflowExecutionOrigin,
	WorkflowGraphV1,
	WorkflowNodeAttempt,
	WorkflowNodeExecution,
	WorkflowPayloadEvidenceV1,
	WorkflowPublishedReference,
	WorkflowRevision,
	WorkflowRunDetail,
	WorkflowRunEventTypeV1,
	WorkflowRunEventV1,
	WorkflowRunFilters,
	WorkflowRunPage,
	WorkflowRunStatus,
	WorkflowRunSummary,
	WorkflowUsageRollupV1,
} from '../domain/types.ts';

export interface WorkflowDefinitionWrite {
	readonly definition: WorkflowDefinition;
	readonly revision: WorkflowRevision;
	readonly actor: Actor;
	readonly origin: WorkflowExecutionOrigin;
}

export interface WorkflowRunRecord extends WorkflowRunSummary {
	readonly tenantId: string;
	readonly authorizationSubject: UserActor | null;
	readonly graph: WorkflowGraphV1;
	readonly compiledOrder: readonly string[];
	readonly permissionSnapshot: readonly string[];
	readonly permissionDigest: string;
	readonly inputHash: string;
	readonly inputPayloadId: string;
	readonly idempotencyKey: string | null;
	readonly leaseOwner: string | null;
	readonly leaseExpiresAt: number | null;
	readonly cancellationRequestedAt: number | null;
}

export interface CreateWorkflowRunWrite {
	readonly run: WorkflowRunRecord;
	readonly input: JsonValue;
	readonly inputEvidence: WorkflowPayloadEvidenceV1;
}

export interface StartAttemptWrite {
	readonly tenantId: string;
	readonly runId: string;
	readonly nodeId: string;
	readonly nodeType: WorkflowNodeAttempt['nodeType'];
	readonly attempt: number;
	readonly semanticGroup: string;
	readonly sideEffectIdempotencyKey: string;
	readonly input: JsonValue;
	readonly inputEvidence: WorkflowPayloadEvidenceV1;
	readonly schemaId: string;
	readonly recordedAt: number;
	readonly virtualOffsetMs?: number;
}

export interface SettleAttemptWrite {
	readonly tenantId: string;
	readonly runId: string;
	readonly nodeId: string;
	readonly attempt: number;
	readonly status: 'succeeded' | 'failed' | 'refused' | 'cancelled';
	readonly outcomePort: string | null;
	readonly output?: JsonValue;
	readonly outputEvidence: WorkflowPayloadEvidenceV1;
	readonly schemaId: string;
	readonly failureCode: string | null;
	readonly retryClassification: 'retryable' | 'permanent' | null;
	readonly selectedBackoffMs: number | null;
	readonly nextAttemptAt: number | null;
	readonly recordedAt: number;
	readonly virtualOffsetMs?: number;
}

export interface SettleEdgeWrite {
	readonly tenantId: string;
	readonly runId: string;
	readonly transfer: WorkflowEdgeTransfer;
	readonly payload?: JsonValue;
	readonly virtualOffsetMs?: number;
}

export interface WorkflowAuditPage {
	readonly events: readonly WorkflowAuditEvent[];
	readonly nextCursor: string | null;
}

export interface WorkflowsRepository {
	listDefinitions(tenantId: string): Promise<readonly WorkflowDefinition[]>;
	findDefinition(
		tenantId: string,
		workflowId: string,
	): Promise<WorkflowDefinition | null>;
	findDefinitionByKey(
		tenantId: string,
		workflowKey: string,
	): Promise<WorkflowDefinition | null>;
	definitionDetail(
		tenantId: string,
		workflowId: string,
	): Promise<WorkflowDefinitionDetail | null>;
	createDefinition(
		write: WorkflowDefinitionWrite,
	): Promise<WorkflowDefinitionDetail>;
	saveDraft(
		write: WorkflowDefinitionWrite & { readonly expectedRevision: number },
	): Promise<WorkflowDefinitionDetail | 'conflict'>;
	publish(
		tenantId: string,
		workflowId: string,
		expectedRevision: number,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
		recordedAt: number,
	): Promise<WorkflowDefinitionDetail | 'conflict' | null>;
	archive(
		tenantId: string,
		workflowId: string,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
		recordedAt: number,
	): Promise<WorkflowDefinition | null>;
	deleteDraft(
		tenantId: string,
		workflowId: string,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
		recordedAt: number,
	): Promise<'deleted' | 'not-found' | 'in-use'>;
	listPublished(
		tenantId: string,
	): Promise<readonly WorkflowPublishedReference[]>;
	findRevision(
		tenantId: string,
		workflowId: string,
		revision: number,
	): Promise<WorkflowRevision | null>;
	createRun(write: CreateWorkflowRunWrite): Promise<WorkflowRunRecord>;
	findRunByIdempotency(
		tenantId: string,
		key: string,
	): Promise<WorkflowRunRecord | null>;
	getRun(tenantId: string, runId: string): Promise<WorkflowRunRecord | null>;
	listRuns(
		tenantId: string,
		filters: WorkflowRunFilters,
	): Promise<WorkflowRunPage>;
	runDetail(tenantId: string, runId: string): Promise<WorkflowRunDetail | null>;
	claimNext(
		workerId: string,
		now: number,
		leaseExpiresAt: number,
	): Promise<WorkflowRunRecord | null>;
	renewLease(
		tenantId: string,
		runId: string,
		workerId: string,
		leaseExpiresAt: number,
	): Promise<boolean>;
	releaseLease(
		tenantId: string,
		runId: string,
		workerId: string,
	): Promise<void>;
	appendRunEvent(
		tenantId: string,
		runId: string,
		type: WorkflowRunEventTypeV1,
		payload: Readonly<Record<string, JsonValue>>,
		recordedAt: number,
		virtualOffsetMs?: number,
	): Promise<WorkflowRunEventV1>;
	readEvents(
		tenantId: string,
		runId: string,
		afterSequence: number,
		limit: number,
	): Promise<readonly WorkflowRunEventV1[]>;
	startAttempt(
		write: StartAttemptWrite,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
	): Promise<WorkflowNodeAttempt>;
	markChildWaiting(
		tenantId: string,
		runId: string,
		nodeId: string,
		attempt: number,
		childKind: 'agent' | 'action',
		childId: string,
		observationDeadlineAt: number,
		recordedAt: number,
	): Promise<void>;
	settleAttempt(
		write: SettleAttemptWrite,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
	): Promise<WorkflowNodeAttempt>;
	settleEdge(write: SettleEdgeWrite): Promise<WorkflowEdgeTransfer>;
	markNodeSkipped(
		tenantId: string,
		runId: string,
		nodeId: string,
		reason: string,
		recordedAt: number,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
		virtualOffsetMs?: number,
	): Promise<void>;
	settleRun(
		tenantId: string,
		runId: string,
		status: Extract<
			WorkflowRunStatus,
			'succeeded' | 'failed' | 'refused' | 'cancelled'
		>,
		failureCode: string | null,
		output: JsonValue | undefined,
		outputEvidence: WorkflowPayloadEvidenceV1,
		usage: WorkflowUsageRollupV1,
		cost: WorkflowCostRollupV1,
		recordedAt: number,
		virtualOffsetMs?: number,
	): Promise<WorkflowRunRecord | null>;
	requestCancellation(
		tenantId: string,
		runId: string,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
		recordedAt: number,
	): Promise<{
		readonly run: WorkflowRunRecord;
		readonly requested: boolean;
	} | null>;
	readExecutionPayload(
		tenantId: string,
		runId: string,
		payloadId: string,
	): Promise<JsonValue>;
	readEdgePayload(
		tenantId: string,
		runId: string,
		edgeId: string,
	): Promise<JsonValue | undefined>;
	recordAgentUsage(
		tenantId: string,
		runId: string,
		childRunId: string,
		usage: {
			readonly inputTokens: number;
			readonly outputTokens: number;
			readonly totalTokens: number;
		},
	): Promise<void>;
	readNodeStates(
		tenantId: string,
		runId: string,
	): Promise<readonly WorkflowNodeExecution[]>;
	readEdgeTransfers(
		tenantId: string,
		runId: string,
	): Promise<readonly WorkflowEdgeTransfer[]>;
	listAudit(
		tenantId: string,
		limit: number,
		beforeSequence?: number,
	): Promise<WorkflowAuditPage>;
	verifyAudit(tenantId: string): Promise<WorkflowAuditVerification>;
	applyPayloadRetention(now: number, limit?: number): Promise<number>;
	countRuns(tenantId: string): Promise<number>;
	close(): Promise<void>;
}
