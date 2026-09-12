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

/** Where a run export page resumes: newest queue time first, then run id. */
export interface WorkflowRunExportCursor {
	readonly queuedAt: number;
	readonly id: string;
}

/** Where a definition export page resumes, in the workspace's name order. */
export interface WorkflowDefinitionExportCursor {
	readonly name: string;
	readonly id: string;
}

/**
 * One run as the workspace export presents it. Evidence carries the redacted
 * preview the run already recorded; the sealed execution payload stays in the
 * database.
 */
export interface ExportedWorkflowRun {
	readonly run: WorkflowRunRecord;
	readonly nodes: readonly WorkflowNodeExecution[];
	readonly edges: readonly WorkflowEdgeTransfer[];
}

/** One published workflow and the immutable revision it publishes. */
export interface ExportedWorkflowDefinition {
	readonly definition: WorkflowDefinition;
	readonly revision: WorkflowRevision;
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
	/**
	 * Parks an attempt on a child. `recheckAt` applies to the `approval` kind
	 * only: it is when the run, which leaves the claim queue entirely, looks at
	 * the request again without being woken.
	 */
	markChildWaiting(
		tenantId: string,
		runId: string,
		nodeId: string,
		attempt: number,
		childKind: 'agent' | 'action' | 'approval',
		childId: string,
		observationDeadlineAt: number,
		recordedAt: number,
		recheckAt?: number,
	): Promise<void>;
	/** Puts a run back to sleep on an approval that is still pending. */
	suspendApproval(
		tenantId: string,
		runId: string,
		nodeId: string,
		recheckAt: number,
	): Promise<void>;
	/** Makes a sleeping run claimable now, for the approval it is waiting on. */
	wakeApproval(
		tenantId: string,
		runId: string,
		requestId: string,
		now: number,
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
	/* Keyset page of the workspace trail in chain order, oldest first. */
	exportAuditEventsPage(
		tenantId: string,
		afterSequence: number,
		limit: number,
	): Promise<readonly WorkflowAuditEvent[]>;
	applyPayloadRetention(now: number, limit?: number): Promise<number>;
	/* Keyset page of the run export, newest queue time first, with the node
	   states, attempts and edge evidence of every run on the page. */
	exportRunsPage(
		tenantId: string,
		after: WorkflowRunExportCursor | null,
		limit: number,
	): Promise<readonly ExportedWorkflowRun[]>;
	/* Removes at most `limit` settled runs completed before `before`, with
	   their node states, attempts, edges, events and sealed payloads. A run
	   still working is never removed, whatever the age of the request. */
	deleteRunsSettledBefore(
		tenantId: string,
		before: number,
		limit: number,
	): Promise<number>;
	/* Removes at most `limit` runs one account is the person behind, in any
	   state: the ones it started itself, the ones a service actor it configured
	   started, and the ones an agent started on its behalf. */
	deleteRunsOfSubject(
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<number>;
	/* Keyset page of the published workflows, in the workspace's name order. */
	exportPublishedDefinitionsPage(
		tenantId: string,
		after: WorkflowDefinitionExportCursor | null,
		limit: number,
	): Promise<readonly ExportedWorkflowDefinition[]>;
	countRuns(tenantId: string): Promise<number>;
	close(): Promise<void>;
}
