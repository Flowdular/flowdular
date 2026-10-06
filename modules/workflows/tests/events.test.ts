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
	it('rebuilds run and node state from the ordered v1 catalog', async () => {
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

	it('refuses an unknown persisted event schema without guessing', async () => {
		const corrupted = structuredClone(successfulEvents[0]);
		Object.defineProperty(corrupted, 'schemaVersion', { value: 2 });
		expect(() => projectWorkflowRunEvents([corrupted])).toThrowError(
			expect.objectContaining<Partial<WorkflowEventProjectionError>>({
				code: 'WORKFLOW_EVENT_SCHEMA_UNSUPPORTED',
			}),
		);
	});

	it('keeps a requested cancellation over a child or a retry recorded after it', async () => {
		const started = [
			...successfulEvents.slice(0, 2),
			event(3, 'node.ready', { nodeId: 'agent.process' }),
			event(4, 'node.attempt.started', {
				nodeId: 'agent.process',
				attempt: 1,
				semanticGroup: 'run-a:agent.process',
				input: { state: 'redacted' },
			}),
		];
		const child = {
			nodeId: 'agent.process',
			attempt: 1,
			childKind: 'agent',
			childId: 'child-1',
			observationDeadlineAt: 100,
		};
		const settled = (status: string, failureCode: string | null) => ({
			nodeId: 'agent.process',
			attempt: 1,
			status,
			outcomePort: null,
			output: { state: 'redacted' },
			failureCode,
			retryClassification: failureCode ? 'retryable' : null,
		});
		const childAfterCancel = [
			...started,
			event(5, 'run.cancel.requested', { requestedAt: 5 }),
			event(6, 'node.child.waiting', child),
		];
		expect(projectWorkflowRunEvents(childAfterCancel)).toMatchObject({
			status: 'cancel-requested',
			nodeStatuses: { 'agent.process': 'waiting-child' },
		});
		expect(
			projectWorkflowRunEvents([
				...childAfterCancel,
				event(7, 'node.attempt.settled', settled('cancelled', null)),
				event(8, 'run.cancelled', successfulEvents[5].payload),
			]).status,
		).toBe('cancelled');

		const retryAfterCancel = [
			...started,
			event(5, 'node.child.waiting', child),
			event(6, 'run.cancel.requested', { requestedAt: 6 }),
			event(7, 'node.attempt.settled', settled('failed', 'PROVIDER_FAILED')),
			event(8, 'node.retry.scheduled', {
				nodeId: 'agent.process',
				attempt: 1,
				classification: 'retryable',
				backoffMs: 1,
				nextAttemptAt: 9,
			}),
		];
		expect(projectWorkflowRunEvents(retryAfterCancel)).toMatchObject({
			status: 'cancel-requested',
			nodeStatuses: { 'agent.process': 'waiting-retry' },
		});
		expect(
			projectWorkflowRunEvents([
				...retryAfterCancel,
				event(9, 'run.cancelled', successfulEvents[5].payload),
			]).status,
		).toBe('cancelled');
		expect(() =>
			projectWorkflowRunEvents([
				...retryAfterCancel,
				event(9, 'node.ready', { nodeId: 'agent.process' }),
			]),
		).toThrowError(
			expect.objectContaining<Partial<WorkflowEventProjectionError>>({
				code: 'WORKFLOW_EVENT_TRANSITION_INVALID',
			}),
		);
	});

	it('refuses a transition after a terminal event', async () => {
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
