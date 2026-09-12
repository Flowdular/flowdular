import type { JobEvent } from '../jobs/runner.ts';
import { runWithTrace } from './context.ts';
import { serverTracer, type Span, type Tracer } from './tracer.ts';

export interface JobTraceSinkOptions {
	/** Defaults to the process tracer. */
	readonly tracer?: Tracer;
}

/* One open pass span per loop name. A runner never overlaps its own pass, so
   the map holds at most one entry per composed loop; the cap is there because
   the name is the caller's string, not this module's. */
const MAX_OPEN_PASSES = 64;

function itemSpan(
	tracer: Tracer,
	event: JobEvent,
	parent: Span | undefined,
	name: string,
	startedAt: number,
	status: 'ok' | 'error',
	reason?: string,
): void {
	const span = tracer.startSpan(name, {
		...(parent ? { parent: parent.context } : { parent: null }),
		kind: 'internal',
		startedAt,
		attributes: {
			'flowdular.job': event.name,
			...(reason ? { 'flowdular.job.reason': reason } : {}),
		},
	});
	span.end(status, reason, event.at);
}

/**
 * Runs one claimed item in the trace that enqueued it. The module stored
 * `currentTraceParent()` on the row and hands that value back here: the span
 * this opens belongs to the enqueuing request's trace, and it is ambient for
 * everything `work` awaits, so the spans and the log lines of the background
 * stage carry the same trace id as the request that asked for the work. A row
 * without a usable value is a new root, never an error.
 *
 * The pass spans of `createJobTraceSink` are the loop's own and stay roots;
 * this is the one span a job item shares with its enqueuer.
 */
export async function resumeJobTrace<T>(
	tracer: Tracer,
	traceparent: string | null | undefined,
	name: string,
	work: () => T | Promise<T>,
): Promise<T> {
	const span = tracer.startSpan(name, {
		traceparent: traceparent ?? null,
		kind: 'consumer',
	});
	try {
		const result = await runWithTrace(span.context, work);
		span.end('ok');
		return result;
	} catch (error) {
		span.end('error', error instanceof Error ? error.name : 'JOB_FAILED');
		throw error;
	}
}

/**
 * Turns a job runner's events into spans: one per pass, and one child per item
 * the pass performed, failed on or lost the claim for. It is a consumer of the
 * runner's existing `onEvent` seam and changes nothing about the runner.
 *
 * A performed item's span carries the exact interval, because the runner
 * reports its duration. A failed or lost item has no duration in the event, so
 * its span is recorded at the instant the runner reported it; the pass span is
 * what bounds when the work actually ran. Making those exact would mean
 * carrying an item identity through `JobEvent`, which is a runner contract
 * change and deliberately not made here.
 *
 * The trace a job item belongs to is the module's to resume, with
 * `resumeJobTrace` inside `perform`. These pass spans are roots, because a
 * pass belongs to the loop, not to any one enqueuer.
 */
export function createJobTraceSink(
	options: JobTraceSinkOptions = {},
): (event: JobEvent) => void {
	const tracer = options.tracer ?? serverTracer();
	const passes = new Map<string, Span>();

	return (event: JobEvent): void => {
		switch (event.type) {
			case 'pass-start': {
				/* A name whose previous pass never ended is closed here rather than
				   leaked: the runner guarantees one pass at a time per loop. */
				passes.get(event.name)?.end('error', 'PASS_NOT_ENDED', event.at);
				if (!passes.has(event.name) && passes.size >= MAX_OPEN_PASSES) return;
				passes.set(
					event.name,
					tracer.startSpan(`job ${event.name}`, {
						parent: null,
						kind: 'consumer',
						startedAt: event.at,
						attributes: { 'flowdular.job': event.name },
					}),
				);
				return;
			}
			case 'pass-end': {
				const span = passes.get(event.name);
				if (!span) return;
				passes.delete(event.name);
				span.setAttribute('flowdular.job.claimed', event.report.claimed);
				span.setAttribute('flowdular.job.performed', event.report.performed);
				span.setAttribute('flowdular.job.failed', event.report.failed);
				span.setAttribute('flowdular.job.claim_lost', event.report.claimLost);
				span.setAttribute('flowdular.job.next_delay_ms', event.nextDelayMs);
				span.end(event.report.failed > 0 ? 'error' : 'ok', undefined, event.at);
				return;
			}
			case 'performed': {
				itemSpan(
					tracer,
					event,
					passes.get(event.name),
					`job ${event.name} item`,
					event.at - event.durationMs,
					'ok',
				);
				return;
			}
			case 'item-failed': {
				itemSpan(
					tracer,
					event,
					passes.get(event.name),
					`job ${event.name} item`,
					event.at,
					'error',
					'ITEM_FAILED',
				);
				return;
			}
			case 'claim-lost': {
				itemSpan(
					tracer,
					event,
					passes.get(event.name),
					`job ${event.name} item`,
					event.at,
					'error',
					'CLAIM_LOST',
				);
				return;
			}
			case 'claim-failed': {
				itemSpan(
					tracer,
					event,
					passes.get(event.name),
					`job ${event.name} claim`,
					event.at,
					'error',
					'CLAIM_FAILED',
				);
				return;
			}
			default:
				/* `claimed`, `heartbeat` and `heartbeat-failed` are cadence, not work:
				   recording a span each would multiply the buffer by the beat rate. */
				return;
		}
	};
}
