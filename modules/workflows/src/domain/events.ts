import type {
	JsonValue,
	WorkflowAttemptStatus,
	WorkflowNodeStatus,
	WorkflowRunEventTypeV1,
	WorkflowRunEventV1,
	WorkflowRunStatus,
} from './types.ts';

const EVENT_REQUIREMENTS = {
	'run.queued': [
		'workflowRevision',
		'graphChecksum',
		'actor',
		'origin',
		'mode',
	],
	'run.claimed': ['workerId', 'leaseExpiresAt'],
	'run.recovered': ['priorLease', 'workerId', 'reason'],
	'node.ready': ['nodeId'],
	'node.attempt.started': ['nodeId', 'attempt', 'semanticGroup', 'input'],
	'node.child.waiting': [
		'nodeId',
		'attempt',
		'childKind',
		'childId',
		'observationDeadlineAt',
	],
	'node.attempt.settled': [
		'nodeId',
		'attempt',
		'status',
		'outcomePort',
		'output',
		'failureCode',
		'retryClassification',
	],
	'node.retry.scheduled': [
		'nodeId',
		'attempt',
		'classification',
		'backoffMs',
		'nextAttemptAt',
	],
	'node.retry.started': ['nodeId', 'attempt', 'semanticGroup'],
	'node.skipped': ['nodeId', 'reason'],
	'edge.settled': [
		'edgeId',
		'state',
		'sourceAttempt',
		'targetNodeId',
		'evidence',
	],
	'run.cancel.requested': ['requestedAt'],
	'node.cancel.requested': ['nodeId', 'attempt', 'childKind', 'childId'],
	'node.cancel.acknowledged': ['nodeId', 'attempt', 'childKind', 'childId'],
	'node.cancel.not-acknowledged': [
		'nodeId',
		'attempt',
		'childKind',
		'childId',
		'reason',
	],
	'node.result.late-ignored': [
		'nodeId',
		'attempt',
		'childKind',
		'childId',
		'terminalStatus',
		'outputHash',
		'evidenceState',
	],
	'payload.retention.applied': [
		'payloadId',
		'hash',
		'policy',
		'priorEvidenceState',
	],
	'run.succeeded': ['failureCode', 'output', 'usage', 'cost'],
	'run.failed': ['failureCode', 'output', 'usage', 'cost'],
	'run.refused': ['failureCode', 'output', 'usage', 'cost'],
	'run.cancelled': ['failureCode', 'output', 'usage', 'cost'],
} as const satisfies Record<WorkflowRunEventTypeV1, readonly string[]>;

const EVENT_TYPES = new Set<string>(Object.keys(EVENT_REQUIREMENTS));
const TERMINAL = new Set<WorkflowRunStatus>([
	'succeeded',
	'failed',
	'refused',
	'cancelled',
]);

export class WorkflowEventProjectionError extends Error {
	constructor(
		readonly code:
			| 'WORKFLOW_EVENT_SCHEMA_UNSUPPORTED'
			| 'WORKFLOW_EVENT_TRANSITION_INVALID',
		message: string,
	) {
		super(message);
		this.name = 'WorkflowEventProjectionError';
	}
}

export interface WorkflowEventProjectionV1 {
	readonly tenantId: string;
	readonly runId: string;
	readonly latestSequence: number;
	readonly status: WorkflowRunStatus;
	readonly nodeStatuses: Readonly<Record<string, WorkflowNodeStatus>>;
	readonly edgeStates: Readonly<
		Record<string, 'emitted' | 'closed' | 'skipped'>
	>;
	readonly attempts: Readonly<
		Record<
			string,
			{
				readonly nodeId: string;
				readonly attempt: number;
				readonly status: WorkflowAttemptStatus;
				readonly outcomePort: string | null;
			}
		>
	>;
}

function record(value: JsonValue): Readonly<Record<string, JsonValue>> | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	const output: Record<string, JsonValue> = {};
	for (const [key, child] of Object.entries(value)) output[key] = child;
	return output;
}

function requiredString(
	payload: Readonly<Record<string, JsonValue>>,
	key: string,
): string {
	const value = payload[key];
	if (typeof value !== 'string' || value.length === 0) {
		throw new WorkflowEventProjectionError(
			'WORKFLOW_EVENT_SCHEMA_UNSUPPORTED',
			`Workflow event payload is missing string field "${key}".`,
		);
	}
	return value;
}

function requiredInteger(
	payload: Readonly<Record<string, JsonValue>>,
	key: string,
): number {
	const value = payload[key];
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
		throw new WorkflowEventProjectionError(
			'WORKFLOW_EVENT_SCHEMA_UNSUPPORTED',
			`Workflow event payload is missing positive integer field "${key}".`,
		);
	}
	return value;
}

function attemptKey(nodeId: string, attempt: number): string {
	return `${nodeId}:${attempt}`;
}

function assertEnvelope(
	event: WorkflowRunEventV1,
	first: WorkflowRunEventV1,
	expectedSequence: number,
): void {
	if (
		event.schemaVersion !== 1 ||
		!EVENT_TYPES.has(event.type) ||
		event.sequence !== expectedSequence ||
		event.tenantId !== first.tenantId ||
		event.runId !== first.runId ||
		!record(event.payload)
	) {
		throw new WorkflowEventProjectionError(
			'WORKFLOW_EVENT_SCHEMA_UNSUPPORTED',
			`Workflow event ${expectedSequence} has an unsupported envelope.`,
		);
	}
	for (const field of EVENT_REQUIREMENTS[event.type]) {
		if (!(field in event.payload)) {
			throw new WorkflowEventProjectionError(
				'WORKFLOW_EVENT_SCHEMA_UNSUPPORTED',
				`Workflow event ${event.type} is missing payload field "${field}".`,
			);
		}
	}
}

function transitionError(event: WorkflowRunEventV1, status: WorkflowRunStatus) {
	throw new WorkflowEventProjectionError(
		'WORKFLOW_EVENT_TRANSITION_INVALID',
		`Workflow event ${event.type} is illegal while the run is ${status}.`,
	);
}

export function projectWorkflowRunEvents(
	events: readonly WorkflowRunEventV1[],
): WorkflowEventProjectionV1 {
	const first = events[0];
	if (!first || first.type !== 'run.queued' || first.sequence !== 1) {
		throw new WorkflowEventProjectionError(
			'WORKFLOW_EVENT_TRANSITION_INVALID',
			'Workflow event projection must begin with run.queued at sequence 1.',
		);
	}
	let status: WorkflowRunStatus = 'queued';
	const nodeStatuses = new Map<string, WorkflowNodeStatus>();
	const edgeStates = new Map<string, 'emitted' | 'closed' | 'skipped'>();
	const attempts = new Map<
		string,
		{
			readonly nodeId: string;
			readonly attempt: number;
			readonly status: WorkflowAttemptStatus;
			readonly outcomePort: string | null;
		}
	>();
	for (const [index, event] of events.entries()) {
		assertEnvelope(event, first, index + 1);
		if (
			index > 0 &&
			TERMINAL.has(status) &&
			event.type !== 'payload.retention.applied'
		) {
			transitionError(event, status);
		}
		switch (event.type) {
			case 'run.queued':
				if (index !== 0) transitionError(event, status);
				break;
			case 'run.claimed':
				if (
					!['queued', 'running', 'waiting-agent', 'waiting-retry'].includes(
						status,
					)
				)
					transitionError(event, status);
				status = 'running';
				break;
			case 'run.recovered':
				if (status === 'queued' || TERMINAL.has(status))
					transitionError(event, status);
				break;
			case 'node.ready':
				if (status === 'cancel-requested') transitionError(event, status);
				nodeStatuses.set(requiredString(event.payload, 'nodeId'), 'ready');
				status = 'running';
				break;
			case 'node.attempt.started': {
				if (status === 'cancel-requested') transitionError(event, status);
				const nodeId = requiredString(event.payload, 'nodeId');
				const attempt = requiredInteger(event.payload, 'attempt');
				const key = attemptKey(nodeId, attempt);
				if (attempts.has(key)) transitionError(event, status);
				attempts.set(key, {
					nodeId,
					attempt,
					status: 'running',
					outcomePort: null,
				});
				nodeStatuses.set(nodeId, 'running');
				status = 'running';
				break;
			}
			case 'node.child.waiting': {
				if (status === 'cancel-requested') transitionError(event, status);
				const nodeId = requiredString(event.payload, 'nodeId');
				const attempt = requiredInteger(event.payload, 'attempt');
				const key = attemptKey(nodeId, attempt);
				const prior = attempts.get(key);
				if (!prior || prior.status !== 'running')
					transitionError(event, status);
				attempts.set(key, {
					nodeId,
					attempt,
					status: 'waiting-child',
					outcomePort: null,
				});
				nodeStatuses.set(nodeId, 'waiting-child');
				status =
					requiredString(event.payload, 'childKind') === 'agent'
						? 'waiting-agent'
						: 'running';
				break;
			}
			case 'node.attempt.settled': {
				const nodeId = requiredString(event.payload, 'nodeId');
				const attempt = requiredInteger(event.payload, 'attempt');
				const key = attemptKey(nodeId, attempt);
				const prior = attempts.get(key);
				if (
					!prior ||
					(prior.status !== 'running' && prior.status !== 'waiting-child')
				) {
					transitionError(event, status);
				}
				const attemptStatus = requiredString(event.payload, 'status');
				if (
					!['succeeded', 'failed', 'refused', 'cancelled'].includes(
						attemptStatus,
					)
				)
					throw new WorkflowEventProjectionError(
						'WORKFLOW_EVENT_SCHEMA_UNSUPPORTED',
						`Workflow attempt status "${attemptStatus}" is unsupported.`,
					);
				const outcomePort = event.payload.outcomePort;
				if (outcomePort !== null && typeof outcomePort !== 'string') {
					throw new WorkflowEventProjectionError(
						'WORKFLOW_EVENT_SCHEMA_UNSUPPORTED',
						'Workflow attempt outcomePort must be a string or null.',
					);
				}
				attempts.set(key, {
					nodeId,
					attempt,
					status: attemptStatus as WorkflowAttemptStatus,
					outcomePort,
				});
				nodeStatuses.set(nodeId, attemptStatus as WorkflowNodeStatus);
				if (status !== 'cancel-requested') status = 'running';
				break;
			}
			case 'node.retry.scheduled':
				nodeStatuses.set(
					requiredString(event.payload, 'nodeId'),
					'waiting-retry',
				);
				status = 'waiting-retry';
				break;
			case 'node.retry.started':
				nodeStatuses.set(requiredString(event.payload, 'nodeId'), 'running');
				status = 'running';
				break;
			case 'node.skipped':
				nodeStatuses.set(requiredString(event.payload, 'nodeId'), 'skipped');
				break;
			case 'run.cancel.requested':
				if (TERMINAL.has(status)) transitionError(event, status);
				status = 'cancel-requested';
				break;
			case 'run.succeeded':
				if (!['running', 'waiting-agent', 'waiting-retry'].includes(status))
					transitionError(event, status);
				status = 'succeeded';
				break;
			case 'run.failed':
				if (!['running', 'waiting-agent', 'waiting-retry'].includes(status))
					transitionError(event, status);
				status = 'failed';
				break;
			case 'run.refused':
				if (status === 'cancel-requested' || TERMINAL.has(status))
					transitionError(event, status);
				status = 'refused';
				break;
			case 'run.cancelled':
				if (status !== 'cancel-requested') transitionError(event, status);
				status = 'cancelled';
				break;
			case 'edge.settled': {
				const edgeState = requiredString(event.payload, 'state');
				if (!['emitted', 'closed', 'skipped'].includes(edgeState)) {
					throw new WorkflowEventProjectionError(
						'WORKFLOW_EVENT_SCHEMA_UNSUPPORTED',
						`Workflow edge state "${edgeState}" is unsupported.`,
					);
				}
				edgeStates.set(
					requiredString(event.payload, 'edgeId'),
					edgeState as 'emitted' | 'closed' | 'skipped',
				);
				break;
			}
			case 'node.cancel.requested':
			case 'node.cancel.acknowledged':
			case 'node.cancel.not-acknowledged':
			case 'node.result.late-ignored':
			case 'payload.retention.applied':
				break;
		}
	}
	return {
		tenantId: first.tenantId,
		runId: first.runId,
		latestSequence: events.length,
		status,
		nodeStatuses: Object.fromEntries(nodeStatuses),
		edgeStates: Object.fromEntries(edgeStates),
		attempts: Object.fromEntries(attempts),
	};
}
