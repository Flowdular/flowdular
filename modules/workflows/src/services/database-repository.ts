import { createHash, randomUUID } from 'node:crypto';
import {
	integer,
	runDatabaseMigrations,
	type DatabaseHandle,
	type DatabaseTransaction,
} from '@flowdular/database';
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
	WorkflowUsageRollupV1,
} from '../domain/types.ts';
import { WORKFLOW_LIMITS } from '../domain/types.ts';
import { jsonByteSize, jsonHash } from '../domain/graph.ts';
import {
	projectWorkflowRunEvents,
	WorkflowEventProjectionError,
} from '../domain/events.ts';
import { databaseMigrations } from './migration.ts';
import type { WorkflowPayloadCodec } from './payload-codec.ts';
import type {
	CreateWorkflowRunWrite,
	ExportedWorkflowDefinition,
	ExportedWorkflowRun,
	SettleAttemptWrite,
	SettleEdgeWrite,
	StartAttemptWrite,
	WorkflowAuditPage,
	WorkflowDefinitionExportCursor,
	WorkflowDefinitionWrite,
	WorkflowRunExportCursor,
	WorkflowRunRecord,
	WorkflowsRepository,
} from './repository.ts';

const TERMINAL_RUNS = new Set<WorkflowRunStatus>([
	'succeeded',
	'failed',
	'refused',
	'cancelled',
]);

function optionalInteger(
	value: number | bigint | string | null,
	field: string,
): number | null {
	return value === null ? null : integer(value, field);
}

type Int = number | bigint | string;

interface DefinitionRow {
	id: string;
	tenant_id: string;
	workflow_key: string;
	name: string;
	description: string;
	status: WorkflowDefinition['status'];
	current_draft_revision: Int;
	published_revision: Int | null;
	created_at: Int;
	updated_at: Int;
}

interface RevisionRow {
	id: string;
	workflow_id: string;
	revision: Int;
	graph_json: string;
	graph_checksum: string;
	compiler_version: Int;
	compiled_order_json: string;
	published_at: Int | null;
	published_actor_json: string | null;
}

/** A definition and the revision it publishes, read in one statement. */
interface ExportDefinitionRow extends DefinitionRow {
	revision_id: string;
	revision_workflow_id: string;
	revision_number: Int;
	graph_json: string;
	graph_checksum: string;
	compiler_version: Int;
	compiled_order_json: string;
	published_at: Int | null;
	published_actor_json: string | null;
}

interface RunRow {
	id: string;
	tenant_id: string;
	workflow_id: string;
	workflow_key: string;
	workflow_name: string;
	workflow_revision: Int | null;
	graph_checksum: string;
	compiler_version: Int;
	graph_json: string;
	compiled_order_json: string;
	mode: WorkflowRunRecord['mode'];
	status: WorkflowRunStatus;
	actor_json: string;
	authorization_subject_json: string | null;
	origin_json: string;
	permission_snapshot_json: string;
	permission_digest: string;
	input_hash: string;
	input_payload_id: string;
	input_evidence_json: string;
	output_evidence_json: string | null;
	idempotency_key: string | null;
	lease_owner: string | null;
	lease_expires_at: Int | null;
	completed_nodes: Int;
	total_nodes: Int;
	usage_json: string;
	cost_json: string;
	failure_code: string | null;
	queued_at: Int;
	started_at: Int | null;
	completed_at: Int | null;
	cancellation_requested_at: Int | null;
}

interface NodeStateRow {
	node_id: string;
	status: WorkflowNodeExecution['status'];
	latest_attempt: Int;
	selected_outcome_port: string | null;
	next_attempt_at: Int | null;
	ready_at: Int | null;
	started_at: Int | null;
	settled_at: Int | null;
}

interface AttemptRow {
	node_id: string;
	attempt: Int;
	node_type: WorkflowNodeAttempt['nodeType'];
	status: WorkflowNodeAttempt['status'];
	outcome_port: string | null;
	semantic_group: string;
	side_effect_idempotency_key: string;
	input_evidence_json: string;
	output_evidence_json: string;
	child_kind: WorkflowNodeAttempt['childKind'];
	child_id: string | null;
	child_observation_deadline_at: Int | null;
	failure_code: string | null;
	retry_classification: WorkflowNodeAttempt['retryClassification'];
	selected_backoff_ms: Int | null;
	next_attempt_at: Int | null;
	started_at: Int;
	completed_at: Int | null;
	duration_ms: Int | null;
}

interface EdgeRow {
	edge_id: string;
	source_node_id: string;
	source_port: string;
	source_attempt: Int | null;
	target_node_id: string;
	target_port: string;
	state: WorkflowEdgeTransfer['state'];
	reason: string | null;
	evidence_json: string;
	settled_at: Int;
}

/** The run id a page of child rows carries, so one query serves many runs. */
interface ExportNodeStateRow extends NodeStateRow {
	run_id: string;
}

interface ExportAttemptRow extends AttemptRow {
	run_id: string;
}

interface ExportEdgeRow extends EdgeRow {
	run_id: string;
}

interface EventRow {
	event_id: string;
	tenant_id: string;
	run_id: string;
	sequence: Int;
	event_type: WorkflowRunEventTypeV1;
	payload_json: string;
	recorded_at: Int;
	virtual_offset_ms: Int | null;
}

interface AuditRow {
	sequence: Int;
	actor_json: string;
	origin_json: string;
	action: string;
	subject_type: WorkflowAuditEvent['subjectType'];
	subject_id: string;
	metadata_json: string;
	occurred_at: Int;
	previous_hash: string | null;
	event_hash: string;
}

/** Routing data the cross-tenant claim poll is allowed to read. */
interface RunRoutingRow {
	tenant_id: string;
	id: string;
}

/** Routing data the cross-tenant retention poll is allowed to read. */
interface PayloadRoutingRow {
	id: string;
	tenant_id: string;
	run_id: string;
	payload_hash: string;
}

function parse<T>(value: string): T {
	return JSON.parse(value) as T;
}

function definitionFromRow(row: DefinitionRow): WorkflowDefinition {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		key: row.workflow_key,
		name: row.name,
		description: row.description,
		status: row.status,
		currentDraftRevision: integer(
			row.current_draft_revision,
			'current_draft_revision',
		),
		publishedRevision: optionalInteger(
			row.published_revision,
			'published_revision',
		),
		createdAt: integer(row.created_at, 'created_at'),
		updatedAt: integer(row.updated_at, 'updated_at'),
	};
}

function revisionFromRow(row: RevisionRow): WorkflowRevision {
	return {
		id: row.id,
		workflowId: row.workflow_id,
		revision: integer(row.revision, 'revision'),
		graph: parse<WorkflowGraphV1>(row.graph_json),
		graphChecksum: row.graph_checksum,
		compilerVersion: integer(row.compiler_version, 'compiler_version') as 1,
		compiledOrder: parse<readonly string[]>(row.compiled_order_json),
		publishedAt: optionalInteger(row.published_at, 'published_at'),
		publishedBy:
			row.published_actor_json === null
				? null
				: parse<Actor>(row.published_actor_json),
	};
}

function nodeExecutionFromRow(
	row: NodeStateRow,
	attempts: readonly WorkflowNodeAttempt[],
): WorkflowNodeExecution {
	return {
		nodeId: row.node_id,
		status: row.status,
		latestAttempt: integer(row.latest_attempt, 'latest_attempt'),
		selectedOutcomePort: row.selected_outcome_port,
		nextAttemptAt: optionalInteger(row.next_attempt_at, 'next_attempt_at'),
		readyAt: optionalInteger(row.ready_at, 'ready_at'),
		startedAt: optionalInteger(row.started_at, 'started_at'),
		settledAt: optionalInteger(row.settled_at, 'settled_at'),
		attempts,
	};
}

function edgeFromRow(row: EdgeRow): WorkflowEdgeTransfer {
	return {
		edgeId: row.edge_id,
		sourceNodeId: row.source_node_id,
		sourcePort: row.source_port,
		sourceAttempt: optionalInteger(row.source_attempt, 'source_attempt'),
		targetNodeId: row.target_node_id,
		targetPort: row.target_port,
		state: row.state,
		reason: row.reason,
		evidence: parse<WorkflowPayloadEvidenceV1>(row.evidence_json),
		settledAt: integer(row.settled_at, 'settled_at'),
	};
}

function runFromRow(row: RunRow): WorkflowRunRecord {
	const queuedAt = integer(row.queued_at, 'queued_at');
	const completedAt = optionalInteger(row.completed_at, 'completed_at');
	return {
		id: row.id,
		tenantId: row.tenant_id,
		workflowId: row.workflow_id,
		workflowKey: row.workflow_key,
		workflowName: row.workflow_name,
		workflowRevision: optionalInteger(
			row.workflow_revision,
			'workflow_revision',
		),
		graphChecksum: row.graph_checksum,
		graph: parse<WorkflowGraphV1>(row.graph_json),
		compiledOrder: parse<readonly string[]>(row.compiled_order_json),
		mode: row.mode,
		status: row.status,
		actor: parse<Actor>(row.actor_json),
		authorizationSubject:
			row.authorization_subject_json === null
				? null
				: parse<UserActor>(row.authorization_subject_json),
		origin: parse<WorkflowExecutionOrigin>(row.origin_json),
		permissionSnapshot: parse<readonly string[]>(row.permission_snapshot_json),
		permissionDigest: row.permission_digest,
		inputHash: row.input_hash,
		inputPayloadId: row.input_payload_id,
		idempotencyKey: row.idempotency_key,
		leaseOwner: row.lease_owner,
		leaseExpiresAt: optionalInteger(row.lease_expires_at, 'lease_expires_at'),
		completedNodes: integer(row.completed_nodes, 'completed_nodes'),
		totalNodes: integer(row.total_nodes, 'total_nodes'),
		usage: parse<WorkflowUsageRollupV1>(row.usage_json),
		cost: parse<WorkflowCostRollupV1>(row.cost_json),
		failureCode: row.failure_code,
		queuedAt,
		startedAt: optionalInteger(row.started_at, 'started_at'),
		completedAt,
		durationMs: completedAt === null ? null : completedAt - queuedAt,
		cancellationRequestedAt: optionalInteger(
			row.cancellation_requested_at,
			'cancellation_requested_at',
		),
	};
}

function attemptFromRow(row: AttemptRow): WorkflowNodeAttempt {
	return {
		nodeId: row.node_id,
		attempt: integer(row.attempt, 'attempt'),
		nodeType: row.node_type,
		status: row.status,
		outcomePort: row.outcome_port,
		semanticGroup: row.semantic_group,
		sideEffectIdempotencyKey: row.side_effect_idempotency_key,
		input: parse<WorkflowPayloadEvidenceV1>(row.input_evidence_json),
		output: parse<WorkflowPayloadEvidenceV1>(row.output_evidence_json),
		childKind: row.child_kind,
		childId: row.child_id,
		childObservationDeadlineAt: optionalInteger(
			row.child_observation_deadline_at,
			'child_observation_deadline_at',
		),
		failureCode: row.failure_code,
		retryClassification: row.retry_classification,
		selectedBackoffMs: optionalInteger(
			row.selected_backoff_ms,
			'selected_backoff_ms',
		),
		nextAttemptAt: optionalInteger(row.next_attempt_at, 'next_attempt_at'),
		startedAt: integer(row.started_at, 'started_at'),
		completedAt: optionalInteger(row.completed_at, 'completed_at'),
		durationMs: optionalInteger(row.duration_ms, 'duration_ms'),
	};
}

function eventFromRow(row: EventRow): WorkflowRunEventV1 {
	const virtualOffsetMs = optionalInteger(
		row.virtual_offset_ms,
		'virtual_offset_ms',
	);
	return {
		eventId: row.event_id,
		schemaVersion: 1,
		tenantId: row.tenant_id,
		runId: row.run_id,
		sequence: integer(row.sequence, 'sequence'),
		type: row.event_type,
		recordedAt: integer(row.recorded_at, 'recorded_at'),
		...(virtualOffsetMs === null ? {} : { virtualOffsetMs }),
		payload: parse<Readonly<Record<string, JsonValue>>>(row.payload_json),
	};
}

function auditFromRow(row: AuditRow): WorkflowAuditEvent {
	return {
		sequence: integer(row.sequence, 'sequence'),
		actor: parse<Actor>(row.actor_json),
		origin: parse<WorkflowExecutionOrigin>(row.origin_json),
		action: row.action,
		subjectType: row.subject_type,
		subjectId: row.subject_id,
		metadata: parse<Readonly<Record<string, JsonValue>>>(row.metadata_json),
		occurredAt: integer(row.occurred_at, 'occurred_at'),
		previousHash: row.previous_hash,
		eventHash: row.event_hash,
	};
}

function auditHash(event: Omit<WorkflowAuditEvent, 'eventHash'>): string {
	return `sha256:${createHash('sha256')
		.update(
			JSON.stringify({
				sequence: event.sequence,
				actor: event.actor,
				origin: event.origin,
				action: event.action,
				subjectType: event.subjectType,
				subjectId: event.subjectId,
				metadata: event.metadata,
				occurredAt: event.occurredAt,
				previousHash: event.previousHash,
			}),
		)
		.digest('hex')}`;
}

/** Column expression selecting `$.kind` out of a stored JSON document. */
function jsonKind(column: string): string {
	return `${column}::jsonb ->> 'kind'`;
}

/**
 * The person behind a run, in the order migration 0008 backfilled the column:
 * the account a service actor was configured by, then the delegated
 * authorization subject, then the actor itself. It must stay that order, or a
 * run written now would answer an erasure differently from one backfilled.
 */
function subjectAccountId(
	actor: Actor,
	authorizationSubject: UserActor | null,
): string {
	if (actor.kind === 'service') return actor.configuredBy.id;
	return authorizationSubject?.id ?? actor.id;
}

/** Appends into the bucket `key` names, creating it on first use. */
function bucketed<T>(map: Map<string, T[]>, key: string, value: T): void {
	const bucket = map.get(key);
	if (bucket) bucket.push(value);
	else map.set(key, [value]);
}

/* One node of one run. A run id is a UUID and a node id is a dotted
   identifier, so neither can hold the separator and two pairs never collide. */
function nodeKey(runId: string, nodeId: string): string {
	return `${runId} ${nodeId}`;
}

/* Marks a stored evidence document expired without touching its hash or
   byte size, so the audit of what was there survives the redaction. */
function expire(column: string): string {
	return `((${column}::jsonb - 'preview') || '{"state":"expired","reason":"retention"}'::jsonb)::text`;
}

/** Every statement the repository runs, in PostgreSQL's numbered parameters. */
const SQL = Object.freeze({
	latestAudit: `SELECT sequence, event_hash FROM workflow_audit_events
		 WHERE tenant_id = $1 ORDER BY sequence DESC LIMIT 1`,
	insertAudit: `INSERT INTO workflow_audit_events
		 (tenant_id, sequence, actor_json, origin_json, action, subject_type,
		  subject_id, metadata_json, occurred_at, previous_hash, event_hash)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
	maxEventSequence: `SELECT max(sequence) AS sequence FROM workflow_run_events
		 WHERE tenant_id = $1 AND run_id = $2`,
	insertEvent: `INSERT INTO workflow_run_events
		 (event_id, schema_version, tenant_id, run_id, sequence, event_type,
		  payload_json, recorded_at, virtual_offset_ms)
		 VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8)`,
	insertPayload: `INSERT INTO workflow_payloads
		 (id, tenant_id, run_id, kind, schema_id, payload_hash,
		  original_byte_size, ciphertext, encryption_key_id, created_at)
		 VALUES ($1, $2, $3, 'execution', $4, $5, $6, $7, $8, $9)`,
	listDefinitions: `SELECT * FROM workflow_definitions WHERE tenant_id = $1
		 ORDER BY lower(name), id`,
	findDefinition: `SELECT * FROM workflow_definitions
		 WHERE tenant_id = $1 AND id = $2`,
	findDefinitionByKey: `SELECT * FROM workflow_definitions
		 WHERE tenant_id = $1 AND workflow_key = $2`,
	findRevision: `SELECT id, workflow_id, revision, graph_json, graph_checksum,
		 compiler_version, compiled_order_json, published_at,
		 published_actor_json FROM workflow_revisions
		 WHERE tenant_id = $1 AND workflow_id = $2 AND revision = $3`,
	listRevisions: `SELECT id, workflow_id, revision, graph_json, graph_checksum,
		 compiler_version, compiled_order_json, published_at,
		 published_actor_json FROM workflow_revisions
		 WHERE tenant_id = $1 AND workflow_id = $2 ORDER BY revision DESC`,
	insertDefinition: `INSERT INTO workflow_definitions
		 (id, tenant_id, workflow_key, name, description, status,
		  current_draft_revision, published_revision, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
	insertRevision: `INSERT INTO workflow_revisions
		 (id, tenant_id, workflow_id, revision, graph_schema_version,
		  graph_json, graph_checksum, compiler_version, compiled_order_json,
		  published_at, published_actor_json, created_at)
		 VALUES ($1, $2, $3, $4, 1, $5, $6, 1, $7, $8, $9, $10)`,
	updateDraft: `UPDATE workflow_definitions
		 SET name = $1, description = $2, current_draft_revision = $3, updated_at = $4
		 WHERE tenant_id = $5 AND id = $6 AND current_draft_revision = $7`,
	markRevisionPublished: `UPDATE workflow_revisions
		 SET published_at = $1, published_actor_json = $2
		 WHERE tenant_id = $3 AND workflow_id = $4 AND revision = $5
		 AND published_at IS NULL`,
	setPublishedRevision: `UPDATE workflow_definitions SET published_revision = $1, updated_at = $2
		 WHERE tenant_id = $3 AND id = $4`,
	archiveDefinition: `UPDATE workflow_definitions SET status = 'archived', updated_at = $1
		 WHERE tenant_id = $2 AND id = $3`,
	countRunsOfWorkflow: `SELECT count(*) AS count FROM workflow_runs
		 WHERE tenant_id = $1 AND workflow_id = $2`,
	deleteRevisions: `DELETE FROM workflow_revisions WHERE tenant_id = $1 AND workflow_id = $2`,
	deleteDefinition: `DELETE FROM workflow_definitions WHERE tenant_id = $1 AND id = $2`,
	listPublished: `SELECT d.id, d.workflow_key, d.name, d.published_revision,
		 r.graph_checksum FROM workflow_definitions d
		 JOIN workflow_revisions r ON r.tenant_id = d.tenant_id
		  AND r.workflow_id = d.id AND r.revision = d.published_revision
		 WHERE d.tenant_id = $1 AND d.status = 'active'
		 ORDER BY lower(d.name), d.id`,
	insertRun: `INSERT INTO workflow_runs
		 (id, tenant_id, workflow_id, workflow_key, workflow_name,
		  workflow_revision, graph_checksum, compiler_version, graph_json,
		  compiled_order_json, mode, status, actor_json, authorization_subject_json, origin_json,
		  subject_account_id, permission_snapshot_json, permission_digest, input_hash,
		  input_payload_id, input_evidence_json, output_evidence_json,
		  idempotency_key, limits_json, lease_owner, lease_expires_at,
		  completed_nodes, total_nodes, usage_json, cost_json, failure_code,
		  queued_at, started_at, completed_at, cancellation_requested_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
		  $20, NULL, $21, $22, NULL, NULL, 0, $23, $24, $25, NULL, $26, NULL, NULL, NULL)`,
	insertNodeState: `INSERT INTO workflow_node_states
		 (tenant_id, run_id, node_id, status, latest_attempt)
		 VALUES ($1, $2, $3, 'pending', 0)`,
	findRunByIdempotency: `SELECT * FROM workflow_runs
		 WHERE tenant_id = $1 AND idempotency_key = $2`,
	getRun: `SELECT * FROM workflow_runs WHERE tenant_id = $1 AND id = $2`,
	/* The one cross-tenant read. It returns routing columns only; the claim
		   itself re-reads and re-checks the run under the tenant it named. */
	claimCandidates: `SELECT tenant_id, id FROM workflow_runs
		 WHERE mode = 'live'
		 AND (
		  status = 'queued'
		 OR (status IN ('running', 'waiting-agent') AND (lease_expires_at IS NULL OR lease_expires_at <= $1))
		 OR (status = 'waiting-retry' AND (lease_expires_at IS NULL OR lease_expires_at <= $2) AND EXISTS (
		  SELECT 1 FROM workflow_node_states n
		  WHERE n.tenant_id = workflow_runs.tenant_id AND n.run_id = workflow_runs.id
		  AND n.status = 'waiting-retry' AND n.next_attempt_at <= $3
		 ))
		 OR (status = 'waiting-approval' AND (lease_expires_at IS NULL OR lease_expires_at <= $6) AND EXISTS (
		  SELECT 1 FROM workflow_node_states n
		  WHERE n.tenant_id = workflow_runs.tenant_id AND n.run_id = workflow_runs.id
		  AND n.status = 'waiting-child' AND n.next_attempt_at <= $7
		 ))
		  OR (status = 'cancel-requested' AND (lease_expires_at IS NULL OR lease_expires_at <= $4))
		 )
		 ORDER BY queued_at, id LIMIT $5`,
	claimRun: `UPDATE workflow_runs SET status = $1, lease_owner = $2, lease_expires_at = $3,
		 started_at = coalesce(started_at, $4)
		 WHERE tenant_id = $5 AND id = $6
		 AND (lease_owner IS NULL OR lease_expires_at <= $7 OR lease_owner = $8)`,
	renewLease: `UPDATE workflow_runs SET lease_expires_at = $1
		 WHERE tenant_id = $2 AND id = $3 AND lease_owner = $4
		 AND status NOT IN ('succeeded', 'failed', 'refused', 'cancelled')`,
	releaseLease: `UPDATE workflow_runs SET lease_owner = NULL, lease_expires_at = NULL
		 WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3`,
	readEvents: `SELECT event_id, tenant_id, run_id, sequence, event_type,
		 payload_json, recorded_at, virtual_offset_ms
		 FROM workflow_run_events
		 WHERE tenant_id = $1 AND run_id = $2 AND sequence > $3
		 ORDER BY sequence LIMIT $4`,
	insertAttempt: `INSERT INTO workflow_node_attempts
		 (tenant_id, run_id, node_id, attempt, node_type, status,
		  semantic_group, side_effect_idempotency_key, input_payload_id,
		  input_evidence_json, output_evidence_json, started_at)
		 VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, $8, $9, $10, $11)`,
	/* The recheck a retry armed has fired by the time the attempt starts.
		   Leaving it set would keep the node matching the claim poll's due-work
		   predicate, which reads this column for every waiting state. */
	startNodeState: `UPDATE workflow_node_states
		 SET status = 'running', latest_attempt = $1, next_attempt_at = NULL,
		  ready_at = coalesce(ready_at, $2), started_at = coalesce(started_at, $3)
		 WHERE tenant_id = $4 AND run_id = $5 AND node_id = $6`,
	markAttemptWaitingChild: `UPDATE workflow_node_attempts
		 SET status = 'waiting-child', child_kind = $1, child_id = $2,
		 child_observation_deadline_at = $3
		 WHERE tenant_id = $4 AND run_id = $5 AND node_id = $6 AND attempt = $7
		 AND status = 'running'`,
	/* An agent or an action child is polled while the run stays claimable on its
		   own status, so such a node arms no recheck: only an approval does, and it
		   arms it right after this. */
	markNodeWaitingChild: `UPDATE workflow_node_states
		 SET status = 'waiting-child', next_attempt_at = NULL
		 WHERE tenant_id = $1 AND run_id = $2 AND node_id = $3`,
	markRunWaitingAgent: `UPDATE workflow_runs SET status = 'waiting-agent'
		 WHERE tenant_id = $1 AND id = $2 AND status = 'running'`,
	markRunWaitingApproval: `UPDATE workflow_runs SET status = 'waiting-approval'
		 WHERE tenant_id = $1 AND id = $2 AND status IN ('running', 'waiting-approval')`,
	armNodeRecheck: `UPDATE workflow_node_states SET next_attempt_at = $1
		 WHERE tenant_id = $2 AND run_id = $3 AND node_id = $4
		 AND status = 'waiting-child'`,
	wakeApprovalRun: `UPDATE workflow_node_states SET next_attempt_at = $1
		 FROM workflow_node_attempts a
		 WHERE workflow_node_states.tenant_id = $2
		 AND workflow_node_states.run_id = $3
		 AND workflow_node_states.status = 'waiting-child'
		 AND a.tenant_id = workflow_node_states.tenant_id
		 AND a.run_id = workflow_node_states.run_id
		 AND a.node_id = workflow_node_states.node_id
		 AND a.attempt = workflow_node_states.latest_attempt
		 AND a.child_kind = 'approval' AND a.child_id = $4`,
	getAttempt: `SELECT * FROM workflow_node_attempts
		 WHERE tenant_id = $1 AND run_id = $2 AND node_id = $3 AND attempt = $4`,
	settleAttempt: `UPDATE workflow_node_attempts
		 SET status = $1, outcome_port = $2, output_payload_id = $3,
		  output_evidence_json = $4, failure_code = $5, retry_classification = $6,
		  selected_backoff_ms = $7, next_attempt_at = $8, completed_at = $9, duration_ms = $10
		 WHERE tenant_id = $11 AND run_id = $12 AND node_id = $13 AND attempt = $14`,
	setRunRollups: `UPDATE workflow_runs SET usage_json = $1, cost_json = $2
		 WHERE tenant_id = $3 AND id = $4`,
	settleNodeState: `UPDATE workflow_node_states
		 SET status = $1, selected_outcome_port = $2, next_attempt_at = $3,
		  settled_at = $4
		 WHERE tenant_id = $5 AND run_id = $6 AND node_id = $7`,
	advanceRunProgress: `UPDATE workflow_runs SET status = $1,
		 completed_nodes = completed_nodes + $2
		 WHERE tenant_id = $3 AND id = $4 AND status NOT IN
		 ('cancel-requested', 'succeeded', 'failed', 'refused', 'cancelled')`,
	insertEdgeTransfer: `INSERT INTO workflow_edge_transfers
		 (tenant_id, run_id, edge_id, source_node_id, source_port,
		  source_attempt, target_node_id, target_port, state, reason,
		  schema_id, payload_id, evidence_json, settled_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
	skipNodeState: `UPDATE workflow_node_states
		 SET status = 'skipped', settled_at = $1
		 WHERE tenant_id = $2 AND run_id = $3 AND node_id = $4
		 AND status IN ('pending', 'ready')`,
	countNodeSkipped: `UPDATE workflow_runs SET completed_nodes = completed_nodes + 1
		 WHERE tenant_id = $1 AND id = $2`,
	settleRun: `UPDATE workflow_runs SET status = $1, failure_code = $2,
		 output_evidence_json = $3, usage_json = $4, cost_json = $5,
		 completed_at = $6, lease_owner = NULL, lease_expires_at = NULL
		 WHERE tenant_id = $7 AND id = $8`,
	expireRunPayloads: `UPDATE workflow_payloads SET expires_at = $1
		 WHERE tenant_id = $2 AND run_id = $3 AND kind = 'execution'`,
	requestCancellation: `UPDATE workflow_runs SET status = 'cancel-requested',
		 cancellation_requested_at = $1, lease_owner = NULL, lease_expires_at = NULL
		 WHERE tenant_id = $2 AND id = $3`,
	readExecutionPayload: `SELECT ciphertext FROM workflow_payloads
		 WHERE tenant_id = $1 AND run_id = $2 AND id = $3 AND kind = 'execution'`,
	readEdgePayloadId: `SELECT payload_id FROM workflow_edge_transfers
		 WHERE tenant_id = $1 AND run_id = $2 AND edge_id = $3 AND state = 'emitted'`,
	readNodeStates: `SELECT node_id, status, latest_attempt, selected_outcome_port,
		 next_attempt_at, ready_at, started_at, settled_at
		 FROM workflow_node_states WHERE tenant_id = $1 AND run_id = $2
		 ORDER BY node_id`,
	readAttempts: `SELECT node_id, attempt, node_type, status, outcome_port,
		 semantic_group, side_effect_idempotency_key, input_evidence_json,
		 output_evidence_json, child_kind, child_id,
		 child_observation_deadline_at, failure_code,
		 retry_classification, selected_backoff_ms, next_attempt_at,
		 started_at, completed_at, duration_ms
		 FROM workflow_node_attempts WHERE tenant_id = $1 AND run_id = $2
		 ORDER BY node_id, attempt`,
	readEdgeTransfers: `SELECT edge_id, source_node_id, source_port, source_attempt,
		 target_node_id, target_port, state, reason, evidence_json, settled_at
		 FROM workflow_edge_transfers WHERE tenant_id = $1 AND run_id = $2
		 ORDER BY edge_id`,
	listAudit: `SELECT sequence, actor_json, origin_json, action, subject_type,
		 subject_id, metadata_json, occurred_at, previous_hash, event_hash
		 FROM workflow_audit_events WHERE tenant_id = $1
		 ORDER BY sequence DESC LIMIT $2`,
	listAuditBefore: `SELECT sequence, actor_json, origin_json, action, subject_type,
		 subject_id, metadata_json, occurred_at, previous_hash, event_hash
		 FROM workflow_audit_events WHERE tenant_id = $1 AND sequence < $2
		 ORDER BY sequence DESC LIMIT $3`,
	auditChain: `SELECT sequence, actor_json, origin_json, action, subject_type,
		 subject_id, metadata_json, occurred_at, previous_hash, event_hash
		 FROM workflow_audit_events WHERE tenant_id = $1 ORDER BY sequence`,
	/* Chain order, which is the primary key's own order, so the export walk is
	   an index range scan and an event appended during it lands ahead of the
	   cursor rather than being visited twice. */
	exportAuditEventsPage: `SELECT sequence, actor_json, origin_json, action,
		 subject_type, subject_id, metadata_json, occurred_at, previous_hash,
		 event_hash FROM workflow_audit_events
		 WHERE tenant_id = $1 AND sequence > $2
		 ORDER BY sequence LIMIT $3`,
	/* Cross-tenant, routing columns only: the retention writes that follow
		   run under the tenant each row named. */
	retentionCandidates: `SELECT p.id, p.tenant_id, p.run_id, p.payload_hash
		 FROM workflow_payloads p
		 JOIN workflow_runs r ON r.tenant_id = p.tenant_id AND r.id = p.run_id
		 WHERE p.kind = 'execution' AND p.expires_at IS NOT NULL
		 AND p.expires_at <= $1
		 AND r.status IN ('succeeded', 'failed', 'refused', 'cancelled')
		 ORDER BY p.expires_at, p.id LIMIT $2`,
	expireRunInputEvidence: `UPDATE workflow_runs SET input_evidence_json = ${expire('input_evidence_json')}
		 WHERE tenant_id = $1 AND id = $2 AND input_payload_id = $3`,
	expireAttemptEvidence: `UPDATE workflow_node_attempts
		 SET input_evidence_json = CASE WHEN input_payload_id = $1 THEN ${expire('input_evidence_json')} ELSE input_evidence_json END,
		 output_evidence_json = CASE WHEN output_payload_id = $2 THEN ${expire('output_evidence_json')} ELSE output_evidence_json END
		 WHERE tenant_id = $3 AND run_id = $4 AND (input_payload_id = $5 OR output_payload_id = $6)`,
	expireEdgeEvidence: `UPDATE workflow_edge_transfers SET evidence_json = ${expire('evidence_json')}
		 WHERE tenant_id = $1 AND run_id = $2 AND payload_id = $3`,
	deletePayload: `DELETE FROM workflow_payloads WHERE tenant_id = $1 AND run_id = $2 AND id = $3`,
	countExecutionPayloads: `SELECT count(*) AS count FROM workflow_payloads
		 WHERE tenant_id = $1 AND run_id = $2 AND kind = 'execution'`,
	expireRunOutputEvidence: `UPDATE workflow_runs SET output_evidence_json =
		 CASE WHEN output_evidence_json IS NULL THEN NULL ELSE ${expire('output_evidence_json')} END
		 WHERE tenant_id = $1 AND id = $2`,
	countRuns: `SELECT count(*) AS count FROM workflow_runs WHERE tenant_id = $1`,
	/* The order workflow_runs_tenant_queue_idx already carries, so the export
	   walk is an index range scan and a run queued during it lands ahead of the
	   cursor rather than being visited twice. */
	exportRunsPage: `SELECT * FROM workflow_runs WHERE tenant_id = $1
		 ORDER BY queued_at DESC, id DESC LIMIT $2`,
	exportRunsPageAfter: `SELECT * FROM workflow_runs WHERE tenant_id = $1
		 AND (queued_at < $2 OR (queued_at = $3 AND id < $4))
		 ORDER BY queued_at DESC, id DESC LIMIT $5`,
	exportNodeStates: `SELECT run_id, node_id, status, latest_attempt,
		 selected_outcome_port, next_attempt_at, ready_at, started_at, settled_at
		 FROM workflow_node_states
		 WHERE tenant_id = $1 AND run_id = ANY($2::text[])
		 ORDER BY run_id, node_id`,
	exportAttempts: `SELECT run_id, node_id, attempt, node_type, status,
		 outcome_port, semantic_group, side_effect_idempotency_key,
		 input_evidence_json, output_evidence_json, child_kind, child_id,
		 child_observation_deadline_at, failure_code, retry_classification,
		 selected_backoff_ms, next_attempt_at, started_at, completed_at,
		 duration_ms FROM workflow_node_attempts
		 WHERE tenant_id = $1 AND run_id = ANY($2::text[])
		 ORDER BY run_id, node_id, attempt`,
	exportEdges: `SELECT run_id, edge_id, source_node_id, source_port,
		 source_attempt, target_node_id, target_port, state, reason,
		 evidence_json, settled_at FROM workflow_edge_transfers
		 WHERE tenant_id = $1 AND run_id = ANY($2::text[])
		 ORDER BY run_id, edge_id`,
	/* The inner select applies the batch limit; the child rows of the runs it
	   names are removed with them in the same transaction. */
	settledRunsBefore: `SELECT id FROM workflow_runs
		 WHERE tenant_id = $1 AND completed_at < $2
		  AND status IN ('succeeded', 'failed', 'refused', 'cancelled')
		 ORDER BY completed_at LIMIT $3`,
	/* One plain equality on the column 0008 resolves at write time, which is
	   what makes an erasure an index range scan on the connection it runs on.
	   Reading the person out of the actor document instead cannot use an index
	   there: the jsonb extraction is not leakproof, so the forced row level
	   security policy is applied first and the comparison stays a filter. */
	runsOfSubject: `SELECT id FROM workflow_runs
		 WHERE tenant_id = $1 AND subject_account_id = $2
		 ORDER BY id LIMIT $3`,
	deleteRunNodeStates: `DELETE FROM workflow_node_states
		 WHERE tenant_id = $1 AND run_id = ANY($2::text[])`,
	deleteRunAttempts: `DELETE FROM workflow_node_attempts
		 WHERE tenant_id = $1 AND run_id = ANY($2::text[])`,
	deleteRunEdges: `DELETE FROM workflow_edge_transfers
		 WHERE tenant_id = $1 AND run_id = ANY($2::text[])`,
	deleteRunEvents: `DELETE FROM workflow_run_events
		 WHERE tenant_id = $1 AND run_id = ANY($2::text[])`,
	deleteRunPayloads: `DELETE FROM workflow_payloads
		 WHERE tenant_id = $1 AND run_id = ANY($2::text[])`,
	deleteRunRows: `DELETE FROM workflow_runs
		 WHERE tenant_id = $1 AND id = ANY($2::text[])`,
	exportPublishedDefinitions: `SELECT d.*, r.id AS revision_id,
		 r.workflow_id AS revision_workflow_id, r.revision AS revision_number,
		 r.graph_json, r.graph_checksum, r.compiler_version,
		 r.compiled_order_json, r.published_at, r.published_actor_json
		 FROM workflow_definitions d
		 JOIN workflow_revisions r ON r.tenant_id = d.tenant_id
		  AND r.workflow_id = d.id AND r.revision = d.published_revision
		 WHERE d.tenant_id = $1 AND d.published_revision IS NOT NULL
		 ORDER BY d.name, d.id LIMIT $2`,
	exportPublishedDefinitionsAfter: `SELECT d.*, r.id AS revision_id,
		 r.workflow_id AS revision_workflow_id, r.revision AS revision_number,
		 r.graph_json, r.graph_checksum, r.compiler_version,
		 r.compiled_order_json, r.published_at, r.published_actor_json
		 FROM workflow_definitions d
		 JOIN workflow_revisions r ON r.tenant_id = d.tenant_id
		  AND r.workflow_id = d.id AND r.revision = d.published_revision
		 WHERE d.tenant_id = $1 AND d.published_revision IS NOT NULL
		 AND (d.name > $2 OR (d.name = $3 AND d.id > $4))
		 ORDER BY d.name, d.id LIMIT $5`,
});

export async function migrateWorkflowsDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'workflows.core', databaseMigrations);
}

export interface WorkflowsDatabaseHandles {
	/** Tenant-scoped handle used by every request-time read and write. */
	readonly runtime: DatabaseHandle;
	/**
	 * Cross-tenant read handle for the worker claim poll and payload retention.
	 * It reads only what those tables' own FOR SELECT policy grants and writes
	 * nothing; the work that follows runs under the tenant of the row it named.
	 */
	readonly background: DatabaseHandle;
}

/** A repository over platform-owned PostgreSQL handles. */
export class DatabaseWorkflowsRepository implements WorkflowsRepository {
	readonly #payloadCodec: WorkflowPayloadCodec;
	readonly #payloadRetentionMs: number;

	constructor(
		private readonly handles: WorkflowsDatabaseHandles,
		payloadCodec: WorkflowPayloadCodec,
		payloadRetentionMs = 24 * 60 * 60 * 1_000,
		private readonly readyPromise: Promise<void> = Promise.resolve(),
	) {
		this.#payloadCodec = payloadCodec;
		this.#payloadRetentionMs = Math.max(0, Math.trunc(payloadRetentionMs));
	}

	/* One unit of work under one tenant. Every multi-statement operation runs
	   inside a single transaction, so a partially written run is impossible. */
	async #tx<T>(
		tenantId: string,
		access: 'read' | 'write',
		body: (transaction: DatabaseTransaction) => Promise<T>,
	): Promise<T> {
		await this.readyPromise;
		return this.handles.runtime.transaction(body, { access, tenantId });
	}

	async #query<Row extends object>(
		transaction: DatabaseTransaction,
		text: string,
		parameters: readonly unknown[],
	): Promise<readonly Row[]> {
		const result = await transaction.query<Row>({
			text,
			parameters: parameters as never,
		});
		return result.rows;
	}

	async #exec(
		transaction: DatabaseTransaction,
		text: string,
		parameters: readonly unknown[],
	): Promise<number> {
		const result = await transaction.execute({
			text,
			parameters: parameters as never,
		});
		return result.affectedRows;
	}

	async #appendAudit(
		transaction: DatabaseTransaction,
		tenantId: string,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
		action: string,
		subjectType: WorkflowAuditEvent['subjectType'],
		subjectId: string,
		metadata: Readonly<Record<string, JsonValue>>,
		occurredAt: number,
	): Promise<WorkflowAuditEvent> {
		const previous = (
			await this.#query<{ sequence: Int; event_hash: string }>(
				transaction,
				SQL.latestAudit,
				[tenantId],
			)
		)[0];
		const base = {
			sequence: (previous ? integer(previous.sequence, 'sequence') : 0) + 1,
			actor,
			origin,
			action,
			subjectType,
			subjectId,
			metadata,
			occurredAt,
			previousHash: previous?.event_hash ?? null,
		};
		const event: WorkflowAuditEvent = { ...base, eventHash: auditHash(base) };
		await this.#exec(transaction, SQL.insertAudit, [
			tenantId,
			event.sequence,
			JSON.stringify(actor),
			JSON.stringify(origin),
			action,
			subjectType,
			subjectId,
			JSON.stringify(metadata),
			occurredAt,
			event.previousHash,
			event.eventHash,
		]);
		return event;
	}

	async #appendEvent(
		transaction: DatabaseTransaction,
		tenantId: string,
		runId: string,
		type: WorkflowRunEventTypeV1,
		payload: Readonly<Record<string, JsonValue>>,
		recordedAt: number,
		virtualOffsetMs?: number,
	): Promise<WorkflowRunEventV1> {
		const previous = (
			await this.#query<{ sequence: Int | null }>(
				transaction,
				SQL.maxEventSequence,
				[tenantId, runId],
			)
		)[0];
		const sequence =
			(optionalInteger(previous?.sequence ?? null, 'sequence') ?? 0) + 1;
		if (sequence > WORKFLOW_LIMITS.maxRunEvents) {
			throw new Error('WORKFLOW_LIMIT_EXCEEDED');
		}
		const event: WorkflowRunEventV1 = {
			eventId: randomUUID(),
			schemaVersion: 1,
			tenantId,
			runId,
			sequence,
			type,
			recordedAt,
			...(virtualOffsetMs === undefined ? {} : { virtualOffsetMs }),
			payload,
		};
		await this.#exec(transaction, SQL.insertEvent, [
			event.eventId,
			tenantId,
			runId,
			sequence,
			type,
			JSON.stringify(payload),
			recordedAt,
			virtualOffsetMs ?? null,
		]);
		return event;
	}

	async #storePayload(
		transaction: DatabaseTransaction,
		tenantId: string,
		runId: string,
		schemaId: string,
		value: JsonValue,
		createdAt: number,
	): Promise<string> {
		const id = randomUUID();
		const ciphertext = this.#payloadCodec.encrypt(value, {
			tenantId,
			runId,
			payloadId: id,
		});
		await this.#exec(transaction, SQL.insertPayload, [
			id,
			tenantId,
			runId,
			schemaId,
			jsonHash(value),
			jsonByteSize(value),
			ciphertext,
			this.#payloadCodec.keyId,
			createdAt,
		]);
		return id;
	}

	async #definitionIn(
		transaction: DatabaseTransaction,
		tenantId: string,
		workflowId: string,
	): Promise<WorkflowDefinition | null> {
		const row = (
			await this.#query<DefinitionRow>(transaction, SQL.findDefinition, [
				tenantId,
				workflowId,
			])
		)[0];
		return row ? definitionFromRow(row) : null;
	}

	async #runIn(
		transaction: DatabaseTransaction,
		tenantId: string,
		runId: string,
	): Promise<WorkflowRunRecord | null> {
		const row = (
			await this.#query<RunRow>(transaction, SQL.getRun, [tenantId, runId])
		)[0];
		return row ? runFromRow(row) : null;
	}

	async #detailIn(
		transaction: DatabaseTransaction,
		tenantId: string,
		workflowId: string,
	): Promise<WorkflowDefinitionDetail | null> {
		const definition = await this.#definitionIn(
			transaction,
			tenantId,
			workflowId,
		);
		if (!definition) return null;
		const revisions = (
			await this.#query<RevisionRow>(transaction, SQL.listRevisions, [
				tenantId,
				workflowId,
			])
		).map(revisionFromRow);
		const draft = revisions.find(
			(entry) => entry.revision === definition.currentDraftRevision,
		);
		if (!draft) throw new Error('WORKFLOW_REVISION_MISSING');
		return { definition, draft, revisions };
	}

	async #insertRevision(
		transaction: DatabaseTransaction,
		tenantId: string,
		revision: WorkflowRevision,
		createdAt: number,
	): Promise<void> {
		await this.#exec(transaction, SQL.insertRevision, [
			revision.id,
			tenantId,
			revision.workflowId,
			revision.revision,
			JSON.stringify(revision.graph),
			revision.graphChecksum,
			JSON.stringify(revision.compiledOrder),
			revision.publishedAt,
			revision.publishedBy ? JSON.stringify(revision.publishedBy) : null,
			createdAt,
		]);
	}

	async listDefinitions(
		tenantId: string,
	): Promise<readonly WorkflowDefinition[]> {
		return this.#tx(tenantId, 'read', async (transaction) =>
			(
				await this.#query<DefinitionRow>(transaction, SQL.listDefinitions, [
					tenantId,
				])
			).map(definitionFromRow),
		);
	}

	async findDefinition(
		tenantId: string,
		workflowId: string,
	): Promise<WorkflowDefinition | null> {
		return this.#tx(tenantId, 'read', (transaction) =>
			this.#definitionIn(transaction, tenantId, workflowId),
		);
	}

	async findDefinitionByKey(
		tenantId: string,
		workflowKey: string,
	): Promise<WorkflowDefinition | null> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const row = (
				await this.#query<DefinitionRow>(transaction, SQL.findDefinitionByKey, [
					tenantId,
					workflowKey,
				])
			)[0];
			return row ? definitionFromRow(row) : null;
		});
	}

	async findRevision(
		tenantId: string,
		workflowId: string,
		revision: number,
	): Promise<WorkflowRevision | null> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const row = (
				await this.#query<RevisionRow>(transaction, SQL.findRevision, [
					tenantId,
					workflowId,
					revision,
				])
			)[0];
			return row ? revisionFromRow(row) : null;
		});
	}

	async definitionDetail(
		tenantId: string,
		workflowId: string,
	): Promise<WorkflowDefinitionDetail | null> {
		return this.#tx(tenantId, 'read', (transaction) =>
			this.#detailIn(transaction, tenantId, workflowId),
		);
	}

	async createDefinition(
		write: WorkflowDefinitionWrite,
	): Promise<WorkflowDefinitionDetail> {
		const { definition, revision } = write;
		return this.#tx(definition.tenantId, 'write', async (transaction) => {
			await this.#exec(transaction, SQL.insertDefinition, [
				definition.id,
				definition.tenantId,
				definition.key,
				definition.name,
				definition.description,
				definition.status,
				definition.currentDraftRevision,
				definition.publishedRevision,
				definition.createdAt,
				definition.updatedAt,
			]);
			await this.#insertRevision(
				transaction,
				definition.tenantId,
				revision,
				definition.createdAt,
			);
			await this.#appendAudit(
				transaction,
				definition.tenantId,
				write.actor,
				write.origin,
				'workflow.created',
				'workflow',
				definition.id,
				{ key: definition.key, revision: revision.revision },
				definition.createdAt,
			);
			return { definition, draft: revision, revisions: [revision] };
		});
	}

	async saveDraft(
		write: WorkflowDefinitionWrite & { readonly expectedRevision: number },
	): Promise<WorkflowDefinitionDetail | 'conflict'> {
		return this.#tx(write.definition.tenantId, 'write', async (transaction) => {
			const updated = await this.#exec(transaction, SQL.updateDraft, [
				write.definition.name,
				write.definition.description,
				write.revision.revision,
				write.definition.updatedAt,
				write.definition.tenantId,
				write.definition.id,
				write.expectedRevision,
			]);
			if (updated !== 1) return 'conflict';
			await this.#insertRevision(
				transaction,
				write.definition.tenantId,
				write.revision,
				write.definition.updatedAt,
			);
			await this.#appendAudit(
				transaction,
				write.definition.tenantId,
				write.actor,
				write.origin,
				'workflow.draft.saved',
				'workflow',
				write.definition.id,
				{ revision: write.revision.revision },
				write.definition.updatedAt,
			);
			return (await this.#detailIn(
				transaction,
				write.definition.tenantId,
				write.definition.id,
			))!;
		});
	}

	async publish(
		tenantId: string,
		workflowId: string,
		expectedRevision: number,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
		recordedAt: number,
	): Promise<WorkflowDefinitionDetail | 'conflict' | null> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			const definition = await this.#definitionIn(
				transaction,
				tenantId,
				workflowId,
			);
			if (!definition) return null;
			if (definition.currentDraftRevision !== expectedRevision) {
				return 'conflict';
			}
			const marked = await this.#exec(transaction, SQL.markRevisionPublished, [
				recordedAt,
				JSON.stringify(actor),
				tenantId,
				workflowId,
				expectedRevision,
			]);
			if (marked !== 1 && definition.publishedRevision !== expectedRevision) {
				return 'conflict';
			}
			await this.#exec(transaction, SQL.setPublishedRevision, [
				expectedRevision,
				recordedAt,
				tenantId,
				workflowId,
			]);
			await this.#appendAudit(
				transaction,
				tenantId,
				actor,
				origin,
				'workflow.published',
				'workflow',
				workflowId,
				{ revision: expectedRevision },
				recordedAt,
			);
			return (await this.#detailIn(transaction, tenantId, workflowId))!;
		});
	}

	async archive(
		tenantId: string,
		workflowId: string,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
		recordedAt: number,
	): Promise<WorkflowDefinition | null> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			const changed = await this.#exec(transaction, SQL.archiveDefinition, [
				recordedAt,
				tenantId,
				workflowId,
			]);
			if (changed !== 1) return null;
			await this.#appendAudit(
				transaction,
				tenantId,
				actor,
				origin,
				'workflow.archived',
				'workflow',
				workflowId,
				{},
				recordedAt,
			);
			return this.#definitionIn(transaction, tenantId, workflowId);
		});
	}

	async deleteDraft(
		tenantId: string,
		workflowId: string,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
		recordedAt: number,
	): Promise<'deleted' | 'not-found' | 'in-use'> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			const definition = await this.#definitionIn(
				transaction,
				tenantId,
				workflowId,
			);
			if (!definition) return 'not-found';
			const runs = (
				await this.#query<{ count: Int }>(
					transaction,
					SQL.countRunsOfWorkflow,
					[tenantId, workflowId],
				)
			)[0];
			if (
				definition.publishedRevision !== null ||
				integer(runs?.count ?? 0, 'count') > 0
			) {
				return 'in-use';
			}
			await this.#appendAudit(
				transaction,
				tenantId,
				actor,
				origin,
				'workflow.deleted',
				'workflow',
				workflowId,
				{ key: definition.key },
				recordedAt,
			);
			await this.#exec(transaction, SQL.deleteRevisions, [
				tenantId,
				workflowId,
			]);
			await this.#exec(transaction, SQL.deleteDefinition, [
				tenantId,
				workflowId,
			]);
			return 'deleted';
		});
	}

	async listPublished(
		tenantId: string,
	): Promise<readonly WorkflowPublishedReference[]> {
		return this.#tx(tenantId, 'read', async (transaction) =>
			(
				await this.#query<{
					id: string;
					workflow_key: string;
					name: string;
					published_revision: Int;
					graph_checksum: string;
				}>(transaction, SQL.listPublished, [tenantId])
			).map((row) => ({
				id: row.id,
				key: row.workflow_key,
				name: row.name,
				revision: integer(row.published_revision, 'published_revision'),
				graphChecksum: row.graph_checksum,
			})),
		);
	}

	async createRun(write: CreateWorkflowRunWrite): Promise<WorkflowRunRecord> {
		const run = write.run;
		return this.#tx(run.tenantId, 'write', async (transaction) => {
			const inputPayloadId = await this.#storePayload(
				transaction,
				run.tenantId,
				run.id,
				'workflow.input',
				write.input,
				run.queuedAt,
			);
			await this.#exec(transaction, SQL.insertRun, [
				run.id,
				run.tenantId,
				run.workflowId,
				run.workflowKey,
				run.workflowName,
				run.workflowRevision,
				run.graphChecksum,
				JSON.stringify(run.graph),
				JSON.stringify(run.compiledOrder),
				run.mode,
				run.status,
				JSON.stringify(run.actor),
				JSON.stringify(run.authorizationSubject),
				JSON.stringify(run.origin),
				subjectAccountId(run.actor, run.authorizationSubject),
				JSON.stringify(run.permissionSnapshot),
				run.permissionDigest,
				run.inputHash,
				inputPayloadId,
				JSON.stringify(write.inputEvidence),
				run.idempotencyKey,
				JSON.stringify(WORKFLOW_LIMITS),
				run.totalNodes,
				JSON.stringify(run.usage),
				JSON.stringify(run.cost),
				run.queuedAt,
			]);
			for (const node of run.graph.nodes) {
				await this.#exec(transaction, SQL.insertNodeState, [
					run.tenantId,
					run.id,
					node.id,
				]);
			}
			await this.#appendEvent(
				transaction,
				run.tenantId,
				run.id,
				'run.queued',
				{
					workflowRevision: run.workflowRevision,
					graphChecksum: run.graphChecksum,
					actor: run.actor as unknown as JsonValue,
					origin: run.origin as unknown as JsonValue,
					mode: run.mode,
				},
				run.queuedAt,
				run.mode === 'simulate' ? 0 : undefined,
			);
			await this.#appendAudit(
				transaction,
				run.tenantId,
				run.actor,
				run.origin,
				'workflow-run.enqueued',
				'workflow-run',
				run.id,
				{
					workflowId: run.workflowId,
					mode: run.mode,
					inputHash: run.inputHash,
				},
				run.queuedAt,
			);
			return { ...run, inputPayloadId };
		});
	}

	async findRunByIdempotency(
		tenantId: string,
		key: string,
	): Promise<WorkflowRunRecord | null> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const row = (
				await this.#query<RunRow>(transaction, SQL.findRunByIdempotency, [
					tenantId,
					key,
				])
			)[0];
			return row ? runFromRow(row) : null;
		});
	}

	async getRun(
		tenantId: string,
		runId: string,
	): Promise<WorkflowRunRecord | null> {
		return this.#tx(tenantId, 'read', (transaction) =>
			this.#runIn(transaction, tenantId, runId),
		);
	}

	async listRuns(
		tenantId: string,
		filters: WorkflowRunFilters,
	): Promise<WorkflowRunPage> {
		const limit = Math.min(
			Math.max(1, Math.trunc(filters.limit ?? 50)),
			WORKFLOW_LIMITS.maxInteractivePage,
		);
		const parameters: Array<string | number> = [];
		const bind = (value: string | number) => {
			parameters.push(value);
			return `$${parameters.length}`;
		};
		const clauses = [`tenant_id = ${bind(tenantId)}`];
		if (filters.workflowId) {
			clauses.push(`workflow_id = ${bind(filters.workflowId)}`);
		}
		if (filters.mode) clauses.push(`mode = ${bind(filters.mode)}`);
		if (filters.status) clauses.push(`status = ${bind(filters.status)}`);
		if (filters.actorKind) {
			clauses.push(`${jsonKind('actor_json')} = ${bind(filters.actorKind)}`);
		}
		if (filters.originKind) {
			clauses.push(`${jsonKind('origin_json')} = ${bind(filters.originKind)}`);
		}
		let snapshot: { readonly queuedAt: number; readonly id: string } | null =
			null;
		if (filters.cursor) {
			const [snapshotRaw, positionRaw, extra] = filters.cursor.split('|');
			const parseBoundary = (raw: string | undefined) => {
				const separator = raw?.indexOf(':') ?? -1;
				const queuedAt = Number(raw?.slice(0, separator));
				const id = raw?.slice(separator + 1) ?? '';
				if (separator < 1 || !Number.isSafeInteger(queuedAt) || !id) {
					throw new Error('WORKFLOW_CURSOR_INVALID');
				}
				return { queuedAt, id };
			};
			if (extra !== undefined) throw new Error('WORKFLOW_CURSOR_INVALID');
			snapshot = parseBoundary(snapshotRaw);
			const position = parseBoundary(positionRaw);
			clauses.push(
				`(queued_at < ${bind(snapshot.queuedAt)} OR (queued_at = ${bind(
					snapshot.queuedAt,
				)} AND id <= ${bind(snapshot.id)}))`,
			);
			clauses.push(
				`(queued_at < ${bind(position.queuedAt)} OR (queued_at = ${bind(
					position.queuedAt,
				)} AND id < ${bind(position.id)}))`,
			);
		}
		const text = `SELECT * FROM workflow_runs WHERE ${clauses.join(' AND ')}
		 ORDER BY queued_at DESC, id DESC LIMIT ${bind(limit + 1)}`;
		const rows = await this.#tx(tenantId, 'read', (transaction) =>
			this.#query<RunRow>(transaction, text, parameters),
		);
		const page = rows.slice(0, limit).map(runFromRow);
		const first = page[0];
		const last = page.at(-1);
		const highWaterMark =
			snapshot ?? (first ? { queuedAt: first.queuedAt, id: first.id } : null);
		return {
			runs: page,
			nextCursor:
				rows.length > limit && last && highWaterMark
					? `${highWaterMark.queuedAt}:${highWaterMark.id}|${last.queuedAt}:${last.id}`
					: null,
		};
	}

	async runDetail(
		tenantId: string,
		runId: string,
	): Promise<WorkflowRunDetail | null> {
		const row = await this.#tx(
			tenantId,
			'read',
			async (transaction) =>
				(
					await this.#query<RunRow>(transaction, SQL.getRun, [tenantId, runId])
				)[0],
		);
		if (!row) return null;
		const events = await this.readEvents(
			tenantId,
			runId,
			0,
			WORKFLOW_LIMITS.maxRunEvents,
		);
		const projection = projectWorkflowRunEvents(events);
		if (projection.status !== row.status) {
			throw new WorkflowEventProjectionError(
				'WORKFLOW_EVENT_TRANSITION_INVALID',
				`Workflow run projection is ${row.status} but its event stream rebuilds as ${projection.status}.`,
			);
		}
		const nodes = await this.readNodeStates(tenantId, runId);
		for (const [nodeId, status] of Object.entries(projection.nodeStatuses)) {
			if (nodes.find((node) => node.nodeId === nodeId)?.status !== status) {
				throw new WorkflowEventProjectionError(
					'WORKFLOW_EVENT_TRANSITION_INVALID',
					`Workflow node ${nodeId} does not match its event projection.`,
				);
			}
		}
		for (const projected of Object.values(projection.attempts)) {
			const actual = nodes
				.find((node) => node.nodeId === projected.nodeId)
				?.attempts.find((attempt) => attempt.attempt === projected.attempt);
			if (
				actual?.status !== projected.status ||
				actual.outcomePort !== projected.outcomePort
			) {
				throw new WorkflowEventProjectionError(
					'WORKFLOW_EVENT_TRANSITION_INVALID',
					`Workflow attempt ${projected.nodeId}:${projected.attempt} does not match its event projection.`,
				);
			}
		}
		const edges = await this.readEdgeTransfers(tenantId, runId);
		for (const [edgeId, state] of Object.entries(projection.edgeStates)) {
			if (edges.find((edge) => edge.edgeId === edgeId)?.state !== state) {
				throw new WorkflowEventProjectionError(
					'WORKFLOW_EVENT_TRANSITION_INVALID',
					`Workflow edge ${edgeId} does not match its event projection.`,
				);
			}
		}
		return {
			run: runFromRow(row),
			graph: parse<WorkflowGraphV1>(row.graph_json),
			compiledOrder: parse<readonly string[]>(row.compiled_order_json),
			nodes,
			edges,
			events,
			input: parse<WorkflowPayloadEvidenceV1>(row.input_evidence_json),
			output:
				row.output_evidence_json === null
					? {
							version: 1,
							state: 'absent',
							schemaId: 'workflow.output',
							hash: row.input_hash,
							originalByteSize: 0,
							reason: 'not-emitted',
						}
					: parse<WorkflowPayloadEvidenceV1>(row.output_evidence_json),
		};
	}

	/* The claim crosses tenants to find due work, which is the only way a
	   worker can learn whose run is next. The poll returns routing columns on
	   the read-only background handle; the claim itself re-reads the run under
	   the tenant that row named and re-checks the predicate there, so a run
	   that moved in between is passed over instead of claimed twice. */
	async claimNext(
		workerId: string,
		now: number,
		leaseExpiresAt: number,
	): Promise<WorkflowRunRecord | null> {
		await this.readyPromise;
		const candidates = (
			await this.handles.background.transaction(
				(transaction) =>
					transaction.query<RunRoutingRow>({
						text: SQL.claimCandidates,
						parameters: [now, now, now, now, 20, now, now] as never,
					}),
				{ access: 'read' },
			)
		).rows;
		for (const candidate of candidates) {
			const claimed = await this.#claim(
				candidate.tenant_id,
				candidate.id,
				workerId,
				now,
				leaseExpiresAt,
			);
			if (claimed) return claimed;
		}
		return null;
	}

	async #claim(
		tenantId: string,
		runId: string,
		workerId: string,
		now: number,
		leaseExpiresAt: number,
	): Promise<WorkflowRunRecord | null> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			const row = (
				await this.#query<RunRow>(transaction, SQL.getRun, [tenantId, runId])
			)[0];
			if (!row) return null;
			const leaseExpired =
				row.lease_expires_at === null ||
				integer(row.lease_expires_at, 'lease_expires_at') <= now;
			const claimable =
				row.mode === 'live' &&
				(row.status === 'queued' ||
					(['running', 'waiting-agent', 'cancel-requested'].includes(
						row.status,
					) &&
						leaseExpired) ||
					(['waiting-retry', 'waiting-approval'].includes(row.status) &&
						leaseExpired));
			if (!claimable) return null;
			const priorLease = row.lease_owner;
			const recovering = priorLease !== null && row.status !== 'queued';
			/* A due retry becomes runnable again. Keeping the run in waiting-retry
			   after its node starts would make the new waiting-child projection
			   unreachable by the next claim. */
			const status =
				row.status === 'queued' ||
				row.status === 'waiting-retry' ||
				row.status === 'waiting-approval'
					? 'running'
					: row.status;
			const changed = await this.#exec(transaction, SQL.claimRun, [
				status,
				workerId,
				leaseExpiresAt,
				now,
				tenantId,
				runId,
				now,
				workerId,
			]);
			if (changed !== 1) return null;
			const actor = parse<Actor>(row.actor_json);
			const origin = parse<WorkflowExecutionOrigin>(row.origin_json);
			if (recovering) {
				await this.#appendEvent(
					transaction,
					tenantId,
					runId,
					'run.recovered',
					{ priorLease: priorLease ?? '', workerId, reason: 'lease-expired' },
					now,
				);
				await this.#appendAudit(
					transaction,
					tenantId,
					actor,
					origin,
					'workflow-run.recovered',
					'workflow-run',
					runId,
					{ workerId },
					now,
				);
			} else if (row.status === 'queued') {
				await this.#appendEvent(
					transaction,
					tenantId,
					runId,
					'run.claimed',
					{ workerId, leaseExpiresAt },
					now,
				);
				await this.#appendAudit(
					transaction,
					tenantId,
					actor,
					origin,
					'workflow-run.claimed',
					'workflow-run',
					runId,
					{ workerId },
					now,
				);
			}
			return this.#runIn(transaction, tenantId, runId);
		});
	}

	async renewLease(
		tenantId: string,
		runId: string,
		workerId: string,
		leaseExpiresAt: number,
	): Promise<boolean> {
		return (
			(await this.#tx(tenantId, 'write', (transaction) =>
				this.#exec(transaction, SQL.renewLease, [
					leaseExpiresAt,
					tenantId,
					runId,
					workerId,
				]),
			)) === 1
		);
	}

	async releaseLease(
		tenantId: string,
		runId: string,
		workerId: string,
	): Promise<void> {
		await this.#tx(tenantId, 'write', (transaction) =>
			this.#exec(transaction, SQL.releaseLease, [tenantId, runId, workerId]),
		);
	}

	async appendRunEvent(
		tenantId: string,
		runId: string,
		type: WorkflowRunEventTypeV1,
		payload: Readonly<Record<string, JsonValue>>,
		recordedAt: number,
		virtualOffsetMs?: number,
	): Promise<WorkflowRunEventV1> {
		return this.#tx(tenantId, 'write', (transaction) =>
			this.#appendEvent(
				transaction,
				tenantId,
				runId,
				type,
				payload,
				recordedAt,
				virtualOffsetMs,
			),
		);
	}

	async readEvents(
		tenantId: string,
		runId: string,
		afterSequence: number,
		limit: number,
	): Promise<readonly WorkflowRunEventV1[]> {
		return this.#tx(tenantId, 'read', async (transaction) =>
			(
				await this.#query<EventRow>(transaction, SQL.readEvents, [
					tenantId,
					runId,
					Math.max(0, Math.trunc(afterSequence)),
					Math.min(
						Math.max(1, Math.trunc(limit)),
						WORKFLOW_LIMITS.maxRunEvents,
					),
				])
			).map(eventFromRow),
		);
	}

	async startAttempt(
		write: StartAttemptWrite,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
	): Promise<WorkflowNodeAttempt> {
		return this.#tx(write.tenantId, 'write', async (transaction) => {
			const payloadId = await this.#storePayload(
				transaction,
				write.tenantId,
				write.runId,
				write.schemaId,
				write.input,
				write.recordedAt,
			);
			const absent: WorkflowPayloadEvidenceV1 = {
				version: 1,
				state: 'absent',
				schemaId: write.schemaId,
				hash: write.inputEvidence.hash,
				originalByteSize: 0,
				reason: 'not-emitted',
			};
			await this.#exec(transaction, SQL.insertAttempt, [
				write.tenantId,
				write.runId,
				write.nodeId,
				write.attempt,
				write.nodeType,
				write.semanticGroup,
				write.sideEffectIdempotencyKey,
				payloadId,
				JSON.stringify(write.inputEvidence),
				JSON.stringify(absent),
				write.recordedAt,
			]);
			await this.#exec(transaction, SQL.startNodeState, [
				write.attempt,
				write.recordedAt,
				write.recordedAt,
				write.tenantId,
				write.runId,
				write.nodeId,
			]);
			await this.#appendEvent(
				transaction,
				write.tenantId,
				write.runId,
				'node.ready',
				{ nodeId: write.nodeId },
				write.recordedAt,
				write.virtualOffsetMs,
			);
			if (write.attempt > 1) {
				await this.#appendEvent(
					transaction,
					write.tenantId,
					write.runId,
					'node.retry.started',
					{
						nodeId: write.nodeId,
						attempt: write.attempt,
						semanticGroup: write.semanticGroup,
					},
					write.recordedAt,
					write.virtualOffsetMs,
				);
			}
			await this.#appendEvent(
				transaction,
				write.tenantId,
				write.runId,
				'node.attempt.started',
				{
					nodeId: write.nodeId,
					attempt: write.attempt,
					semanticGroup: write.semanticGroup,
					input: write.inputEvidence as unknown as JsonValue,
				},
				write.recordedAt,
				write.virtualOffsetMs,
			);
			await this.#appendAudit(
				transaction,
				write.tenantId,
				actor,
				origin,
				'workflow-node.attempt.started',
				'workflow-node',
				`${write.runId}:${write.nodeId}`,
				{ attempt: write.attempt },
				write.recordedAt,
			);
			return {
				nodeId: write.nodeId,
				attempt: write.attempt,
				nodeType: write.nodeType,
				status: 'running',
				outcomePort: null,
				semanticGroup: write.semanticGroup,
				sideEffectIdempotencyKey: write.sideEffectIdempotencyKey,
				input: write.inputEvidence,
				output: absent,
				childKind: null,
				childId: null,
				childObservationDeadlineAt: null,
				failureCode: null,
				retryClassification: null,
				selectedBackoffMs: null,
				nextAttemptAt: null,
				startedAt: write.recordedAt,
				completedAt: null,
				durationMs: null,
			};
		});
	}

	async markChildWaiting(
		tenantId: string,
		runId: string,
		nodeId: string,
		attempt: number,
		childKind: 'agent' | 'action' | 'approval',
		childId: string,
		observationDeadlineAt: number,
		recordedAt: number,
		recheckAt?: number,
	): Promise<void> {
		await this.#tx(tenantId, 'write', async (transaction) => {
			const changed = await this.#exec(
				transaction,
				SQL.markAttemptWaitingChild,
				[
					childKind,
					childId,
					observationDeadlineAt,
					tenantId,
					runId,
					nodeId,
					attempt,
				],
			);
			if (changed !== 1) throw new Error('WORKFLOW_ATTEMPT_TERMINAL');
			await this.#exec(transaction, SQL.markNodeWaitingChild, [
				tenantId,
				runId,
				nodeId,
			]);
			if (childKind === 'agent') {
				await this.#exec(transaction, SQL.markRunWaitingAgent, [
					tenantId,
					runId,
				]);
			}
			/* An approval takes the run out of the claim queue entirely, so the
			   recheck it arms is the only thing that brings it back on its own. */
			if (childKind === 'approval') {
				await this.#exec(transaction, SQL.armNodeRecheck, [
					recheckAt ?? recordedAt,
					tenantId,
					runId,
					nodeId,
				]);
				await this.#exec(transaction, SQL.markRunWaitingApproval, [
					tenantId,
					runId,
				]);
			}
			await this.#appendEvent(
				transaction,
				tenantId,
				runId,
				'node.child.waiting',
				{ nodeId, attempt, childKind, childId, observationDeadlineAt },
				recordedAt,
			);
		});
	}

	/**
	 * Re-arms the wait on an approval the worker found still pending. It records
	 * no event and touches no attempt: the run simply goes back to sleep with a
	 * later recheck than the one that woke it.
	 */
	async suspendApproval(
		tenantId: string,
		runId: string,
		nodeId: string,
		recheckAt: number,
	): Promise<void> {
		await this.#tx(tenantId, 'write', async (transaction) => {
			await this.#exec(transaction, SQL.armNodeRecheck, [
				recheckAt,
				tenantId,
				runId,
				nodeId,
			]);
			await this.#exec(transaction, SQL.markRunWaitingApproval, [
				tenantId,
				runId,
			]);
		});
	}

	/**
	 * Brings a sleeping run back into the claim queue the moment approvals.core
	 * reports a decision, by making the node's recheck due now. It matches on the
	 * request id, so a callback for a request the run has moved past changes
	 * nothing.
	 */
	async wakeApproval(
		tenantId: string,
		runId: string,
		requestId: string,
		now: number,
	): Promise<void> {
		await this.#tx(tenantId, 'write', async (transaction) => {
			await this.#exec(transaction, SQL.wakeApprovalRun, [
				now,
				tenantId,
				runId,
				requestId,
			]);
		});
	}

	async settleAttempt(
		write: SettleAttemptWrite,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
	): Promise<WorkflowNodeAttempt> {
		return this.#tx(write.tenantId, 'write', async (transaction) => {
			const prior = (
				await this.#query<AttemptRow>(transaction, SQL.getAttempt, [
					write.tenantId,
					write.runId,
					write.nodeId,
					write.attempt,
				])
			)[0];
			if (!prior || !['running', 'waiting-child'].includes(prior.status)) {
				throw new Error('WORKFLOW_ATTEMPT_TERMINAL');
			}
			const payloadId =
				write.output === undefined
					? null
					: await this.#storePayload(
							transaction,
							write.tenantId,
							write.runId,
							write.schemaId,
							write.output,
							write.recordedAt,
						);
			const duration = Math.max(
				0,
				write.recordedAt - integer(prior.started_at, 'started_at'),
			);
			await this.#exec(transaction, SQL.settleAttempt, [
				write.status,
				write.outcomePort,
				payloadId,
				JSON.stringify(write.outputEvidence),
				write.failureCode,
				write.retryClassification,
				write.selectedBackoffMs,
				write.nextAttemptAt,
				write.recordedAt,
				duration,
				write.tenantId,
				write.runId,
				write.nodeId,
				write.attempt,
			]);
			const retrying = write.nextAttemptAt !== null;
			if (!retrying && prior.child_kind === 'action') {
				const run = await this.#runIn(transaction, write.tenantId, write.runId);
				if (run) {
					const usage: WorkflowUsageRollupV1 = {
						...run.usage,
						actionInvocations: run.usage.actionInvocations + 1,
						unpricedActions: run.usage.unpricedActions + 1,
					};
					const cost: WorkflowCostRollupV1 = {
						...run.cost,
						unpricedActions: run.cost.unpricedActions + 1,
					};
					await this.#exec(transaction, SQL.setRunRollups, [
						JSON.stringify(usage),
						JSON.stringify(cost),
						write.tenantId,
						write.runId,
					]);
				}
			}
			await this.#exec(transaction, SQL.settleNodeState, [
				retrying ? 'waiting-retry' : write.status,
				write.outcomePort,
				write.nextAttemptAt,
				retrying ? null : write.recordedAt,
				write.tenantId,
				write.runId,
				write.nodeId,
			]);
			await this.#exec(transaction, SQL.advanceRunProgress, [
				retrying ? 'waiting-retry' : 'running',
				retrying ? 0 : 1,
				write.tenantId,
				write.runId,
			]);
			await this.#appendEvent(
				transaction,
				write.tenantId,
				write.runId,
				'node.attempt.settled',
				{
					nodeId: write.nodeId,
					attempt: write.attempt,
					status: write.status,
					outcomePort: write.outcomePort,
					output: write.outputEvidence as unknown as JsonValue,
					failureCode: write.failureCode,
					retryClassification: write.retryClassification,
				},
				write.recordedAt,
				write.virtualOffsetMs,
			);
			if (retrying) {
				await this.#appendEvent(
					transaction,
					write.tenantId,
					write.runId,
					'node.retry.scheduled',
					{
						nodeId: write.nodeId,
						attempt: write.attempt,
						classification: write.retryClassification,
						backoffMs: write.selectedBackoffMs,
						nextAttemptAt: write.nextAttemptAt,
					},
					write.recordedAt,
					write.virtualOffsetMs,
				);
			}
			await this.#appendAudit(
				transaction,
				write.tenantId,
				actor,
				origin,
				retrying
					? 'workflow-node.retry.scheduled'
					: 'workflow-node.attempt.settled',
				'workflow-node',
				`${write.runId}:${write.nodeId}`,
				{
					attempt: write.attempt,
					status: write.status,
					failureCode: write.failureCode,
				},
				write.recordedAt,
			);
			return attemptFromRow({
				...prior,
				status: write.status,
				outcome_port: write.outcomePort,
				output_evidence_json: JSON.stringify(write.outputEvidence),
				failure_code: write.failureCode,
				retry_classification: write.retryClassification,
				selected_backoff_ms: write.selectedBackoffMs,
				next_attempt_at: write.nextAttemptAt,
				completed_at: write.recordedAt,
				duration_ms: duration,
			});
		});
	}

	async settleEdge(write: SettleEdgeWrite): Promise<WorkflowEdgeTransfer> {
		const transfer = write.transfer;
		return this.#tx(write.tenantId, 'write', async (transaction) => {
			const schemaId = transfer.evidence.schemaId;
			const payloadId =
				write.payload === undefined
					? null
					: await this.#storePayload(
							transaction,
							write.tenantId,
							write.runId,
							schemaId,
							write.payload,
							transfer.settledAt,
						);
			await this.#exec(transaction, SQL.insertEdgeTransfer, [
				write.tenantId,
				write.runId,
				transfer.edgeId,
				transfer.sourceNodeId,
				transfer.sourcePort,
				transfer.sourceAttempt,
				transfer.targetNodeId,
				transfer.targetPort,
				transfer.state,
				transfer.reason,
				schemaId,
				payloadId,
				JSON.stringify(transfer.evidence),
				transfer.settledAt,
			]);
			await this.#appendEvent(
				transaction,
				write.tenantId,
				write.runId,
				'edge.settled',
				{
					edgeId: transfer.edgeId,
					state: transfer.state,
					sourceNodeId: transfer.sourceNodeId,
					sourcePort: transfer.sourcePort,
					sourceAttempt: transfer.sourceAttempt,
					targetNodeId: transfer.targetNodeId,
					targetPort: transfer.targetPort,
					reason: transfer.reason,
					evidence: transfer.evidence as unknown as JsonValue,
				},
				transfer.settledAt,
				write.virtualOffsetMs,
			);
			return transfer;
		});
	}

	async markNodeSkipped(
		tenantId: string,
		runId: string,
		nodeId: string,
		reason: string,
		recordedAt: number,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
		virtualOffsetMs?: number,
	): Promise<void> {
		await this.#tx(tenantId, 'write', async (transaction) => {
			const changed = await this.#exec(transaction, SQL.skipNodeState, [
				recordedAt,
				tenantId,
				runId,
				nodeId,
			]);
			if (changed !== 1) return;
			await this.#exec(transaction, SQL.countNodeSkipped, [tenantId, runId]);
			await this.#appendEvent(
				transaction,
				tenantId,
				runId,
				'node.skipped',
				{ nodeId, reason },
				recordedAt,
				virtualOffsetMs,
			);
			await this.#appendAudit(
				transaction,
				tenantId,
				actor,
				origin,
				'workflow-node.skipped',
				'workflow-node',
				`${runId}:${nodeId}`,
				{ reason },
				recordedAt,
			);
		});
	}

	async settleRun(
		tenantId: string,
		runId: string,
		status: Extract<
			WorkflowRunStatus,
			'succeeded' | 'failed' | 'refused' | 'cancelled'
		>,
		failureCode: string | null,
		_output: JsonValue | undefined,
		outputEvidence: WorkflowPayloadEvidenceV1,
		usage: WorkflowUsageRollupV1,
		cost: WorkflowCostRollupV1,
		recordedAt: number,
		virtualOffsetMs?: number,
	): Promise<WorkflowRunRecord | null> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			const before = await this.#runIn(transaction, tenantId, runId);
			if (!before) return null;
			if (TERMINAL_RUNS.has(before.status)) return before;
			await this.#exec(transaction, SQL.settleRun, [
				status,
				failureCode,
				JSON.stringify(outputEvidence),
				JSON.stringify(usage),
				JSON.stringify(cost),
				recordedAt,
				tenantId,
				runId,
			]);
			await this.#exec(transaction, SQL.expireRunPayloads, [
				recordedAt + this.#payloadRetentionMs,
				tenantId,
				runId,
			]);
			await this.#appendEvent(
				transaction,
				tenantId,
				runId,
				`run.${status}` as WorkflowRunEventTypeV1,
				{
					failureCode,
					output: outputEvidence as unknown as JsonValue,
					usage: usage as unknown as JsonValue,
					cost: cost as unknown as JsonValue,
				},
				recordedAt,
				before.mode === 'simulate'
					? (virtualOffsetMs ?? recordedAt - before.queuedAt)
					: undefined,
			);
			await this.#appendAudit(
				transaction,
				tenantId,
				before.actor,
				before.origin,
				`workflow-run.${status}`,
				'workflow-run',
				runId,
				{ failureCode },
				recordedAt,
			);
			return this.#runIn(transaction, tenantId, runId);
		});
	}

	async requestCancellation(
		tenantId: string,
		runId: string,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
		recordedAt: number,
	): Promise<{
		readonly run: WorkflowRunRecord;
		readonly requested: boolean;
	} | null> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			const run = await this.#runIn(transaction, tenantId, runId);
			if (!run) return null;
			if (TERMINAL_RUNS.has(run.status) || run.status === 'cancel-requested') {
				return { run, requested: false };
			}
			await this.#exec(transaction, SQL.requestCancellation, [
				recordedAt,
				tenantId,
				runId,
			]);
			await this.#appendEvent(
				transaction,
				tenantId,
				runId,
				'run.cancel.requested',
				{
					requester: actor as unknown as JsonValue,
					reason: 'operator-requested',
					requestedAt: recordedAt,
				},
				recordedAt,
			);
			await this.#appendAudit(
				transaction,
				tenantId,
				actor,
				origin,
				'workflow-run.cancel.requested',
				'workflow-run',
				runId,
				{},
				recordedAt,
			);
			return {
				run: (await this.#runIn(transaction, tenantId, runId))!,
				requested: true,
			};
		});
	}

	async readExecutionPayload(
		tenantId: string,
		runId: string,
		payloadId: string,
	): Promise<JsonValue> {
		const row = await this.#tx(
			tenantId,
			'read',
			async (transaction) =>
				(
					await this.#query<{ ciphertext: string }>(
						transaction,
						SQL.readExecutionPayload,
						[tenantId, runId, payloadId],
					)
				)[0],
		);
		if (!row) throw new Error('WORKFLOW_PAYLOAD_UNREADABLE');
		return this.#payloadCodec.decrypt(row.ciphertext, {
			tenantId,
			runId,
			payloadId,
		});
	}

	async readEdgePayload(
		tenantId: string,
		runId: string,
		edgeId: string,
	): Promise<JsonValue | undefined> {
		const row = await this.#tx(
			tenantId,
			'read',
			async (transaction) =>
				(
					await this.#query<{ payload_id: string | null }>(
						transaction,
						SQL.readEdgePayloadId,
						[tenantId, runId, edgeId],
					)
				)[0],
		);
		return row?.payload_id
			? this.readExecutionPayload(tenantId, runId, row.payload_id)
			: undefined;
	}

	async recordAgentUsage(
		tenantId: string,
		runId: string,
		childRunId: string,
		usage: {
			readonly inputTokens: number;
			readonly outputTokens: number;
			readonly totalTokens: number;
		},
	): Promise<void> {
		await this.#tx(tenantId, 'write', async (transaction) => {
			const run = await this.#runIn(transaction, tenantId, runId);
			if (!run || run.usage.includedChildRunIds.includes(childRunId)) return;
			const next: WorkflowUsageRollupV1 = {
				...run.usage,
				inputTokens:
					run.usage.inputTokens + Math.max(0, Math.trunc(usage.inputTokens)),
				outputTokens:
					run.usage.outputTokens + Math.max(0, Math.trunc(usage.outputTokens)),
				totalTokens:
					run.usage.totalTokens + Math.max(0, Math.trunc(usage.totalTokens)),
				includedChildRunIds: [...run.usage.includedChildRunIds, childRunId],
				unpricedChildRuns: run.usage.unpricedChildRuns + 1,
			};
			const cost: WorkflowCostRollupV1 = {
				...run.cost,
				unpricedChildRuns: run.cost.unpricedChildRuns + 1,
			};
			await this.#exec(transaction, SQL.setRunRollups, [
				JSON.stringify(next),
				JSON.stringify(cost),
				tenantId,
				runId,
			]);
		});
	}

	async readNodeStates(
		tenantId: string,
		runId: string,
	): Promise<readonly WorkflowNodeExecution[]> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const states = await this.#query<NodeStateRow>(
				transaction,
				SQL.readNodeStates,
				[tenantId, runId],
			);
			const attempts = await this.#query<AttemptRow>(
				transaction,
				SQL.readAttempts,
				[tenantId, runId],
			);
			return states.map((state) =>
				nodeExecutionFromRow(
					state,
					attempts
						.filter((attempt) => attempt.node_id === state.node_id)
						.map(attemptFromRow),
				),
			);
		});
	}

	async readEdgeTransfers(
		tenantId: string,
		runId: string,
	): Promise<readonly WorkflowEdgeTransfer[]> {
		return this.#tx(tenantId, 'read', async (transaction) =>
			(
				await this.#query<EdgeRow>(transaction, SQL.readEdgeTransfers, [
					tenantId,
					runId,
				])
			).map(edgeFromRow),
		);
	}

	async listAudit(
		tenantId: string,
		limit: number,
		beforeSequence?: number,
	): Promise<WorkflowAuditPage> {
		const bounded = Math.min(Math.max(1, Math.trunc(limit)), 100);
		const rows = await this.#tx(tenantId, 'read', (transaction) =>
			beforeSequence === undefined
				? this.#query<AuditRow>(transaction, SQL.listAudit, [
						tenantId,
						bounded + 1,
					])
				: this.#query<AuditRow>(transaction, SQL.listAuditBefore, [
						tenantId,
						beforeSequence,
						bounded + 1,
					]),
		);
		const events = rows.slice(0, bounded).map(auditFromRow);
		return {
			events,
			nextCursor:
				rows.length > bounded && events.at(-1)
					? String(events.at(-1)!.sequence)
					: null,
		};
	}

	async verifyAudit(tenantId: string): Promise<WorkflowAuditVerification> {
		const rows = await this.#tx(tenantId, 'read', (transaction) =>
			this.#query<AuditRow>(transaction, SQL.auditChain, [tenantId]),
		);
		let previousHash: string | null = null;
		let last = 0;
		for (const row of rows) {
			const event = auditFromRow(row);
			const expected = auditHash({
				sequence: event.sequence,
				actor: event.actor,
				origin: event.origin,
				action: event.action,
				subjectType: event.subjectType,
				subjectId: event.subjectId,
				metadata: event.metadata,
				occurredAt: event.occurredAt,
				previousHash,
			});
			if (event.previousHash !== previousHash || event.eventHash !== expected) {
				return {
					valid: false,
					checkedThroughSequence: Math.max(0, event.sequence - 1),
					firstBrokenSequence: event.sequence,
					expectedPreviousHash: previousHash,
					actualPreviousHash: event.previousHash,
				};
			}
			previousHash = event.eventHash;
			last = event.sequence;
		}
		return { valid: true, checkedThroughSequence: last };
	}

	/* Retention sweeps every tenant, so the candidate scan runs on the
	   read-only background handle and returns routing columns and a hash. Each
	   redaction then runs in its own transaction under the tenant that owns it. */
	async applyPayloadRetention(now: number, limit = 100): Promise<number> {
		await this.readyPromise;
		const boundedLimit = Math.min(Math.max(1, Math.trunc(limit)), 1_000);
		const candidates = (
			await this.handles.background.transaction(
				(transaction) =>
					transaction.query<PayloadRoutingRow>({
						text: SQL.retentionCandidates,
						parameters: [now, boundedLimit] as never,
					}),
				{ access: 'read' },
			)
		).rows;
		for (const row of candidates) {
			await this.#tx(row.tenant_id, 'write', async (transaction) => {
				await this.#appendEvent(
					transaction,
					row.tenant_id,
					row.run_id,
					'payload.retention.applied',
					{
						payloadId: row.id,
						hash: row.payload_hash,
						policy: 'terminal-ttl',
						priorEvidenceState: 'available',
					},
					now,
				);
				await this.#exec(transaction, SQL.expireRunInputEvidence, [
					row.tenant_id,
					row.run_id,
					row.id,
				]);
				await this.#exec(transaction, SQL.expireAttemptEvidence, [
					row.id,
					row.id,
					row.tenant_id,
					row.run_id,
					row.id,
					row.id,
				]);
				await this.#exec(transaction, SQL.expireEdgeEvidence, [
					row.tenant_id,
					row.run_id,
					row.id,
				]);
				await this.#exec(transaction, SQL.deletePayload, [
					row.tenant_id,
					row.run_id,
					row.id,
				]);
				const remaining = (
					await this.#query<{ count: Int }>(
						transaction,
						SQL.countExecutionPayloads,
						[row.tenant_id, row.run_id],
					)
				)[0];
				if (integer(remaining?.count ?? 0, 'count') === 0) {
					await this.#exec(transaction, SQL.expireRunOutputEvidence, [
						row.tenant_id,
						row.run_id,
					]);
				}
			});
		}
		return candidates.length;
	}

	async countRuns(tenantId: string): Promise<number> {
		const row = await this.#tx(
			tenantId,
			'read',
			async (transaction) =>
				(
					await this.#query<{ count: Int }>(transaction, SQL.countRuns, [
						tenantId,
					])
				)[0],
		);
		return integer(row?.count ?? 0, 'count');
	}

	/* The operations behind the declared data classes. Each runs on this
	   module's own lease, inside its own tenant-scoped transaction. */

	async exportRunsPage(
		tenantId: string,
		after: WorkflowRunExportCursor | null,
		limit: number,
	): Promise<readonly ExportedWorkflowRun[]> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const runs =
				after === null
					? await this.#query<RunRow>(transaction, SQL.exportRunsPage, [
							tenantId,
							limit,
						])
					: await this.#query<RunRow>(transaction, SQL.exportRunsPageAfter, [
							tenantId,
							after.queuedAt,
							after.queuedAt,
							after.id,
							limit,
						]);
			if (runs.length === 0) return [];
			/* Three queries for the whole page: a run is a row, not four round
			   trips. */
			const ids = runs.map((run) => run.id);
			const states = await this.#query<ExportNodeStateRow>(
				transaction,
				SQL.exportNodeStates,
				[tenantId, ids],
			);
			const attempts = await this.#query<ExportAttemptRow>(
				transaction,
				SQL.exportAttempts,
				[tenantId, ids],
			);
			const edges = await this.#query<ExportEdgeRow>(
				transaction,
				SQL.exportEdges,
				[tenantId, ids],
			);
			/* One pass per result set into its buckets, so assembling a page costs
			   O(runs + states + attempts + edges). Scanning each child set once per
			   run is what turns a page of long runs quadratic. Each bucket keeps
			   the order its query returned. */
			const statesByRun = new Map<string, ExportNodeStateRow[]>();
			for (const state of states) bucketed(statesByRun, state.run_id, state);
			const attemptsByNode = new Map<string, ExportAttemptRow[]>();
			for (const attempt of attempts) {
				bucketed(
					attemptsByNode,
					nodeKey(attempt.run_id, attempt.node_id),
					attempt,
				);
			}
			const edgesByRun = new Map<string, ExportEdgeRow[]>();
			for (const edge of edges) bucketed(edgesByRun, edge.run_id, edge);
			return runs.map((run) => ({
				run: runFromRow(run),
				nodes: (statesByRun.get(run.id) ?? []).map((state) =>
					nodeExecutionFromRow(
						state,
						(attemptsByNode.get(nodeKey(run.id, state.node_id)) ?? []).map(
							attemptFromRow,
						),
					),
				),
				edges: (edgesByRun.get(run.id) ?? []).map(edgeFromRow),
			}));
		});
	}

	async exportAuditEventsPage(
		tenantId: string,
		afterSequence: number,
		limit: number,
	): Promise<readonly WorkflowAuditEvent[]> {
		return this.#tx(tenantId, 'read', async (transaction) =>
			(
				await this.#query<AuditRow>(transaction, SQL.exportAuditEventsPage, [
					tenantId,
					afterSequence,
					limit,
				])
			).map(auditFromRow),
		);
	}

	async deleteRunsSettledBefore(
		tenantId: string,
		before: number,
		limit: number,
	): Promise<number> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			const rows = await this.#query<{ id: string }>(
				transaction,
				SQL.settledRunsBefore,
				[tenantId, before, limit],
			);
			return this.#deleteRunsIn(transaction, tenantId, rows);
		});
	}

	/* A run this removes while a worker holds it takes its lease with it: the
	   next renewal finds no row and the worker stops as it does for any lease
	   it lost. */
	async deleteRunsOfSubject(
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<number> {
		return this.#tx(tenantId, 'write', async (transaction) => {
			const rows = await this.#query<{ id: string }>(
				transaction,
				SQL.runsOfSubject,
				[tenantId, accountId, limit],
			);
			return this.#deleteRunsIn(transaction, tenantId, rows);
		});
	}

	/* No foreign key hangs off a run, so the child rows are named here. A run
	   and its evidence leave in one transaction or not at all. */
	async #deleteRunsIn(
		transaction: DatabaseTransaction,
		tenantId: string,
		rows: readonly { readonly id: string }[],
	): Promise<number> {
		if (rows.length === 0) return 0;
		const ids = rows.map((row) => row.id);
		for (const statement of [
			SQL.deleteRunNodeStates,
			SQL.deleteRunAttempts,
			SQL.deleteRunEdges,
			SQL.deleteRunEvents,
			SQL.deleteRunPayloads,
		]) {
			await this.#exec(transaction, statement, [tenantId, ids]);
		}
		return this.#exec(transaction, SQL.deleteRunRows, [tenantId, ids]);
	}

	async exportPublishedDefinitionsPage(
		tenantId: string,
		after: WorkflowDefinitionExportCursor | null,
		limit: number,
	): Promise<readonly ExportedWorkflowDefinition[]> {
		return this.#tx(tenantId, 'read', async (transaction) => {
			const rows =
				after === null
					? await this.#query<ExportDefinitionRow>(
							transaction,
							SQL.exportPublishedDefinitions,
							[tenantId, limit],
						)
					: await this.#query<ExportDefinitionRow>(
							transaction,
							SQL.exportPublishedDefinitionsAfter,
							[tenantId, after.name, after.name, after.id, limit],
						);
			return rows.map((row) => ({
				definition: definitionFromRow(row),
				revision: revisionFromRow({
					id: row.revision_id,
					workflow_id: row.revision_workflow_id,
					revision: row.revision_number,
					graph_json: row.graph_json,
					graph_checksum: row.graph_checksum,
					compiler_version: row.compiler_version,
					compiled_order_json: row.compiled_order_json,
					published_at: row.published_at,
					published_actor_json: row.published_actor_json,
				}),
			}));
		});
	}

	async close(): Promise<void> {}
}
