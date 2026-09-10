import { describe, expect, it } from 'vitest';
import type { AgentExecutionEvent } from '@flowdular/harness';
import {
	groupRunTimeline,
	timelineSequence,
} from '../src/domain/run-timeline.ts';

function event(
	sequence: number,
	type: AgentExecutionEvent['type'],
	message: string,
	metadata: Readonly<Record<string, string | number | boolean>> = {},
): AgentExecutionEvent {
	return {
		sequence,
		type,
		message,
		timestamp: 1_700_000_000_000 + sequence,
		metadata,
	};
}

describe('run timeline presentation', () => {
	it('folds only contiguous output deltas from the same stream', async () => {
		const events = [
			event(1, 'provider.output.delta', 'Hel', { stream: 'answer-1' }),
			event(2, 'provider.output.delta', 'lo', { stream: 'answer-1' }),
			event(3, 'tool.started', 'Started lookup.', {
				tool: 'parties.customer.read',
			}),
			event(4, 'provider.output.delta', 'World', { stream: 'answer-1' }),
			event(5, 'provider.output.delta', '!', { stream: 'answer-2' }),
		] as const;
		const original = structuredClone(events);

		const timeline = groupRunTimeline(events);

		expect(timeline).toMatchObject([
			{
				kind: 'output',
				sequence: 1,
				lastSequence: 2,
				text: 'Hello',
				deltas: 2,
			},
			{ kind: 'event', sequence: 3, type: 'tool.started' },
			{ kind: 'output', sequence: 4, lastSequence: 4, text: 'World' },
			{ kind: 'output', sequence: 5, lastSequence: 5, text: '!' },
		]);
		expect(timelineSequence(timeline)).toBe(5);
		expect(events).toEqual(original);
	});
});
