import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
	inTransaction,
	runModuleMigrations,
	type Actor,
	type UserActor,
} from '@coreloom/kernel';
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
import { migrations } from './migration.ts';
import {
	createWorkflowPayloadCodec,
	type WorkflowPayloadCodec,
} from './payload-codec.ts';
import type {
	CreateWorkflowRunWrite,
	SettleAttemptWrite,
	SettleEdgeWrite,
	StartAttemptWrite,
	WorkflowAuditPage,
	WorkflowDefinitionWrite,
	WorkflowRunRecord,
	WorkflowsRepository,
} from './repository.ts';

const TERMINAL_RUNS = new Set<WorkflowRunStatus>([
	'succeeded',
	'failed',
	'refused',
	'cancelled',
]);

interface DefinitionRow {
	id: string;
	tenant_id: string;
	workflow_key: string;
	name: string;
	description: string;
	status: WorkflowDefinition['status'];
	current_draft_revision: number;
	published_revision: number | null;
	created_at: number;
	updated_at: number;
}

interface RevisionRow {
	id: string;
	workflow_id: string;
	revision: number;
	graph_json: string;
	graph_checksum: string;
	compiler_version: 1;
	compiled_order_json: string;
	published_at: number | null;
	published_actor_json: string | null;
}

interface RunRow {
	id: string;
	tenant_id: string;
	workflow_id: string;
	workflow_key: string;
	workflow_name: string;
	workflow_revision: number | null;
	graph_checksum: string;
	compiler_version: 1;
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
	lease_expires_at: number | null;
	completed_nodes: number;
	total_nodes: number;
	usage_json: string;
	cost_json: string;
	failure_code: string | null;
	queued_at: number;
	started_at: number | null;
	completed_at: number | null;
	cancellation_requested_at: number | null;
}

interface NodeStateRow {
	node_id: string;
	status: WorkflowNodeExecution['status'];
	latest_attempt: number;
	selected_outcome_port: string | null;
	next_attempt_at: number | null;
	ready_at: number | null;
	started_at: number | null;
	settled_at: number | null;
}

interface AttemptRow {
	node_id: string;
	attempt: number;
	node_type: WorkflowNodeAttempt['nodeType'];
	status: WorkflowNodeAttempt['status'];
	outcome_port: string | null;
	semantic_group: string;
	side_effect_idempotency_key: string;
	input_evidence_json: string;
	output_evidence_json: string;
	child_kind: WorkflowNodeAttempt['childKind'];
	child_id: string | null;
	child_observation_deadline_at: number | null;
	failure_code: string | null;
	retry_classification: WorkflowNodeAttempt['retryClassification'];
	selected_backoff_ms: number | null;
	next_attempt_at: number | null;
	started_at: number;
	completed_at: number | null;
	duration_ms: number | null;
}

interface EdgeRow {
	edge_id: string;
	source_node_id: string;
	source_port: string;
	source_attempt: number | null;
	target_node_id: string;
	target_port: string;
	state: WorkflowEdgeTransfer['state'];
	reason: string | null;
	evidence_json: string;
	settled_at: number;
}

interface EventRow {
	event_id: string;
	tenant_id: string;
	run_id: string;
	sequence: number;
	event_type: WorkflowRunEventTypeV1;
	payload_json: string;
	recorded_at: number;
	virtual_offset_ms: number | null;
}

interface AuditRow {
	sequence: number;
	actor_json: string;
	origin_json: string;
	action: string;
	subject_type: WorkflowAuditEvent['subjectType'];
	subject_id: string;
	metadata_json: string;
	occurred_at: number;
	previous_hash: string | null;
	event_hash: string;
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
		currentDraftRevision: row.current_draft_revision,
		publishedRevision: row.published_revision,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function revisionFromRow(row: RevisionRow): WorkflowRevision {
	return {
		id: row.id,
		workflowId: row.workflow_id,
		revision: row.revision,
		graph: parse<WorkflowGraphV1>(row.graph_json),
		graphChecksum: row.graph_checksum,
		compilerVersion: row.compiler_version,
		compiledOrder: parse<readonly string[]>(row.compiled_order_json),
		publishedAt: row.published_at,
		publishedBy:
			row.published_actor_json === null
				? null
				: parse<Actor>(row.published_actor_json),
	};
}

function runFromRow(row: RunRow): WorkflowRunRecord {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		workflowId: row.workflow_id,
		workflowKey: row.workflow_key,
		workflowName: row.workflow_name,
		workflowRevision: row.workflow_revision,
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
		leaseExpiresAt: row.lease_expires_at,
		completedNodes: row.completed_nodes,
		totalNodes: row.total_nodes,
		usage: parse<WorkflowUsageRollupV1>(row.usage_json),
		cost: parse<WorkflowCostRollupV1>(row.cost_json),
		failureCode: row.failure_code,
		queuedAt: row.queued_at,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		durationMs:
			row.completed_at === null ? null : row.completed_at - row.queued_at,
		cancellationRequestedAt: row.cancellation_requested_at,
	};
}

function attemptFromRow(row: AttemptRow): WorkflowNodeAttempt {
	return {
		nodeId: row.node_id,
		attempt: row.attempt,
		nodeType: row.node_type,
		status: row.status,
		outcomePort: row.outcome_port,
		semanticGroup: row.semantic_group,
		sideEffectIdempotencyKey: row.side_effect_idempotency_key,
		input: parse<WorkflowPayloadEvidenceV1>(row.input_evidence_json),
		output: parse<WorkflowPayloadEvidenceV1>(row.output_evidence_json),
		childKind: row.child_kind,
		childId: row.child_id,
		childObservationDeadlineAt: row.child_observation_deadline_at,
		failureCode: row.failure_code,
		retryClassification: row.retry_classification,
		selectedBackoffMs: row.selected_backoff_ms,
		nextAttemptAt: row.next_attempt_at,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		durationMs: row.duration_ms,
	};
}

function eventFromRow(row: EventRow): WorkflowRunEventV1 {
	return {
		eventId: row.event_id,
		schemaVersion: 1,
		tenantId: row.tenant_id,
		runId: row.run_id,
		sequence: row.sequence,
		type: row.event_type,
		recordedAt: row.recorded_at,
		...(row.virtual_offset_ms === null
			? {}
			: { virtualOffsetMs: row.virtual_offset_ms }),
		payload: parse<Readonly<Record<string, JsonValue>>>(row.payload_json),
	};
}

function auditFromRow(row: AuditRow): WorkflowAuditEvent {
	return {
		sequence: row.sequence,
		actor: parse<Actor>(row.actor_json),
		origin: parse<WorkflowExecutionOrigin>(row.origin_json),
		action: row.action,
		subjectType: row.subject_type,
		subjectId: row.subject_id,
		metadata: parse<Readonly<Record<string, JsonValue>>>(row.metadata_json),
		occurredAt: row.occurred_at,
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

export class SqliteWorkflowsRepository implements WorkflowsRepository {
	readonly #database: DatabaseSync;
	readonly #payloadCodec: WorkflowPayloadCodec;
	readonly #payloadRetentionMs: number;
	#closed = false;

	constructor(
		path: string,
		payloadCodec?: WorkflowPayloadCodec,
		payloadRetentionMs = 24 * 60 * 60 * 1_000,
	) {
		if (!payloadCodec && path !== ':memory:') {
			throw new Error(
				'CL_WORKFLOWS_PAYLOAD_KEY is required for durable workflow storage.',
			);
		}
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.#database = new DatabaseSync(path, { timeout: 5000 });
		this.#database.exec('PRAGMA journal_mode = WAL;');
		runModuleMigrations(this.#database, migrations);
		this.#payloadCodec =
			payloadCodec ??
			createWorkflowPayloadCodec(Buffer.alloc(32, 'coreloom-workflows-test'));
		this.#payloadRetentionMs = Math.max(0, Math.trunc(payloadRetentionMs));
	}

	#appendAudit(
		tenantId: string,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
		action: string,
		subjectType: WorkflowAuditEvent['subjectType'],
		subjectId: string,
		metadata: Readonly<Record<string, JsonValue>>,
		occurredAt: number,
	): WorkflowAuditEvent {
		const previous = this.#database
			.prepare(
				`SELECT sequence, event_hash FROM workflow_audit_events
				 WHERE tenant_id = ? ORDER BY sequence DESC LIMIT 1`,
			)
			.get(tenantId) as { sequence: number; event_hash: string } | undefined;
		const base = {
			sequence: (previous?.sequence ?? 0) + 1,
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
		this.#database
			.prepare(
				`INSERT INTO workflow_audit_events
				 (tenant_id, sequence, actor_json, origin_json, action, subject_type,
				  subject_id, metadata_json, occurred_at, previous_hash, event_hash)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
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
			);
		return event;
	}

	#appendEvent(
		tenantId: string,
		runId: string,
		type: WorkflowRunEventTypeV1,
		payload: Readonly<Record<string, JsonValue>>,
		recordedAt: number,
		virtualOffsetMs?: number,
	): WorkflowRunEventV1 {
		const previous = this.#database
			.prepare(
				`SELECT max(sequence) AS sequence FROM workflow_run_events
				 WHERE tenant_id = ? AND run_id = ?`,
			)
			.get(tenantId, runId) as { sequence: number | null };
		const sequence = (previous.sequence ?? 0) + 1;
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
		this.#database
			.prepare(
				`INSERT INTO workflow_run_events
				 (event_id, schema_version, tenant_id, run_id, sequence, event_type,
				  payload_json, recorded_at, virtual_offset_ms)
				 VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				event.eventId,
				tenantId,
				runId,
				sequence,
				type,
				JSON.stringify(payload),
				recordedAt,
				virtualOffsetMs ?? null,
			);
		return event;
	}

	#storePayload(
		tenantId: string,
		runId: string,
		schemaId: string,
		value: JsonValue,
		createdAt: number,
	): string {
		const id = randomUUID();
		const ciphertext = this.#payloadCodec.encrypt(value, {
			tenantId,
			runId,
			payloadId: id,
		});
		const bytes = jsonByteSize(value);
		const hash = jsonHash(value);
		this.#database
			.prepare(
				`INSERT INTO workflow_payloads
				 (id, tenant_id, run_id, kind, schema_id, payload_hash,
				  original_byte_size, ciphertext, encryption_key_id, created_at)
				 VALUES (?, ?, ?, 'execution', ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				tenantId,
				runId,
				schemaId,
				hash,
				bytes,
				ciphertext,
				this.#payloadCodec.keyId,
				createdAt,
			);
		return id;
	}

	listDefinitions(tenantId: string): readonly WorkflowDefinition[] {
		return (
			this.#database
				.prepare(
					`SELECT * FROM workflow_definitions WHERE tenant_id = ?
					 ORDER BY lower(name), id`,
				)
				.all(tenantId) as unknown as DefinitionRow[]
		).map(definitionFromRow);
	}

	findDefinition(
		tenantId: string,
		workflowId: string,
	): WorkflowDefinition | null {
		const row = this.#database
			.prepare(
				'SELECT * FROM workflow_definitions WHERE tenant_id = ? AND id = ?',
			)
			.get(tenantId, workflowId) as unknown as DefinitionRow | undefined;
		return row ? definitionFromRow(row) : null;
	}

	findDefinitionByKey(
		tenantId: string,
		workflowKey: string,
	): WorkflowDefinition | null {
		const row = this.#database
			.prepare(
				`SELECT * FROM workflow_definitions
				 WHERE tenant_id = ? AND workflow_key = ?`,
			)
			.get(tenantId, workflowKey) as unknown as DefinitionRow | undefined;
		return row ? definitionFromRow(row) : null;
	}

	findRevision(
		tenantId: string,
		workflowId: string,
		revision: number,
	): WorkflowRevision | null {
		const row = this.#database
			.prepare(
				`SELECT id, workflow_id, revision, graph_json, graph_checksum,
				 compiler_version, compiled_order_json, published_at,
				 published_actor_json FROM workflow_revisions
				 WHERE tenant_id = ? AND workflow_id = ? AND revision = ?`,
			)
			.get(tenantId, workflowId, revision) as unknown as
			| RevisionRow
			| undefined;
		return row ? revisionFromRow(row) : null;
	}

	definitionDetail(
		tenantId: string,
		workflowId: string,
	): WorkflowDefinitionDetail | null {
		const definition = this.findDefinition(tenantId, workflowId);
		if (!definition) return null;
		const revisions = (
			this.#database
				.prepare(
					`SELECT id, workflow_id, revision, graph_json, graph_checksum,
					 compiler_version, compiled_order_json, published_at,
					 published_actor_json FROM workflow_revisions
					 WHERE tenant_id = ? AND workflow_id = ? ORDER BY revision DESC`,
				)
				.all(tenantId, workflowId) as unknown as RevisionRow[]
		).map(revisionFromRow);
		const draft = revisions.find(
			(entry) => entry.revision === definition.currentDraftRevision,
		);
		if (!draft) throw new Error('WORKFLOW_REVISION_MISSING');
		return { definition, draft, revisions };
	}

	createDefinition(write: WorkflowDefinitionWrite): WorkflowDefinitionDetail {
		return inTransaction(this.#database, () => {
			const { definition, revision } = write;
			this.#database
				.prepare(
					`INSERT INTO workflow_definitions
					 (id, tenant_id, workflow_key, name, description, status,
					  current_draft_revision, published_revision, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
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
				);
			this.#insertRevision(definition.tenantId, revision, definition.createdAt);
			this.#appendAudit(
				definition.tenantId,
				write.actor,
				write.origin,
				'workflow.created',
				'workflow',
				definition.id,
				{ key: definition.key, revision: revision.revision },
				definition.createdAt,
			);
			return {
				definition,
				draft: revision,
				revisions: [revision],
			};
		});
	}

	#insertRevision(
		tenantId: string,
		revision: WorkflowRevision,
		createdAt: number,
	): void {
		this.#database
			.prepare(
				`INSERT INTO workflow_revisions
				 (id, tenant_id, workflow_id, revision, graph_schema_version,
				  graph_json, graph_checksum, compiler_version, compiled_order_json,
				  published_at, published_actor_json, created_at)
				 VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?, ?, ?, ?)`,
			)
			.run(
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
			);
	}

	saveDraft(
		write: WorkflowDefinitionWrite & { readonly expectedRevision: number },
	): WorkflowDefinitionDetail | 'conflict' {
		return inTransaction(this.#database, () => {
			const updated = this.#database
				.prepare(
					`UPDATE workflow_definitions
					 SET name = ?, description = ?, current_draft_revision = ?, updated_at = ?
					 WHERE tenant_id = ? AND id = ? AND current_draft_revision = ?`,
				)
				.run(
					write.definition.name,
					write.definition.description,
					write.revision.revision,
					write.definition.updatedAt,
					write.definition.tenantId,
					write.definition.id,
					write.expectedRevision,
				);
			if (updated.changes !== 1) return 'conflict';
			this.#insertRevision(
				write.definition.tenantId,
				write.revision,
				write.definition.updatedAt,
			);
			this.#appendAudit(
				write.definition.tenantId,
				write.actor,
				write.origin,
				'workflow.draft.saved',
				'workflow',
				write.definition.id,
				{ revision: write.revision.revision },
				write.definition.updatedAt,
			);
			return this.definitionDetail(
				write.definition.tenantId,
				write.definition.id,
			)!;
		});
	}

	publish(
		tenantId: string,
		workflowId: string,
		expectedRevision: number,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
		recordedAt: number,
	): WorkflowDefinitionDetail | 'conflict' | null {
		return inTransaction(this.#database, () => {
			const definition = this.findDefinition(tenantId, workflowId);
			if (!definition) return null;
			if (definition.currentDraftRevision !== expectedRevision)
				return 'conflict';
			const marked = this.#database
				.prepare(
					`UPDATE workflow_revisions
					 SET published_at = ?, published_actor_json = ?
					 WHERE tenant_id = ? AND workflow_id = ? AND revision = ?
					 AND published_at IS NULL`,
				)
				.run(
					recordedAt,
					JSON.stringify(actor),
					tenantId,
					workflowId,
					expectedRevision,
				);
			if (
				marked.changes !== 1 &&
				definition.publishedRevision !== expectedRevision
			) {
				return 'conflict';
			}
			this.#database
				.prepare(
					`UPDATE workflow_definitions SET published_revision = ?, updated_at = ?
					 WHERE tenant_id = ? AND id = ?`,
				)
				.run(expectedRevision, recordedAt, tenantId, workflowId);
			this.#appendAudit(
				tenantId,
				actor,
				origin,
				'workflow.published',
				'workflow',
				workflowId,
				{ revision: expectedRevision },
				recordedAt,
			);
			return this.definitionDetail(tenantId, workflowId)!;
		});
	}

	archive(
		tenantId: string,
		workflowId: string,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
		recordedAt: number,
	): WorkflowDefinition | null {
		return inTransaction(this.#database, () => {
			const changed = this.#database
				.prepare(
					`UPDATE workflow_definitions SET status = 'archived', updated_at = ?
					 WHERE tenant_id = ? AND id = ?`,
				)
				.run(recordedAt, tenantId, workflowId);
			if (changed.changes !== 1) return null;
			this.#appendAudit(
				tenantId,
				actor,
				origin,
				'workflow.archived',
				'workflow',
				workflowId,
				{},
				recordedAt,
			);
			return this.findDefinition(tenantId, workflowId);
		});
	}

	deleteDraft(
		tenantId: string,
		workflowId: string,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
		recordedAt: number,
	): 'deleted' | 'not-found' | 'in-use' {
		return inTransaction(this.#database, () => {
			const definition = this.findDefinition(tenantId, workflowId);
			if (!definition) return 'not-found';
			const runs = this.#database
				.prepare(
					`SELECT count(*) AS count FROM workflow_runs
					 WHERE tenant_id = ? AND workflow_id = ?`,
				)
				.get(tenantId, workflowId) as { count: number };
			if (definition.publishedRevision !== null || runs.count > 0)
				return 'in-use';
			this.#appendAudit(
				tenantId,
				actor,
				origin,
				'workflow.deleted',
				'workflow',
				workflowId,
				{ key: definition.key },
				recordedAt,
			);
			this.#database
				.prepare(
					`DELETE FROM workflow_revisions WHERE tenant_id = ? AND workflow_id = ?`,
				)
				.run(tenantId, workflowId);
			this.#database
				.prepare(
					'DELETE FROM workflow_definitions WHERE tenant_id = ? AND id = ?',
				)
				.run(tenantId, workflowId);
			return 'deleted';
		});
	}

	listPublished(tenantId: string): readonly WorkflowPublishedReference[] {
		const rows = this.#database
			.prepare(
				`SELECT d.id, d.workflow_key, d.name, d.published_revision,
				 r.graph_checksum FROM workflow_definitions d
				 JOIN workflow_revisions r ON r.tenant_id = d.tenant_id
				  AND r.workflow_id = d.id AND r.revision = d.published_revision
				 WHERE d.tenant_id = ? AND d.status = 'active'
				 ORDER BY lower(d.name), d.id`,
			)
			.all(tenantId) as unknown as {
			id: string;
			workflow_key: string;
			name: string;
			published_revision: number;
			graph_checksum: string;
		}[];
		return rows.map((row) => ({
			id: row.id,
			key: row.workflow_key,
			name: row.name,
			revision: row.published_revision,
			graphChecksum: row.graph_checksum,
		}));
	}

	createRun(write: CreateWorkflowRunWrite): WorkflowRunRecord {
		return inTransaction(this.#database, () => {
			const run = write.run;
			const inputPayloadId = this.#storePayload(
				run.tenantId,
				run.id,
				'workflow.input',
				write.input,
				run.queuedAt,
			);
			this.#database
				.prepare(
					`INSERT INTO workflow_runs
					 (id, tenant_id, workflow_id, workflow_key, workflow_name,
					  workflow_revision, graph_checksum, compiler_version, graph_json,
					  compiled_order_json, mode, status, actor_json, authorization_subject_json, origin_json,
					  permission_snapshot_json, permission_digest, input_hash,
					  input_payload_id, input_evidence_json, output_evidence_json,
					  idempotency_key, limits_json, lease_owner, lease_expires_at,
					  completed_nodes, total_nodes, usage_json, cost_json, failure_code,
					  queued_at, started_at, completed_at, cancellation_requested_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
					  NULL, ?, ?, NULL, NULL, 0, ?, ?, ?, NULL, ?, NULL, NULL, NULL)`,
				)
				.run(
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
				);
			for (const node of run.graph.nodes) {
				this.#database
					.prepare(
						`INSERT INTO workflow_node_states
						 (tenant_id, run_id, node_id, status, latest_attempt)
						 VALUES (?, ?, ?, 'pending', 0)`,
					)
					.run(run.tenantId, run.id, node.id);
			}
			this.#appendEvent(
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
			this.#appendAudit(
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

	findRunByIdempotency(
		tenantId: string,
		key: string,
	): WorkflowRunRecord | null {
		const row = this.#database
			.prepare(
				`SELECT * FROM workflow_runs
				 WHERE tenant_id = ? AND idempotency_key = ?`,
			)
			.get(tenantId, key) as unknown as RunRow | undefined;
		return row ? runFromRow(row) : null;
	}

	getRun(tenantId: string, runId: string): WorkflowRunRecord | null {
		const row = this.#database
			.prepare('SELECT * FROM workflow_runs WHERE tenant_id = ? AND id = ?')
			.get(tenantId, runId) as unknown as RunRow | undefined;
		return row ? runFromRow(row) : null;
	}

	listRuns(tenantId: string, filters: WorkflowRunFilters): WorkflowRunPage {
		const limit = Math.min(
			Math.max(1, Math.trunc(filters.limit ?? 50)),
			WORKFLOW_LIMITS.maxInteractivePage,
		);
		const clauses = ['tenant_id = ?'];
		const parameters: Array<string | number> = [tenantId];
		if (filters.workflowId) {
			clauses.push('workflow_id = ?');
			parameters.push(filters.workflowId);
		}
		if (filters.mode) {
			clauses.push('mode = ?');
			parameters.push(filters.mode);
		}
		if (filters.status) {
			clauses.push('status = ?');
			parameters.push(filters.status);
		}
		if (filters.actorKind) {
			clauses.push("json_extract(actor_json, '$.kind') = ?");
			parameters.push(filters.actorKind);
		}
		if (filters.originKind) {
			clauses.push("json_extract(origin_json, '$.kind') = ?");
			parameters.push(filters.originKind);
		}
		let snapshot: { readonly queuedAt: number; readonly id: string } | null =
			null;
		if (filters.cursor) {
			const [snapshotRaw, positionRaw, extra] = filters.cursor.split('|');
			const parseBoundary = (raw: string | undefined) => {
				const separator = raw?.indexOf(':') ?? -1;
				const queuedAt = Number(raw?.slice(0, separator));
				const id = raw?.slice(separator + 1) ?? '';
				if (separator < 1 || !Number.isSafeInteger(queuedAt) || !id)
					throw new Error('WORKFLOW_CURSOR_INVALID');
				return { queuedAt, id };
			};
			if (extra !== undefined) throw new Error('WORKFLOW_CURSOR_INVALID');
			snapshot = parseBoundary(snapshotRaw);
			const position = parseBoundary(positionRaw);
			clauses.push('(queued_at < ? OR (queued_at = ? AND id <= ?))');
			parameters.push(snapshot.queuedAt, snapshot.queuedAt, snapshot.id);
			clauses.push('(queued_at < ? OR (queued_at = ? AND id < ?))');
			parameters.push(position.queuedAt, position.queuedAt, position.id);
		}
		const rows = this.#database
			.prepare(
				`SELECT * FROM workflow_runs WHERE ${clauses.join(' AND ')}
				 ORDER BY queued_at DESC, id DESC LIMIT ?`,
			)
			.all(...parameters, limit + 1) as unknown as RunRow[];
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

	runDetail(tenantId: string, runId: string): WorkflowRunDetail | null {
		const row = this.#database
			.prepare('SELECT * FROM workflow_runs WHERE tenant_id = ? AND id = ?')
			.get(tenantId, runId) as unknown as RunRow | undefined;
		if (!row) return null;
		const events = this.readEvents(
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
		const nodes = this.readNodeStates(tenantId, runId);
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
		const edges = this.readEdgeTransfers(tenantId, runId);
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

	claimNext(
		workerId: string,
		now: number,
		leaseExpiresAt: number,
	): WorkflowRunRecord | null {
		return inTransaction(this.#database, () => {
			const row = this.#database
				.prepare(
					`SELECT * FROM workflow_runs
					 WHERE mode = 'live'
					 AND (
					  status = 'queued'
					 OR (status IN ('running', 'waiting-agent') AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
					 OR (status = 'waiting-retry' AND (lease_expires_at IS NULL OR lease_expires_at <= ?) AND EXISTS (
					  SELECT 1 FROM workflow_node_states n
					  WHERE n.tenant_id = workflow_runs.tenant_id AND n.run_id = workflow_runs.id
					  AND n.status = 'waiting-retry' AND n.next_attempt_at <= ?
					 ))
					  OR (status = 'cancel-requested' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
					 )
					 ORDER BY queued_at, id LIMIT 1`,
				)
				.get(now, now, now, now) as unknown as RunRow | undefined;
			if (!row) return null;
			const priorLease = row.lease_owner;
			const recovering = priorLease !== null && row.status !== 'queued';
			/* A due retry becomes runnable again. Keeping the run in waiting-retry
			   after its node starts would make the new waiting-child projection
			   unreachable by the next claim. */
			const status =
				row.status === 'queued' || row.status === 'waiting-retry'
					? 'running'
					: row.status;
			const changed = this.#database
				.prepare(
					`UPDATE workflow_runs SET status = ?, lease_owner = ?, lease_expires_at = ?,
					 started_at = coalesce(started_at, ?)
					 WHERE tenant_id = ? AND id = ?
					 AND (lease_owner IS NULL OR lease_expires_at <= ? OR lease_owner = ?)`,
				)
				.run(
					status,
					workerId,
					leaseExpiresAt,
					now,
					row.tenant_id,
					row.id,
					now,
					workerId,
				);
			if (changed.changes !== 1) return null;
			const actor = parse<Actor>(row.actor_json);
			const origin = parse<WorkflowExecutionOrigin>(row.origin_json);
			if (recovering) {
				this.#appendEvent(
					row.tenant_id,
					row.id,
					'run.recovered',
					{ priorLease: priorLease ?? '', workerId, reason: 'lease-expired' },
					now,
				);
				this.#appendAudit(
					row.tenant_id,
					actor,
					origin,
					'workflow-run.recovered',
					'workflow-run',
					row.id,
					{ workerId },
					now,
				);
			} else if (row.status === 'queued') {
				this.#appendEvent(
					row.tenant_id,
					row.id,
					'run.claimed',
					{ workerId, leaseExpiresAt },
					now,
				);
				this.#appendAudit(
					row.tenant_id,
					actor,
					origin,
					'workflow-run.claimed',
					'workflow-run',
					row.id,
					{ workerId },
					now,
				);
			}
			return this.getRun(row.tenant_id, row.id);
		});
	}

	renewLease(
		tenantId: string,
		runId: string,
		workerId: string,
		leaseExpiresAt: number,
	): boolean {
		return (
			this.#database
				.prepare(
					`UPDATE workflow_runs SET lease_expires_at = ?
					 WHERE tenant_id = ? AND id = ? AND lease_owner = ?
					 AND status NOT IN ('succeeded', 'failed', 'refused', 'cancelled')`,
				)
				.run(leaseExpiresAt, tenantId, runId, workerId).changes === 1
		);
	}

	releaseLease(tenantId: string, runId: string, workerId: string): void {
		this.#database
			.prepare(
				`UPDATE workflow_runs SET lease_owner = NULL, lease_expires_at = NULL
				 WHERE tenant_id = ? AND id = ? AND lease_owner = ?`,
			)
			.run(tenantId, runId, workerId);
	}

	appendRunEvent(
		tenantId: string,
		runId: string,
		type: WorkflowRunEventTypeV1,
		payload: Readonly<Record<string, JsonValue>>,
		recordedAt: number,
		virtualOffsetMs?: number,
	): WorkflowRunEventV1 {
		return inTransaction(this.#database, () =>
			this.#appendEvent(
				tenantId,
				runId,
				type,
				payload,
				recordedAt,
				virtualOffsetMs,
			),
		);
	}

	readEvents(
		tenantId: string,
		runId: string,
		afterSequence: number,
		limit: number,
	): readonly WorkflowRunEventV1[] {
		return (
			this.#database
				.prepare(
					`SELECT event_id, tenant_id, run_id, sequence, event_type,
					 payload_json, recorded_at, virtual_offset_ms
					 FROM workflow_run_events
					 WHERE tenant_id = ? AND run_id = ? AND sequence > ?
					 ORDER BY sequence LIMIT ?`,
				)
				.all(
					tenantId,
					runId,
					Math.max(0, Math.trunc(afterSequence)),
					Math.min(
						Math.max(1, Math.trunc(limit)),
						WORKFLOW_LIMITS.maxRunEvents,
					),
				) as unknown as EventRow[]
		).map(eventFromRow);
	}

	startAttempt(
		write: StartAttemptWrite,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
	): WorkflowNodeAttempt {
		return inTransaction(this.#database, () => {
			const payloadId = this.#storePayload(
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
			this.#database
				.prepare(
					`INSERT INTO workflow_node_attempts
					 (tenant_id, run_id, node_id, attempt, node_type, status,
					  semantic_group, side_effect_idempotency_key, input_payload_id,
					  input_evidence_json, output_evidence_json, started_at)
					 VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
				)
				.run(
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
				);
			this.#database
				.prepare(
					`UPDATE workflow_node_states
					 SET status = 'running', latest_attempt = ?,
					  ready_at = coalesce(ready_at, ?), started_at = coalesce(started_at, ?)
					 WHERE tenant_id = ? AND run_id = ? AND node_id = ?`,
				)
				.run(
					write.attempt,
					write.recordedAt,
					write.recordedAt,
					write.tenantId,
					write.runId,
					write.nodeId,
				);
			this.#appendEvent(
				write.tenantId,
				write.runId,
				'node.ready',
				{ nodeId: write.nodeId },
				write.recordedAt,
				write.virtualOffsetMs,
			);
			if (write.attempt > 1) {
				this.#appendEvent(
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
			this.#appendEvent(
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
			this.#appendAudit(
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

	markChildWaiting(
		tenantId: string,
		runId: string,
		nodeId: string,
		attempt: number,
		childKind: 'agent' | 'action',
		childId: string,
		observationDeadlineAt: number,
		recordedAt: number,
	): void {
		inTransaction(this.#database, () => {
			const changed = this.#database
				.prepare(
					`UPDATE workflow_node_attempts
					 SET status = 'waiting-child', child_kind = ?, child_id = ?,
					 child_observation_deadline_at = ?
					 WHERE tenant_id = ? AND run_id = ? AND node_id = ? AND attempt = ?
					 AND status = 'running'`,
				)
				.run(
					childKind,
					childId,
					observationDeadlineAt,
					tenantId,
					runId,
					nodeId,
					attempt,
				);
			if (changed.changes !== 1) throw new Error('WORKFLOW_ATTEMPT_TERMINAL');
			this.#database
				.prepare(
					`UPDATE workflow_node_states SET status = 'waiting-child'
					 WHERE tenant_id = ? AND run_id = ? AND node_id = ?`,
				)
				.run(tenantId, runId, nodeId);
			if (childKind === 'agent') {
				this.#database
					.prepare(
						`UPDATE workflow_runs SET status = 'waiting-agent'
						 WHERE tenant_id = ? AND id = ? AND status = 'running'`,
					)
					.run(tenantId, runId);
			}
			this.#appendEvent(
				tenantId,
				runId,
				'node.child.waiting',
				{ nodeId, attempt, childKind, childId, observationDeadlineAt },
				recordedAt,
			);
		});
	}

	settleAttempt(
		write: SettleAttemptWrite,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
	): WorkflowNodeAttempt {
		return inTransaction(this.#database, () => {
			const prior = this.#database
				.prepare(
					`SELECT * FROM workflow_node_attempts
					 WHERE tenant_id = ? AND run_id = ? AND node_id = ? AND attempt = ?`,
				)
				.get(
					write.tenantId,
					write.runId,
					write.nodeId,
					write.attempt,
				) as unknown as AttemptRow | undefined;
			if (!prior || !['running', 'waiting-child'].includes(prior.status)) {
				throw new Error('WORKFLOW_ATTEMPT_TERMINAL');
			}
			const payloadId =
				write.output === undefined
					? null
					: this.#storePayload(
							write.tenantId,
							write.runId,
							write.schemaId,
							write.output,
							write.recordedAt,
						);
			const duration = Math.max(0, write.recordedAt - prior.started_at);
			this.#database
				.prepare(
					`UPDATE workflow_node_attempts
					 SET status = ?, outcome_port = ?, output_payload_id = ?,
					  output_evidence_json = ?, failure_code = ?, retry_classification = ?,
					  selected_backoff_ms = ?, next_attempt_at = ?, completed_at = ?, duration_ms = ?
					 WHERE tenant_id = ? AND run_id = ? AND node_id = ? AND attempt = ?`,
				)
				.run(
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
				);
			const retrying = write.nextAttemptAt !== null;
			if (!retrying && prior.child_kind === 'action') {
				const run = this.getRun(write.tenantId, write.runId);
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
					this.#database
						.prepare(
							'UPDATE workflow_runs SET usage_json = ?, cost_json = ? WHERE tenant_id = ? AND id = ?',
						)
						.run(
							JSON.stringify(usage),
							JSON.stringify(cost),
							write.tenantId,
							write.runId,
						);
				}
			}
			const nodeStatus = retrying ? 'waiting-retry' : write.status;
			this.#database
				.prepare(
					`UPDATE workflow_node_states
					 SET status = ?, selected_outcome_port = ?, next_attempt_at = ?,
					  settled_at = ?
					 WHERE tenant_id = ? AND run_id = ? AND node_id = ?`,
				)
				.run(
					nodeStatus,
					write.outcomePort,
					write.nextAttemptAt,
					retrying ? null : write.recordedAt,
					write.tenantId,
					write.runId,
					write.nodeId,
				);
			this.#database
				.prepare(
					`UPDATE workflow_runs SET status = ?,
					 completed_nodes = completed_nodes + ?
					 WHERE tenant_id = ? AND id = ? AND status NOT IN
					 ('cancel-requested', 'succeeded', 'failed', 'refused', 'cancelled')`,
				)
				.run(
					retrying ? 'waiting-retry' : 'running',
					retrying ? 0 : 1,
					write.tenantId,
					write.runId,
				);
			this.#appendEvent(
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
				this.#appendEvent(
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
			this.#appendAudit(
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

	settleEdge(write: SettleEdgeWrite): WorkflowEdgeTransfer {
		return inTransaction(this.#database, () => {
			const transfer = write.transfer;
			const schemaId = transfer.evidence.schemaId;
			const payloadId =
				write.payload === undefined
					? null
					: this.#storePayload(
							write.tenantId,
							write.runId,
							schemaId,
							write.payload,
							transfer.settledAt,
						);
			this.#database
				.prepare(
					`INSERT INTO workflow_edge_transfers
					 (tenant_id, run_id, edge_id, source_node_id, source_port,
					  source_attempt, target_node_id, target_port, state, reason,
					  schema_id, payload_id, evidence_json, settled_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
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
				);
			this.#appendEvent(
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

	markNodeSkipped(
		tenantId: string,
		runId: string,
		nodeId: string,
		reason: string,
		recordedAt: number,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
		virtualOffsetMs?: number,
	): void {
		inTransaction(this.#database, () => {
			const changed = this.#database
				.prepare(
					`UPDATE workflow_node_states
					 SET status = 'skipped', settled_at = ?
					 WHERE tenant_id = ? AND run_id = ? AND node_id = ?
					 AND status IN ('pending', 'ready')`,
				)
				.run(recordedAt, tenantId, runId, nodeId);
			if (changed.changes !== 1) return;
			this.#database
				.prepare(
					`UPDATE workflow_runs SET completed_nodes = completed_nodes + 1
					 WHERE tenant_id = ? AND id = ?`,
				)
				.run(tenantId, runId);
			this.#appendEvent(
				tenantId,
				runId,
				'node.skipped',
				{ nodeId, reason },
				recordedAt,
				virtualOffsetMs,
			);
			this.#appendAudit(
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

	settleRun(
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
	): WorkflowRunRecord | null {
		return inTransaction(this.#database, () => {
			const before = this.getRun(tenantId, runId);
			if (!before) return null;
			if (TERMINAL_RUNS.has(before.status)) return before;
			const eventType = `run.${status}` as WorkflowRunEventTypeV1;
			this.#database
				.prepare(
					`UPDATE workflow_runs SET status = ?, failure_code = ?,
					 output_evidence_json = ?, usage_json = ?, cost_json = ?,
					 completed_at = ?, lease_owner = NULL, lease_expires_at = NULL
					 WHERE tenant_id = ? AND id = ?`,
				)
				.run(
					status,
					failureCode,
					JSON.stringify(outputEvidence),
					JSON.stringify(usage),
					JSON.stringify(cost),
					recordedAt,
					tenantId,
					runId,
				);
			this.#database
				.prepare(
					`UPDATE workflow_payloads SET expires_at = ?
					 WHERE tenant_id = ? AND run_id = ? AND kind = 'execution'`,
				)
				.run(recordedAt + this.#payloadRetentionMs, tenantId, runId);
			this.#appendEvent(
				tenantId,
				runId,
				eventType,
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
			this.#appendAudit(
				tenantId,
				before.actor,
				before.origin,
				`workflow-run.${status}`,
				'workflow-run',
				runId,
				{ failureCode },
				recordedAt,
			);
			return this.getRun(tenantId, runId);
		});
	}

	requestCancellation(
		tenantId: string,
		runId: string,
		actor: Actor,
		origin: WorkflowExecutionOrigin,
		recordedAt: number,
	): { readonly run: WorkflowRunRecord; readonly requested: boolean } | null {
		return inTransaction(this.#database, () => {
			const run = this.getRun(tenantId, runId);
			if (!run) return null;
			if (TERMINAL_RUNS.has(run.status) || run.status === 'cancel-requested') {
				return { run, requested: false };
			}
			this.#database
				.prepare(
					`UPDATE workflow_runs SET status = 'cancel-requested',
					 cancellation_requested_at = ?, lease_owner = NULL, lease_expires_at = NULL
					 WHERE tenant_id = ? AND id = ?`,
				)
				.run(recordedAt, tenantId, runId);
			this.#appendEvent(
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
			this.#appendAudit(
				tenantId,
				actor,
				origin,
				'workflow-run.cancel.requested',
				'workflow-run',
				runId,
				{},
				recordedAt,
			);
			return { run: this.getRun(tenantId, runId)!, requested: true };
		});
	}

	readExecutionPayload(
		tenantId: string,
		runId: string,
		payloadId: string,
	): JsonValue {
		const row = this.#database
			.prepare(
				`SELECT ciphertext FROM workflow_payloads
				 WHERE tenant_id = ? AND run_id = ? AND id = ? AND kind = 'execution'`,
			)
			.get(tenantId, runId, payloadId) as { ciphertext: string } | undefined;
		if (!row) throw new Error('WORKFLOW_PAYLOAD_UNREADABLE');
		return this.#payloadCodec.decrypt(row.ciphertext, {
			tenantId,
			runId,
			payloadId,
		});
	}

	readEdgePayload(
		tenantId: string,
		runId: string,
		edgeId: string,
	): JsonValue | undefined {
		const row = this.#database
			.prepare(
				`SELECT payload_id FROM workflow_edge_transfers
				 WHERE tenant_id = ? AND run_id = ? AND edge_id = ? AND state = 'emitted'`,
			)
			.get(tenantId, runId, edgeId) as
			| { payload_id: string | null }
			| undefined;
		return row?.payload_id
			? this.readExecutionPayload(tenantId, runId, row.payload_id)
			: undefined;
	}

	recordAgentUsage(
		tenantId: string,
		runId: string,
		childRunId: string,
		usage: {
			readonly inputTokens: number;
			readonly outputTokens: number;
			readonly totalTokens: number;
		},
	): void {
		inTransaction(this.#database, () => {
			const run = this.getRun(tenantId, runId);
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
			this.#database
				.prepare(
					'UPDATE workflow_runs SET usage_json = ?, cost_json = ? WHERE tenant_id = ? AND id = ?',
				)
				.run(JSON.stringify(next), JSON.stringify(cost), tenantId, runId);
		});
	}

	readNodeStates(
		tenantId: string,
		runId: string,
	): readonly WorkflowNodeExecution[] {
		const states = this.#database
			.prepare(
				`SELECT node_id, status, latest_attempt, selected_outcome_port,
				 next_attempt_at, ready_at, started_at, settled_at
				 FROM workflow_node_states WHERE tenant_id = ? AND run_id = ?
				 ORDER BY node_id`,
			)
			.all(tenantId, runId) as unknown as NodeStateRow[];
		const attempts = this.#database
			.prepare(
				`SELECT node_id, attempt, node_type, status, outcome_port,
				 semantic_group, side_effect_idempotency_key, input_evidence_json,
				 output_evidence_json, child_kind, child_id,
				 child_observation_deadline_at, failure_code,
				 retry_classification, selected_backoff_ms, next_attempt_at,
				 started_at, completed_at, duration_ms
				 FROM workflow_node_attempts WHERE tenant_id = ? AND run_id = ?
				 ORDER BY node_id, attempt`,
			)
			.all(tenantId, runId) as unknown as AttemptRow[];
		return states.map((state) => ({
			nodeId: state.node_id,
			status: state.status,
			latestAttempt: state.latest_attempt,
			selectedOutcomePort: state.selected_outcome_port,
			nextAttemptAt: state.next_attempt_at,
			readyAt: state.ready_at,
			startedAt: state.started_at,
			settledAt: state.settled_at,
			attempts: attempts
				.filter((attempt) => attempt.node_id === state.node_id)
				.map(attemptFromRow),
		}));
	}

	readEdgeTransfers(
		tenantId: string,
		runId: string,
	): readonly WorkflowEdgeTransfer[] {
		return (
			this.#database
				.prepare(
					`SELECT edge_id, source_node_id, source_port, source_attempt,
					 target_node_id, target_port, state, reason, evidence_json, settled_at
					 FROM workflow_edge_transfers WHERE tenant_id = ? AND run_id = ?
					 ORDER BY edge_id`,
				)
				.all(tenantId, runId) as unknown as EdgeRow[]
		).map((row) => ({
			edgeId: row.edge_id,
			sourceNodeId: row.source_node_id,
			sourcePort: row.source_port,
			sourceAttempt: row.source_attempt,
			targetNodeId: row.target_node_id,
			targetPort: row.target_port,
			state: row.state,
			reason: row.reason,
			evidence: parse<WorkflowPayloadEvidenceV1>(row.evidence_json),
			settledAt: row.settled_at,
		}));
	}

	listAudit(
		tenantId: string,
		limit: number,
		beforeSequence?: number,
	): WorkflowAuditPage {
		const bounded = Math.min(Math.max(1, Math.trunc(limit)), 100);
		const rows = this.#database
			.prepare(
				`SELECT sequence, actor_json, origin_json, action, subject_type,
				 subject_id, metadata_json, occurred_at, previous_hash, event_hash
				 FROM workflow_audit_events WHERE tenant_id = ?
				 ${beforeSequence === undefined ? '' : 'AND sequence < ?'}
				 ORDER BY sequence DESC LIMIT ?`,
			)
			.all(
				...(beforeSequence === undefined
					? [tenantId, bounded + 1]
					: [tenantId, beforeSequence, bounded + 1]),
			) as unknown as AuditRow[];
		const events = rows.slice(0, bounded).map(auditFromRow);
		return {
			events,
			nextCursor:
				rows.length > bounded && events.at(-1)
					? String(events.at(-1)!.sequence)
					: null,
		};
	}

	verifyAudit(tenantId: string): WorkflowAuditVerification {
		const rows = this.#database
			.prepare(
				`SELECT sequence, actor_json, origin_json, action, subject_type,
				 subject_id, metadata_json, occurred_at, previous_hash, event_hash
				 FROM workflow_audit_events WHERE tenant_id = ? ORDER BY sequence`,
			)
			.all(tenantId) as unknown as AuditRow[];
		let previousHash: string | null = null;
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
		}
		return {
			valid: true,
			checkedThroughSequence: rows.at(-1)?.sequence ?? 0,
		};
	}

	applyPayloadRetention(now: number, limit = 100): number {
		const boundedLimit = Math.min(Math.max(1, Math.trunc(limit)), 1_000);
		return inTransaction(this.#database, () => {
			const rows = this.#database
				.prepare(
					`SELECT p.id, p.tenant_id, p.run_id, p.payload_hash
					 FROM workflow_payloads p
					 JOIN workflow_runs r ON r.tenant_id = p.tenant_id AND r.id = p.run_id
					 WHERE p.kind = 'execution' AND p.expires_at IS NOT NULL
					 AND p.expires_at <= ?
					 AND r.status IN ('succeeded', 'failed', 'refused', 'cancelled')
					 ORDER BY p.expires_at, p.id LIMIT ?`,
				)
				.all(now, boundedLimit) as unknown as {
				id: string;
				tenant_id: string;
				run_id: string;
				payload_hash: string;
			}[];
			const expire = (column: string) =>
				`json_set(json_remove(${column}, '$.preview'), '$.state', 'expired', '$.reason', 'retention')`;
			for (const row of rows) {
				this.#appendEvent(
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
				this.#database
					.prepare(
						`UPDATE workflow_runs SET input_evidence_json = ${expire('input_evidence_json')}
						 WHERE tenant_id = ? AND id = ? AND input_payload_id = ?`,
					)
					.run(row.tenant_id, row.run_id, row.id);
				this.#database
					.prepare(
						`UPDATE workflow_node_attempts
						 SET input_evidence_json = CASE WHEN input_payload_id = ? THEN ${expire('input_evidence_json')} ELSE input_evidence_json END,
						 output_evidence_json = CASE WHEN output_payload_id = ? THEN ${expire('output_evidence_json')} ELSE output_evidence_json END
						 WHERE tenant_id = ? AND run_id = ? AND (input_payload_id = ? OR output_payload_id = ?)`,
					)
					.run(row.id, row.id, row.tenant_id, row.run_id, row.id, row.id);
				this.#database
					.prepare(
						`UPDATE workflow_edge_transfers SET evidence_json = ${expire('evidence_json')}
						 WHERE tenant_id = ? AND run_id = ? AND payload_id = ?`,
					)
					.run(row.tenant_id, row.run_id, row.id);
				this.#database
					.prepare(
						'DELETE FROM workflow_payloads WHERE tenant_id = ? AND run_id = ? AND id = ?',
					)
					.run(row.tenant_id, row.run_id, row.id);
				const remaining = this.#database
					.prepare(
						`SELECT count(*) AS count FROM workflow_payloads
						 WHERE tenant_id = ? AND run_id = ? AND kind = 'execution'`,
					)
					.get(row.tenant_id, row.run_id) as { count: number };
				if (remaining.count === 0) {
					this.#database
						.prepare(
							`UPDATE workflow_runs SET output_evidence_json =
							 CASE WHEN output_evidence_json IS NULL THEN NULL ELSE ${expire('output_evidence_json')} END
							 WHERE tenant_id = ? AND id = ?`,
						)
						.run(row.tenant_id, row.run_id);
				}
			}
			return rows.length;
		});
	}

	countRuns(tenantId: string): number {
		return (
			this.#database
				.prepare(
					'SELECT count(*) AS count FROM workflow_runs WHERE tenant_id = ?',
				)
				.get(tenantId) as { count: number }
		).count;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#database.close();
	}
}
