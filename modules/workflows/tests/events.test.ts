import { describe, expect, it } from 'vitest';
import {
	projectWorkflowRunEvents,
	WorkflowEventProjectionError,
} from '../src/domain/events.ts';
import type {
	JsonValue,
	WorkflowRunEventTypeV1,
	WorkflowRunEventV1,
} from '../src/domain/types.ts';

function event(
	sequence: number,
	type: WorkflowRunEventTypeV1,
	payload: Readonly<Record<string, JsonValue>>,
): WorkflowRunEventV1 {
	return {
		eventId: `event-${sequence}`,
		schemaVersion: 1,
		tenantId: 'tenant-a',
		runId: 'run-a',
		sequence,
		type,
		recordedAt: sequence,
		payload,
	};
}

const successfulEvents = [
	event(1, 'run.queued', {
		workflowRevision: 2,
		graphChecksum: 'checksum',
		actor: { kind: 'user', id: 'owner-1' },
		origin: { kind: 'manual' },
		mode: 'live',
	}),
	event(2, 'run.claimed', { workerId: 'worker-1', leaseExpiresAt: 100 }),
	event(3, 'node.ready', { nodeId: 'input.start' }),
	event(4, 'node.attempt.started', {
		nodeId: 'input.start',
		attempt: 1,
		semanticGroup: 'run-a:input.start',
		input: { state: 'redacted' },
	}),
	event(5, 'node.attempt.settled', {
		nodeId: 'input.start',
		attempt: 1,
		status: 'succeeded',
		outcomePort: 'data',
		output: { state: 'redacted' },
		failureCode: null,
		retryClassification: null,
	}),
	event(6, 'run.succeeded', {
		failureCode: null,
		output: { state: 'redacted' },
		usage: { state: 'final' },
		cost: { state: 'final' },
	}),
] as const;

describe('workflow event projection', () => {
	it('rebuilds run and node state from the ordered v1 catalog', () => {
		expect(projectWorkflowRunEvents(successfulEvents)).toEqual({
			tenantId: 'tenant-a',
			runId: 'run-a',
			latestSequence: 6,
			status: 'succeeded',
			nodeStatuses: { 'input.start': 'succeeded' },
			edgeStates: {},
			attempts: {
				'input.start:1': {
					nodeId: 'input.start',
					attempt: 1,
					status: 'succeeded',
					outcomePort: 'data',
				},
			},
		});
	});

	it('refuses an unknown persisted event schema without guessing', () => {
		const corrupted = structuredClone(successfulEvents[0]);
		Object.defineProperty(corrupted, 'schemaVersion', { value: 2 });
		expect(() => projectWorkflowRunEvents([corrupted])).toThrowError(
			expect.objectContaining<Partial<WorkflowEventProjectionError>>({
				code: 'WORKFLOW_EVENT_SCHEMA_UNSUPPORTED',
			}),
		);
	});

	it('refuses a transition after a terminal event', () => {
		const illegal = [
			...successfulEvents,
			event(7, 'node.ready', { nodeId: 'too-late' }),
		];
		expect(() => projectWorkflowRunEvents(illegal)).toThrowError(
			expect.objectContaining<Partial<WorkflowEventProjectionError>>({
				code: 'WORKFLOW_EVENT_TRANSITION_INVALID',
			}),
		);
	});
});
