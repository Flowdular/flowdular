import type { AgentExecutionEvent } from '@flowdular/harness';

/* A streamed answer is stored as one event per token, so a run's persisted
   timeline is mostly one-word rows. Reading folds each maximal run of
   consecutive deltas from the same output stream into a single entry. The
   stored events are never touched, so the harness contract and the audit hash
   chain both stay exactly as written. */

/* The concatenation a single entry may carry. Past it the entry keeps counting
   characters without holding them, so a long answer cannot put a megabyte on
   the wire. */
export const MAX_TIMELINE_OUTPUT_CHARACTERS = 20_000;

export interface RunTimelineEvent {
	readonly kind: 'event';
	readonly sequence: number;
	readonly type: AgentExecutionEvent['type'];
	readonly timestamp: number;
	readonly message: string;
	readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

export interface RunTimelineOutput {
	readonly kind: 'output';
	/* Sequence of the first and last stored delta the entry stands for. */
	readonly sequence: number;
	readonly lastSequence: number;
	readonly startedAt: number;
	readonly endedAt: number;
	readonly deltas: number;
	/* The provider's own text block id when it sends one. Two blocks never
	   merge, so a tool call between them keeps two answers apart. */
	readonly stream: string | null;
	readonly text: string;
	/* Length of the full concatenation, so a reader can state what was left out
	   without holding it. */
	readonly characters: number;
	readonly omittedCharacters: number;
}

export type RunTimelineEntry = RunTimelineEvent | RunTimelineOutput;

export interface RunTimelineOptions {
	readonly maxCharacters?: number;
}

function streamOf(event: AgentExecutionEvent): string | null {
	const value = event.metadata?.['stream'];
	return typeof value === 'string' && value !== '' ? value : null;
}

function opened(
	event: AgentExecutionEvent,
	stream: string | null,
	limit: number,
): RunTimelineOutput {
	const text = event.message.slice(0, limit);
	return {
		kind: 'output',
		sequence: event.sequence,
		lastSequence: event.sequence,
		startedAt: event.timestamp,
		endedAt: event.timestamp,
		deltas: 1,
		stream,
		text,
		characters: event.message.length,
		omittedCharacters: event.message.length - text.length,
	};
}

function extended(
	entry: RunTimelineOutput,
	event: AgentExecutionEvent,
	limit: number,
): RunTimelineOutput {
	const room = Math.max(0, limit - entry.text.length);
	const text =
		room === 0 ? entry.text : entry.text + event.message.slice(0, room);
	const characters = entry.characters + event.message.length;
	return {
		...entry,
		lastSequence: event.sequence,
		endedAt: event.timestamp,
		deltas: entry.deltas + 1,
		text,
		characters,
		omittedCharacters: characters - text.length,
	};
}

/* Folds new events onto an existing timeline, extending its last entry when the
   span continues. One fold serves both the persisted read and the live stream,
   so the two can never group differently. */
export function appendRunTimeline(
	entries: readonly RunTimelineEntry[],
	events: readonly AgentExecutionEvent[],
	options: RunTimelineOptions = {},
): readonly RunTimelineEntry[] {
	const limit = Math.max(
		0,
		options.maxCharacters ?? MAX_TIMELINE_OUTPUT_CHARACTERS,
	);
	const next = [...entries];
	for (const event of events) {
		if (event.type !== 'provider.output.delta') {
			next.push({
				kind: 'event',
				sequence: event.sequence,
				type: event.type,
				timestamp: event.timestamp,
				message: event.message,
				metadata: event.metadata ?? {},
			});
			continue;
		}
		const stream = streamOf(event);
		const tail = next[next.length - 1];
		if (tail && tail.kind === 'output' && tail.stream === stream) {
			next[next.length - 1] = extended(tail, event, limit);
			continue;
		}
		next.push(opened(event, stream, limit));
	}
	return next;
}

export function groupRunTimeline(
	events: readonly AgentExecutionEvent[],
	options: RunTimelineOptions = {},
): readonly RunTimelineEntry[] {
	return appendRunTimeline([], events, options);
}

/* The highest stored sequence the timeline stands for, which is where a live
   observer resumes the event stream. */
export function timelineSequence(entries: readonly RunTimelineEntry[]): number {
	let highest = 0;
	for (const entry of entries) {
		const sequence =
			entry.kind === 'output' ? entry.lastSequence : entry.sequence;
		if (sequence > highest) highest = sequence;
	}
	return highest;
}
