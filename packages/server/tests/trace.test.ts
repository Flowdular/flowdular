import { createContext } from '@octanejs/app-core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	createJobTraceSink,
	createLogger,
	createTracer,
	currentTrace,
	defineEndpoint,
	formatTraceParent,
	parseTraceParent,
	resumeJobTrace,
	runWithTrace,
	serverTracer,
	TRACE_LIMITS,
	type JobEvent,
	type RecordedSpan,
	type TraceContext,
} from '../src/index.ts';

const PARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';

/** The instant every tracer in this file reads. No case depends on wall time. */
let clock = 1_700_000_000_000;
let nextId = 0;

const now = (): number => clock;
const nextHex = (width: number): string => {
	nextId += 1;
	return nextId.toString(16).padStart(width, '0');
};

function tracerAt(options: Parameters<typeof createTracer>[0] = {}) {
	return createTracer({
		now,
		newTraceId: () => nextHex(32),
		newSpanId: () => nextHex(16),
		...options,
	});
}

async function call(
	endpoint: ReturnType<typeof defineEndpoint>,
	headers: Record<string, string> = {},
): Promise<Response> {
	return endpoint.serverRoute.handler(
		createContext(new Request('http://localhost/api/traced', { headers }), {}),
	);
}

beforeEach(() => {
	clock = 1_700_000_000_000;
	nextId = 0;
});

describe('traceparent', () => {
	it('reads the trace, the parent span and the sampled flag', () => {
		expect(parseTraceParent(PARENT)).toEqual({
			traceId: TRACE_ID,
			spanId: SPAN_ID,
			sampled: true,
		});
		expect(parseTraceParent(`00-${TRACE_ID}-${SPAN_ID}-00`)?.sampled).toBe(
			false,
		);
		/* Any flag bit but the low one is somebody else's concern, and the low one
		   still has to be read out of it. */
		expect(parseTraceParent(`00-${TRACE_ID}-${SPAN_ID}-ff`)?.sampled).toBe(
			true,
		);
		expect(parseTraceParent(`00-${TRACE_ID}-${SPAN_ID}-fe`)?.sampled).toBe(
			false,
		);
	});

	it.each([
		['nothing', undefined],
		['null', null],
		['empty', ''],
		['a short value', '00-abc-def-01'],
		['the reserved version', `ff-${TRACE_ID}-${SPAN_ID}-01`],
		['a zero trace id', `00-${'0'.repeat(32)}-${SPAN_ID}-01`],
		['a zero span id', `00-${TRACE_ID}-${'0'.repeat(16)}-01`],
		['upper case hex', `00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`],
		['a bad flag', `00-${TRACE_ID}-${SPAN_ID}-0z`],
		['extra fields on version 00', `00-${TRACE_ID}-${SPAN_ID}-01-extra`],
		[
			'a value over the header bound',
			`00-${TRACE_ID}-${SPAN_ID}-01-${'x'.repeat(300)}`,
		],
	])('refuses %s', (_label, value) => {
		expect(parseTraceParent(value)).toBeNull();
	});

	it('reads a later version by its first four fields', () => {
		expect(parseTraceParent(`01-${TRACE_ID}-${SPAN_ID}-01-cc`)).toEqual({
			traceId: TRACE_ID,
			spanId: SPAN_ID,
			sampled: true,
		});
	});

	it('writes version 00 whatever it parsed', () => {
		const context = parseTraceParent(`01-${TRACE_ID}-${SPAN_ID}-01-cc`)!;
		expect(formatTraceParent(context)).toBe(PARENT);
		expect(parseTraceParent(formatTraceParent(context))).toEqual(context);
	});

	it('generates a root that parses back', () => {
		const tracer = createTracer();
		const span = tracer.startSpan('root', { parent: null });

		expect(span.context.traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(span.context.spanId).toMatch(/^[0-9a-f]{16}$/);
		expect(parseTraceParent(formatTraceParent(span.context))).toEqual(
			span.context,
		);
	});
});

describe('tracer', () => {
	it('continues the caller trace and starts a span of its own', () => {
		const tracer = tracerAt();
		const span = tracer.startSpan('endpoint', { traceparent: PARENT });
		span.end('ok');
		const [recorded] = tracer.drain();

		expect(span.context.traceId).toBe(TRACE_ID);
		expect(span.context.spanId).not.toBe(SPAN_ID);
		expect(recorded?.parentSpanId).toBe(SPAN_ID);
	});

	it('nests under the ambient trace when no parent is named', () => {
		const tracer = tracerAt();
		const outer = tracer.startSpan('outer', { parent: null });
		const inner = runWithTrace(outer.context, () => tracer.startSpan('inner'));
		inner.end('ok');

		expect(inner.context.traceId).toBe(outer.context.traceId);
		expect(tracer.drain()[0]?.parentSpanId).toBe(outer.context.spanId);
	});

	it('starts a root when a header is absent or malformed', () => {
		const tracer = tracerAt();
		const fromNull = tracer.startSpan('a', { traceparent: null });
		const fromGarbage = tracer.startSpan('b', { traceparent: 'not-a-header' });

		expect(fromNull.context.traceId).not.toBe(fromGarbage.context.traceId);
		fromNull.end('ok');
		expect(tracer.drain()[0]?.parentSpanId).toBeNull();
	});

	it('records the interval, the status and the message', () => {
		const tracer = tracerAt();
		const span = tracer.startSpan('work', { parent: null, kind: 'server' });
		clock += 25;
		span.end('error', 'boom');
		const [recorded] = tracer.drain() as [RecordedSpan];

		expect(recorded).toMatchObject({
			name: 'work',
			kind: 'server',
			startedAt: 1_700_000_000_000,
			endedAt: 1_700_000_000_025,
			status: 'error',
			statusMessage: 'boom',
		});
	});

	it('ends once, so a finally may always call it', () => {
		const tracer = tracerAt();
		const span = tracer.startSpan('work', { parent: null });
		span.end('ok');
		clock += 100;
		span.end('error');

		const drained = tracer.drain();
		expect(drained).toHaveLength(1);
		expect(drained[0]?.status).toBe('ok');
		expect(drained[0]?.endedAt).toBe(1_700_000_000_000);
	});

	it('keeps at most the attribute ceiling and bounds every value', () => {
		const tracer = tracerAt();
		const span = tracer.startSpan('work', { parent: null });
		for (let index = 0; index < TRACE_LIMITS.attributes + 8; index += 1) {
			span.setAttribute(`key${index}`, index);
		}
		span.setAttribute('key0', 'x'.repeat(TRACE_LIMITS.attributeChars + 50));
		span.setAttribute('key0', `line${String.fromCharCode(10)}two`);
		span.setAttribute('nan', Number.NaN);
		span.end('ok');
		const [recorded] = tracer.drain() as [RecordedSpan];

		expect(Object.keys(recorded.attributes)).toHaveLength(
			TRACE_LIMITS.attributes,
		);
		expect(recorded.attributes.key0).toBe('line two');
		expect(recorded.attributes.nan).toBeUndefined();
	});

	it('bounds an attribute value at the character ceiling', () => {
		const tracer = tracerAt();
		const span = tracer.startSpan('work', { parent: null });
		span.setAttribute('long', 'x'.repeat(TRACE_LIMITS.attributeChars + 50));
		span.end('ok');

		expect(tracer.drain()[0]?.attributes.long).toHaveLength(
			TRACE_LIMITS.attributeChars,
		);
	});

	it('drops the oldest span and counts the drop at the buffer bound', () => {
		const tracer = tracerAt({ bufferSpans: 3 });
		for (const name of ['a', 'b', 'c', 'd', 'e']) {
			tracer.startSpan(name, { parent: null }).end('ok');
		}

		expect(tracer.stats()).toEqual({ buffered: 3, dropped: 2, recorded: 5 });
		expect(tracer.drain().map((span) => span.name)).toEqual(['c', 'd', 'e']);
		expect(tracer.stats().buffered).toBe(0);
	});

	it('holds the documented default of 4096 spans', () => {
		const tracer = tracerAt();
		for (let index = 0; index < TRACE_LIMITS.bufferSpans + 4; index += 1) {
			tracer.startSpan('span', { parent: null }).end('ok');
		}

		expect(TRACE_LIMITS.bufferSpans).toBe(4_096);
		expect(tracer.stats()).toMatchObject({
			buffered: TRACE_LIMITS.bufferSpans,
			dropped: 4,
		});
	});

	it('drains at most the batch it was asked for, oldest first', () => {
		const tracer = tracerAt();
		for (const name of ['a', 'b', 'c']) {
			tracer.startSpan(name, { parent: null }).end('ok');
		}

		expect(tracer.drain(2).map((span) => span.name)).toEqual(['a', 'b']);
		expect(tracer.drain().map((span) => span.name)).toEqual(['c']);
	});

	it('tells one listener the buffered count, and survives a throwing one', () => {
		const tracer = tracerAt();
		const seen: number[] = [];
		const detach = tracer.onSpanRecorded((buffered) => {
			seen.push(buffered);
			throw new Error('observer defect');
		});
		tracer.startSpan('a', { parent: null }).end('ok');
		detach();
		tracer.startSpan('b', { parent: null }).end('ok');

		expect(seen).toEqual([1]);
		expect(tracer.stats().recorded).toBe(2);
	});
});

describe('sampler', () => {
	const lowTraceId = `${'0'.repeat(24)}00000000`;
	const highTraceId = `${'0'.repeat(24)}ffffffff`;

	it('records nothing at ratio 0 but still propagates a context', () => {
		const tracer = createTracer({ now, sampleRatio: 0 });
		const span = tracer.startSpan('work', { parent: null });
		span.setAttribute('ignored', true);
		span.end('ok');

		expect(span.context.sampled).toBe(false);
		expect(formatTraceParent(span.context)).toMatch(/-00$/);
		expect(tracer.stats()).toEqual({ buffered: 0, dropped: 0, recorded: 0 });
	});

	it('decides a root on the trace id, so a ratio is honoured', () => {
		const low = createTracer({
			now,
			sampleRatio: 0.5,
			newTraceId: () => lowTraceId,
		});
		const high = createTracer({
			now,
			sampleRatio: 0.5,
			newTraceId: () => highTraceId,
		});

		expect(low.startSpan('a', { parent: null }).context.sampled).toBe(true);
		expect(high.startSpan('a', { parent: null }).context.sampled).toBe(false);
	});

	it('never re-decides a trace the caller already sampled', () => {
		const tracer = createTracer({ now, sampleRatio: 0 });
		const span = tracer.startSpan('work', { traceparent: PARENT });
		span.end('ok');

		expect(span.context.sampled).toBe(true);
		expect(tracer.stats().recorded).toBe(1);
	});

	it('falls back to recording everything on an unusable ratio', () => {
		expect(createTracer({ sampleRatio: 2 }).sampleRatio).toBe(1);
		expect(createTracer({ sampleRatio: Number.NaN }).sampleRatio).toBe(1);
		expect(createTracer({ sampleRatio: -1 }).sampleRatio).toBe(1);
	});
});

describe('endpoint trace context', () => {
	const publicEndpoint = defineEndpoint({
		id: 'trace.public',
		path: '/api/traced',
		methods: ['GET'],
		access: { kind: 'public' },
		handler: ({ trace }) =>
			Response.json({ traceId: trace.traceId, spanId: trace.spanId }),
	});

	it('continues the caller trace and answers with its own span', async () => {
		serverTracer().drain();
		const response = await call(publicEndpoint, { traceparent: PARENT });
		const body = (await response.json()) as TraceContext;
		const returned = parseTraceParent(response.headers.get('traceparent'))!;

		expect(returned.traceId).toBe(TRACE_ID);
		expect(returned.spanId).not.toBe(SPAN_ID);
		expect(body.traceId).toBe(TRACE_ID);
		expect(body.spanId).toBe(returned.spanId);
	});

	it('generates a trace when the caller sent none', async () => {
		serverTracer().drain();
		const first = await call(publicEndpoint);
		const second = await call(publicEndpoint);
		const one = parseTraceParent(first.headers.get('traceparent'))!;
		const two = parseTraceParent(second.headers.get('traceparent'))!;

		expect(one.traceId).not.toBe(two.traceId);
		expect(one.sampled).toBe(true);
	});

	it('records the endpoint span with its status and its parent', async () => {
		serverTracer().drain();
		await call(publicEndpoint, {
			traceparent: PARENT,
			'x-request-id': 'req-7',
		});
		const [span] = serverTracer().drain() as [RecordedSpan];

		expect(span).toMatchObject({
			name: 'trace.public',
			kind: 'server',
			traceId: TRACE_ID,
			parentSpanId: SPAN_ID,
			status: 'ok',
		});
		expect(span.attributes).toMatchObject({
			'flowdular.endpoint': 'trace.public',
			'flowdular.request_id': 'req-7',
			'http.request.method': 'GET',
			'http.response.status_code': 200,
		});
	});

	it('answers a denial with the trace header too', async () => {
		const denied = defineEndpoint({
			id: 'trace.denied',
			path: '/api/traced',
			methods: ['GET'],
			access: { kind: 'permission', permission: 'trace.read' },
			resolveIdentity: () => null,
			handler: () => Response.json({ unreachable: true }),
		});
		serverTracer().drain();
		const response = await call(denied, { traceparent: PARENT });

		expect(response.status).toBe(401);
		expect(parseTraceParent(response.headers.get('traceparent'))?.traceId).toBe(
			TRACE_ID,
		);
	});

	it('marks a failed request and still answers with the header', async () => {
		const failing = defineEndpoint({
			id: 'trace.failing',
			path: '/api/traced',
			methods: ['GET'],
			access: { kind: 'public' },
			handler: () => {
				throw new Error('handler defect');
			},
		});
		serverTracer().drain();
		const response = await call(failing);
		const [span] = serverTracer().drain() as [RecordedSpan];

		expect(response.status).toBe(500);
		expect(response.headers.get('traceparent')).toBeTruthy();
		expect(span.status).toBe('error');
	});

	it('makes the trace ambient for everything the handler awaits', async () => {
		let seen: string | undefined;
		const endpoint = defineEndpoint({
			id: 'trace.ambient',
			path: '/api/traced',
			methods: ['GET'],
			access: { kind: 'public' },
			handler: async () => {
				await Promise.resolve();
				const lines: string[] = [];
				createLogger({
					format: 'json',
					write: (_level, line) => lines.push(line),
				}).info('inside the handler');
				seen = lines[0];
				return Response.json({ ok: true });
			},
		});

		await call(endpoint, { traceparent: PARENT });

		expect(JSON.parse(seen!)).toMatchObject({ traceId: TRACE_ID });
	});
});

describe('logger trace correlation', () => {
	it('adds no trace fields outside a traced scope', () => {
		const lines: string[] = [];
		createLogger({
			format: 'json',
			write: (_level, line) => lines.push(line),
		}).info('outside');

		expect(JSON.parse(lines[0]!)).not.toHaveProperty('traceId');
	});

	it('attaches the trace and the span to every line inside one', () => {
		const lines: string[] = [];
		const logger = createLogger({
			format: 'json',
			level: 'debug',
			write: (_level, line) => lines.push(line),
		});
		const context: TraceContext = {
			traceId: TRACE_ID,
			spanId: SPAN_ID,
			sampled: true,
		};

		runWithTrace(context, () => {
			logger.debug('a');
			logger.warn('b');
			logger.error('c', { err: new Error('boom') });
		});

		for (const line of lines) {
			expect(JSON.parse(line)).toMatchObject({
				traceId: TRACE_ID,
				spanId: SPAN_ID,
			});
		}
		expect(lines).toHaveLength(3);
	});
});

describe('job trace sink', () => {
	const passStart: JobEvent = {
		type: 'pass-start',
		name: 'audit.core.sweep',
		at: 1_000,
	};
	const passEnd: JobEvent = {
		type: 'pass-end',
		name: 'audit.core.sweep',
		at: 1_500,
		report: { claimed: 2, performed: 1, failed: 1, claimLost: 0 },
		nextDelayMs: 5_000,
	};

	it('opens a root span per pass and closes it with the report', () => {
		const tracer = tracerAt();
		const sink = createJobTraceSink({ tracer });
		sink(passStart);
		sink(passEnd);
		const [span] = tracer.drain() as [RecordedSpan];

		expect(span).toMatchObject({
			name: 'job audit.core.sweep',
			kind: 'consumer',
			parentSpanId: null,
			startedAt: 1_000,
			endedAt: 1_500,
			status: 'error',
		});
		expect(span.attributes).toMatchObject({
			'flowdular.job.claimed': 2,
			'flowdular.job.performed': 1,
			'flowdular.job.failed': 1,
			'flowdular.job.next_delay_ms': 5_000,
		});
	});

	it('records a performed item under the pass with its exact interval', () => {
		const tracer = tracerAt();
		const sink = createJobTraceSink({ tracer });
		sink(passStart);
		sink({
			type: 'performed',
			name: 'audit.core.sweep',
			at: 1_400,
			durationMs: 250,
		});
		sink(passEnd);
		const [item, pass] = tracer.drain() as [RecordedSpan, RecordedSpan];

		expect(item).toMatchObject({
			name: 'job audit.core.sweep item',
			startedAt: 1_150,
			endedAt: 1_400,
			status: 'ok',
		});
		expect(item.traceId).toBe(pass.traceId);
		expect(item.parentSpanId).toBe(pass.spanId);
	});

	it('records a failure, a lost claim and a failed claim as error spans', () => {
		const tracer = tracerAt();
		const sink = createJobTraceSink({ tracer });
		sink(passStart);
		sink({
			type: 'item-failed',
			name: 'audit.core.sweep',
			at: 1_100,
			error: new Error('boom'),
		});
		sink({ type: 'claim-lost', name: 'audit.core.sweep', at: 1_200 });
		sink({
			type: 'claim-failed',
			name: 'audit.core.sweep',
			at: 1_300,
			error: new Error('gone'),
		});
		const spans = tracer.drain();

		expect(
			spans.map((span) => span.attributes['flowdular.job.reason']),
		).toEqual(['ITEM_FAILED', 'CLAIM_LOST', 'CLAIM_FAILED']);
		expect(spans.every((span) => span.status === 'error')).toBe(true);
	});

	it('records nothing for cadence events', () => {
		const tracer = tracerAt();
		const sink = createJobTraceSink({ tracer });
		sink(passStart);
		sink({ type: 'claimed', name: 'audit.core.sweep', at: 1_010 });
		sink({ type: 'heartbeat', name: 'audit.core.sweep', at: 1_020 });
		sink({
			type: 'heartbeat-failed',
			name: 'audit.core.sweep',
			at: 1_030,
			error: new Error('lapsed'),
		});

		expect(tracer.stats().recorded).toBe(0);
	});

	it('closes a pass whose end never arrived instead of leaking it', () => {
		const tracer = tracerAt();
		const sink = createJobTraceSink({ tracer });
		sink(passStart);
		sink({ ...passStart, at: 2_000 });
		const [abandoned] = tracer.drain() as [RecordedSpan];

		expect(abandoned).toMatchObject({
			startedAt: 1_000,
			status: 'error',
			statusMessage: 'PASS_NOT_ENDED',
		});
	});
});

describe('resumed job trace', () => {
	it('resumes the trace the row carries and makes it ambient for the work', async () => {
		const tracer = tracerAt();
		let inside: TraceContext | undefined;

		await resumeJobTrace(tracer, PARENT, 'import.core perform', async () => {
			await Promise.resolve();
			inside = currentTrace();
		});
		const [span] = tracer.drain() as [RecordedSpan];

		expect(span).toMatchObject({
			name: 'import.core perform',
			kind: 'consumer',
			traceId: TRACE_ID,
			parentSpanId: SPAN_ID,
			status: 'ok',
		});
		/* Ambient across the await, so a span the work opens and a line it logs
		   belong to the request that enqueued the job. */
		expect(inside).toMatchObject({ traceId: TRACE_ID, spanId: span.spanId });
	});

	it('starts a root for a row that carries no usable trace', async () => {
		const tracer = tracerAt();

		await resumeJobTrace(tracer, null, 'item', () => undefined);
		await resumeJobTrace(tracer, 'not-a-header', 'item', () => undefined);
		const spans = tracer.drain();

		expect(spans.map((span) => span.parentSpanId)).toEqual([null, null]);
		expect(spans[0]?.traceId).not.toBe(spans[1]?.traceId);
	});

	it('records the failure and rethrows it to the runner', async () => {
		const tracer = tracerAt();

		await expect(
			resumeJobTrace(tracer, PARENT, 'item', () => {
				throw new TypeError('boom');
			}),
		).rejects.toThrow('boom');
		const [span] = tracer.drain() as [RecordedSpan];

		expect(span).toMatchObject({ status: 'error', statusMessage: 'TypeError' });
	});
});
