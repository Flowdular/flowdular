import type { Actor } from '@flowdular/kernel';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

export type JsonSchemaV1 = Readonly<Record<string, JsonValue>>;

export const WORKFLOW_LIMITS = Object.freeze({
	maxNodes: 100,
	maxEdges: 200,
	maxSchemas: 32,
	maxGraphBytes: 64 * 1024,
	maxInputBytes: 64 * 1024,
	maxEnvelopeBytes: 64 * 1024,
	maxSafePayloadBytes: 1024 * 1024,
	maxAttemptsPerNode: 5,
	maxChildObservationMs: 60 * 60 * 1000,
	maxLiveDurationMs: 24 * 60 * 60 * 1000,
	maxRunEvents: 10_000,
	maxInteractivePage: 100,
	maxReplayEvents: 100,
});

export interface WorkflowPortV1 {
	readonly name: string;
	readonly schemaId: string;
}

export interface WorkflowNodeFailurePolicyV1 {
	readonly maxAttempts: number;
	readonly retryOn: readonly string[];
	readonly backoff: {
		readonly kind: 'fixed' | 'exponential';
		readonly initialMs: number;
		readonly maximumMs: number;
	};
	readonly onExhausted: 'emit-failure' | 'fail-run';
}

export type WorkflowBindingV1 =
	| { readonly kind: 'literal'; readonly value: JsonValue }
	| {
			readonly kind: 'path';
			readonly sourceNodeId: string;
			readonly sourcePort: string;
			readonly pointer: string;
	  }
	| {
			readonly kind: 'template';
			readonly template: string;
			readonly variables: readonly {
				readonly name: string;
				readonly sourceNodeId: string;
				readonly sourcePort: string;
				readonly pointer: string;
			}[];
	  };

export interface WorkflowTargetMappingV1 {
	readonly targetPointer: string;
	readonly binding: WorkflowBindingV1;
}

export type WorkflowGateExpressionV1 =
	| { readonly op: 'literal'; readonly value: JsonValue }
	| { readonly op: 'path'; readonly pointer: string }
	| { readonly op: 'exists'; readonly value: WorkflowGateExpressionV1 }
	| { readonly op: 'not'; readonly value: WorkflowGateExpressionV1 }
	| {
			readonly op: 'and' | 'or';
			readonly values: readonly WorkflowGateExpressionV1[];
	  }
	| {
			readonly op: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';
			readonly left: WorkflowGateExpressionV1;
			readonly right: WorkflowGateExpressionV1;
	  };

interface WorkflowNodeBaseV1 {
	readonly id: string;
	readonly label: string;
	readonly inputPorts: readonly WorkflowPortV1[];
	readonly outputPorts: readonly WorkflowPortV1[];
	readonly mappings?: readonly WorkflowTargetMappingV1[];
	readonly failurePolicy?: WorkflowNodeFailurePolicyV1;
}

export interface WorkflowInputNodeV1 extends WorkflowNodeBaseV1 {
	readonly type: 'input';
}

export interface WorkflowAgentNodeV1 extends WorkflowNodeBaseV1 {
	readonly type: 'agent';
	readonly agent: { readonly agentId: string; readonly revision: number };
	/* The published graph pins the smallest tool set this node may use. */
	readonly toolGrants: readonly string[];
	readonly outputSchemaId: string;
}

export interface WorkflowAgentDecisionNodeV1 extends WorkflowNodeBaseV1 {
	readonly type: 'agent-decision';
	readonly agent: { readonly agentId: string; readonly revision: number };
	/* The published graph pins the smallest tool set this node may use. */
	readonly toolGrants: readonly string[];
	readonly passSchemaId: string;
	readonly failSchemaId: string;
}

export interface WorkflowGateNodeV1 extends WorkflowNodeBaseV1 {
	readonly type: 'gate';
	readonly logicVersion: 1;
	readonly expression: WorkflowGateExpressionV1;
}

export interface WorkflowValidatorNodeV1 extends WorkflowNodeBaseV1 {
	readonly type: 'validator';
	readonly schemaId: string;
}

export interface WorkflowActionNodeV1 extends WorkflowNodeBaseV1 {
	readonly type: 'action';
	readonly action: {
		readonly actionId: string;
		readonly contractVersion: number;
	};
}

export interface WorkflowMergeNodeV1 extends WorkflowNodeBaseV1 {
	readonly type: 'merge';
	readonly mode: 'all';
}

export interface WorkflowOutputNodeV1 extends WorkflowNodeBaseV1 {
	readonly type: 'output';
}

export type WorkflowNodeV1 =
	| WorkflowInputNodeV1
	| WorkflowAgentNodeV1
	| WorkflowAgentDecisionNodeV1
	| WorkflowGateNodeV1
	| WorkflowValidatorNodeV1
	| WorkflowActionNodeV1
	| WorkflowMergeNodeV1
	| WorkflowOutputNodeV1;

export interface WorkflowEdgeV1 {
	readonly id: string;
	readonly source: { readonly nodeId: string; readonly port: string };
	readonly target: { readonly nodeId: string; readonly port: string };
	readonly label?: string;
}

export interface WorkflowGraphV1 {
	readonly schemaVersion: 1;
	readonly nodes: readonly WorkflowNodeV1[];
	readonly edges: readonly WorkflowEdgeV1[];
	readonly schemas: Readonly<Record<string, JsonSchemaV1>>;
	readonly layout: Readonly<
		Record<string, { readonly x: number; readonly y: number }>
	>;
}

export interface WorkflowDefinition {
	readonly id: string;
	readonly tenantId: string;
	readonly key: string;
	readonly name: string;
	readonly description: string;
	readonly status: 'active' | 'archived';
	readonly currentDraftRevision: number;
	readonly publishedRevision: number | null;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export type WorkflowsDefinition = WorkflowDefinition;

export interface WorkflowRevision {
	readonly id: string;
	readonly workflowId: string;
	readonly revision: number;
	readonly graph: WorkflowGraphV1;
	readonly graphChecksum: string;
	readonly compilerVersion: 1;
	readonly compiledOrder: readonly string[];
	readonly publishedAt: number | null;
	readonly publishedBy: Actor | null;
}

export interface WorkflowDefinitionDetail {
	readonly definition: WorkflowDefinition;
	readonly draft: WorkflowRevision;
	readonly revisions: readonly WorkflowRevision[];
}

export interface CreateWorkflowDefinitionInput {
	readonly key: string;
	readonly name: string;
	readonly description: string;
}

export type CreateWorkflowsDefinitionInput = CreateWorkflowDefinitionInput;

export interface UpdateWorkflowDraftInput {
	readonly workflowId: string;
	readonly expectedRevision: number;
	readonly name: string;
	readonly description: string;
	readonly graph: WorkflowGraphV1;
}

export type WorkflowValidationLocationV1 =
	| { readonly kind: 'graph'; readonly path?: string }
	| { readonly kind: 'node'; readonly nodeId: string; readonly path?: string }
	| { readonly kind: 'edge'; readonly edgeId: string; readonly path?: string };

export interface WorkflowValidationIssueV1 {
	readonly code: string;
	readonly severity: 'error' | 'warning';
	readonly message: string;
	readonly location: WorkflowValidationLocationV1;
}

export interface WorkflowReferenceSummaryV1 {
	readonly kind: 'agent' | 'action' | 'schema';
	readonly id: string;
	readonly version: string;
	readonly available: boolean;
}

export interface WorkflowDryRunResponseV1 {
	readonly reportVersion: 1;
	readonly graphChecksum: string;
	readonly valid: boolean;
	readonly issues: readonly WorkflowValidationIssueV1[];
	readonly compiledOrder: readonly string[];
	readonly references: readonly WorkflowReferenceSummaryV1[];
	readonly requiredPermissions: readonly string[];
	readonly limits: Readonly<Record<string, number>>;
}

export type WorkflowExecutionOrigin =
	| { readonly kind: 'manual' }
	| {
			readonly kind: 'module';
			readonly moduleId: string;
			readonly operationId: string;
	  }
	| { readonly kind: 'schedule'; readonly scheduleId: string }
	| { readonly kind: 'webhook'; readonly triggerId: string };

export type WorkflowRunMode = 'simulate' | 'live';
export type WorkflowRunStatus =
	| 'queued'
	| 'running'
	| 'waiting-agent'
	| 'waiting-retry'
	| 'cancel-requested'
	| 'succeeded'
	| 'failed'
	| 'refused'
	| 'cancelled';

export type WorkflowNodeStatus =
	| 'pending'
	| 'ready'
	| 'running'
	| 'waiting-child'
	| 'waiting-retry'
	| 'succeeded'
	| 'failed'
	| 'refused'
	| 'skipped'
	| 'cancelled';

export type WorkflowAttemptStatus =
	| 'running'
	| 'waiting-child'
	| 'succeeded'
	| 'failed'
	| 'refused'
	| 'cancelled';

export interface WorkflowUsageRollupV1 {
	readonly version: 1;
	readonly state: 'not-applicable' | 'provisional' | 'final';
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens: number;
	readonly includedChildRunIds: readonly string[];
	readonly pricedChildRuns: number;
	readonly unpricedChildRuns: number;
	readonly actionInvocations: number;
	readonly unpricedActions: number;
}

export interface WorkflowCostRollupV1 {
	readonly version: 1;
	readonly state: 'not-applicable' | 'provisional' | 'final';
	readonly currency: 'USD';
	readonly amountMicros: number;
	readonly pricingSnapshotIds: readonly string[];
	readonly unpricedChildRuns: number;
	readonly unpricedActions: number;
}

export interface WorkflowRunSummary {
	readonly id: string;
	readonly workflowId: string;
	readonly workflowKey: string;
	readonly workflowName: string;
	readonly workflowRevision: number | null;
	readonly graphChecksum: string;
	readonly mode: WorkflowRunMode;
	readonly status: WorkflowRunStatus;
	readonly actor: Actor;
	readonly origin: WorkflowExecutionOrigin;
	readonly queuedAt: number;
	readonly startedAt: number | null;
	readonly completedAt: number | null;
	readonly durationMs: number | null;
	readonly completedNodes: number;
	readonly totalNodes: number;
	readonly failureCode: string | null;
	readonly usage: WorkflowUsageRollupV1;
	readonly cost: WorkflowCostRollupV1;
}

export interface WorkflowPayloadEvidenceV1 {
	readonly version: 1;
	readonly state: 'available' | 'redacted' | 'truncated' | 'expired' | 'absent';
	readonly schemaId: string;
	readonly hash: string;
	readonly originalByteSize: number;
	readonly preview?: JsonValue;
	readonly reason?:
		| 'secret'
		| 'scope-denied'
		| 'size-limit'
		| 'retention'
		| 'not-emitted';
}

export interface WorkflowNodeAttempt {
	readonly nodeId: string;
	readonly attempt: number;
	readonly nodeType: WorkflowNodeV1['type'];
	readonly status: WorkflowAttemptStatus;
	readonly outcomePort: string | null;
	readonly semanticGroup: string;
	readonly sideEffectIdempotencyKey: string;
	readonly input: WorkflowPayloadEvidenceV1;
	readonly output: WorkflowPayloadEvidenceV1;
	readonly childKind: 'agent' | 'action' | null;
	readonly childId: string | null;
	readonly childObservationDeadlineAt: number | null;
	readonly failureCode: string | null;
	readonly retryClassification: 'retryable' | 'permanent' | null;
	readonly selectedBackoffMs: number | null;
	readonly nextAttemptAt: number | null;
	readonly startedAt: number;
	readonly completedAt: number | null;
	readonly durationMs: number | null;
}

export interface WorkflowNodeExecution {
	readonly nodeId: string;
	readonly status: WorkflowNodeStatus;
	readonly latestAttempt: number;
	readonly selectedOutcomePort: string | null;
	readonly nextAttemptAt: number | null;
	readonly readyAt: number | null;
	readonly startedAt: number | null;
	readonly settledAt: number | null;
	readonly attempts: readonly WorkflowNodeAttempt[];
}

export interface WorkflowEdgeTransfer {
	readonly edgeId: string;
	readonly sourceNodeId: string;
	readonly sourcePort: string;
	readonly sourceAttempt: number | null;
	readonly targetNodeId: string;
	readonly targetPort: string;
	readonly state: 'emitted' | 'closed' | 'skipped';
	readonly reason: string | null;
	readonly evidence: WorkflowPayloadEvidenceV1;
	readonly settledAt: number;
}

export type WorkflowRunEventTypeV1 =
	| 'run.queued'
	| 'run.claimed'
	| 'run.recovered'
	| 'node.ready'
	| 'node.attempt.started'
	| 'node.child.waiting'
	| 'node.attempt.settled'
	| 'node.retry.scheduled'
	| 'node.retry.started'
	| 'node.skipped'
	| 'edge.settled'
	| 'run.cancel.requested'
	| 'node.cancel.requested'
	| 'node.cancel.acknowledged'
	| 'node.cancel.not-acknowledged'
	| 'node.result.late-ignored'
	| 'payload.retention.applied'
	| 'run.succeeded'
	| 'run.failed'
	| 'run.refused'
	| 'run.cancelled';

export interface WorkflowRunEventV1 {
	readonly eventId: string;
	readonly schemaVersion: 1;
	readonly tenantId: string;
	readonly runId: string;
	readonly sequence: number;
	readonly type: WorkflowRunEventTypeV1;
	readonly recordedAt: number;
	readonly virtualOffsetMs?: number;
	readonly payload: Readonly<Record<string, JsonValue>>;
}

export interface WorkflowRunDetail {
	readonly run: WorkflowRunSummary;
	readonly graph: WorkflowGraphV1;
	readonly compiledOrder: readonly string[];
	readonly nodes: readonly WorkflowNodeExecution[];
	readonly edges: readonly WorkflowEdgeTransfer[];
	readonly events: readonly WorkflowRunEventV1[];
	readonly input: WorkflowPayloadEvidenceV1;
	readonly output: WorkflowPayloadEvidenceV1;
}

export interface WorkflowRunFilters {
	readonly workflowId?: string;
	readonly mode?: WorkflowRunMode;
	readonly status?: WorkflowRunStatus;
	readonly actorKind?: Actor['kind'];
	readonly originKind?: WorkflowExecutionOrigin['kind'];
	readonly limit?: number;
	readonly cursor?: string | null;
}

export interface WorkflowRunPage {
	readonly runs: readonly WorkflowRunSummary[];
	readonly nextCursor: string | null;
}

export interface WorkflowSimulationFixture {
	readonly nodeId: string;
	readonly outcomePort?: string;
	readonly output?: JsonValue;
	readonly failureCode?: string;
	readonly simulatedDurationMs?: number;
}

export interface WorkflowSimulationRequest {
	readonly workflowId: string;
	readonly input: JsonValue;
	readonly fixtures: readonly WorkflowSimulationFixture[];
}

export interface WorkflowEnqueueRequest {
	readonly workflowKey: string;
	readonly input: JsonValue;
	readonly idempotencyKey: string;
}

export interface WorkflowInvocationContext {
	readonly tenantId: string;
	readonly actor: Actor;
	/* Actor is audit provenance. This user is the live authorization subject. */
	readonly authorizationSubject?: import('@flowdular/kernel').UserActor;
	readonly origin: WorkflowExecutionOrigin;
	readonly permissionSnapshot: readonly string[];
}

export interface WorkflowCapabilityContext {
	readonly tenantId: string;
	readonly actor: Actor;
	readonly authorizationSubject?: import('@flowdular/kernel').UserActor;
	readonly permissionSnapshot: readonly string[];
}

export interface WorkflowRunAccepted {
	readonly runId: string;
	readonly workflowId: string;
	readonly workflowRevision: number;
	readonly status: 'queued';
	readonly created: boolean;
}

export interface WorkflowCancellationResult {
	readonly runId: string;
	readonly status: WorkflowRunStatus;
	readonly requested: boolean;
}

export interface WorkflowPublishedReference {
	readonly id: string;
	readonly key: string;
	readonly name: string;
	readonly revision: number;
	readonly graphChecksum: string;
}

export interface WorkflowPublishedInspection
	extends WorkflowPublishedReference {
	/* The exact live permission ceiling required by the pinned graph. */
	readonly requiredPermissions: readonly string[];
}

export interface WorkflowExecutionCapability {
	listPublished(
		context: WorkflowCapabilityContext,
	): Promise<readonly WorkflowPublishedReference[]>;
	getPublishedReference(
		workflowKey: string,
		context: WorkflowCapabilityContext,
	): Promise<WorkflowPublishedInspection | null>;
	enqueue(
		request: WorkflowEnqueueRequest,
		context: WorkflowInvocationContext,
	): Promise<WorkflowRunAccepted>;
	getRun(
		runId: string,
		context: WorkflowCapabilityContext,
	): Promise<WorkflowRunSummary | null>;
	cancel(
		runId: string,
		context: WorkflowCapabilityContext,
	): Promise<WorkflowCancellationResult>;
}

export const WORKFLOW_EXECUTION_CAPABILITY = 'workflows.execution.v1';

export interface WorkflowAuditEvent {
	readonly sequence: number;
	readonly actor: Actor;
	readonly origin: WorkflowExecutionOrigin;
	readonly action: string;
	readonly subjectType: 'workflow' | 'workflow-run' | 'workflow-node';
	readonly subjectId: string;
	readonly metadata: Readonly<Record<string, JsonValue>>;
	readonly occurredAt: number;
	readonly previousHash: string | null;
	readonly eventHash: string;
}

export interface WorkflowAuditVerification {
	readonly valid: boolean;
	readonly checkedThroughSequence: number;
	readonly firstBrokenSequence?: number;
	readonly expectedPreviousHash?: string | null;
	readonly actualPreviousHash?: string | null;
}
