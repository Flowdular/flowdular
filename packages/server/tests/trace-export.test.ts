import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createErrorSink,
	createLogger,
	createOtlpSpanExporter,
	createTracer,
	errorSinkConfigFromEnvironment,
	ERROR_SINK_LIMITS,
	NO_ERRORS,
	traceConfigFromEnvironment,
	TRACE_LIMITS,
	type ErrorReport,
	type Tracer,
} from '../src/index.ts';

const URL_HTTPS = 'https://collector.example/v1/traces';
const URL_HTTP = 'http://collector.example/v1/traces';
const WEBHOOK = 'https://hooks.example/errors';

/** The instant every tracer in this file reads. No case depends on wall time. */
let clock = 1_700_000_000_000;
const now = (): number => clock;

interface Call {
	readonly url: string;
	readonly body: unknown;
	readonly headers: Record<string, string>;
}

/** A fetch that records every call and answers whatever the case queued. */
function fakeFetch(answers: (() => Response | Promise<Response>)[]) {
	const calls: Call[] = [];
	const send = vi.fn(async (url: unknown, init: unknown) => {
		const request = init as { body: string; headers: Record<string, string> };
		calls.push({
			url: String(url),
			body: JSON.parse(request.body) as unknown,
			headers: request.headers,
		});
		const answer =
			answers.shift() ?? (() => new Response(null, { status: 200 }));
		return answer();
	});
	return { calls, send: send as unknown as typeof fetch };
}

function fill(tracer: Tracer, count: number, name = 'span'): void {
	for (let index = 0; index < count; index += 1) {
		const span = tracer.startSpan(name, { parent: null, kind: 'server' });
		span.setAttribute('index', index);
		span.end('ok');
	}
}

beforeEach(() => {
	clock = 1_700_000_000_000;
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('trace configuration', () => {
	it('defaults to no exporter and full sampling', () => {
		expect(traceConfigFromEnvironment({})).toEqual({
			exporter: 'none',
			url: null,
			headers: {},
			sampleRatio: 1,
		});
	});

	it('reads the endpoint, the headers and the ratio', () => {
		expect(
			traceConfigFromEnvironment({
				FD_TRACE_EXPORTER: 'otlp',
				FD_TRACE_OTLP_URL: URL_HTTPS,
				FD_TRACE_OTLP_HEADERS: 'x-api-key=abc, x-tenant=acme',
				FD_TRACE_SAMPLE: '0.25',
			}),
		).toEqual({
			exporter: 'otlp',
			url: URL_HTTPS,
			headers: { 'x-api-key': 'abc', 'x-tenant': 'acme' },
			sampleRatio: 0.25,
		});
	});

	it.each([
		[
			'an unknown exporter',
			{ FD_TRACE_EXPORTER: 'jaeger' },
			/FD_TRACE_EXPORTER/,
		],
		['a missing url', { FD_TRACE_EXPORTER: 'otlp' }, /FD_TRACE_OTLP_URL/],
		[
			'a relative url',
			{ FD_TRACE_EXPORTER: 'otlp', FD_TRACE_OTLP_URL: '/v1/traces' },
			/absolute URL/,
		],
		['a ratio above one', { FD_TRACE_SAMPLE: '1.5' }, /FD_TRACE_SAMPLE/],
		[
			'a ratio that is not a number',
			{ FD_TRACE_SAMPLE: 'half' },
			/FD_TRACE_SAMPLE/,
		],
	])('refuses %s at boot', (_label, environment, message) => {
		expect(() => traceConfigFromEnvironment(environment)).toThrow(message);
	});

	it('refuses a plain http collector in production and allows it elsewhere', () => {
		const production = {
			NODE_ENV: 'production',
			FD_TRACE_EXPORTER: 'otlp',
			FD_TRACE_OTLP_URL: URL_HTTP,
		};
		expect(() => traceConfigFromEnvironment(production)).toThrow(/https/);
		expect(
			traceConfigFromEnvironment({
				FD_TRACE_EXPORTER: 'otlp',
				FD_TRACE_OTLP_URL: URL_HTTP,
			}).url,
		).toBe(URL_HTTP);
	});

	it.each([
		['a value with no name', 'novalue'],
		['a header name with a space', 'bad name=value'],
		['a control character in a value', `key=one${String.fromCharCode(13)}two`],
		[
			'more headers than the bound',
			Array.from({ length: 17 }, (_, index) => `h${index}=v`).join(','),
		],
	])('refuses %s in a header list', (_label, raw) => {
		expect(() =>
			traceConfigFromEnvironment({
				FD_TRACE_EXPORTER: 'otlp',
				FD_TRACE_OTLP_URL: URL_HTTPS,
				FD_TRACE_OTLP_HEADERS: raw,
			}),
		).toThrow(/FD_TRACE_OTLP_HEADERS/);
	});
});

describe('otlp exporter', () => {
	it('sends a batch as soon as the buffer holds one, without a timer tick', async () => {
		const tracer = createTracer({ now });
		const { calls, send } = fakeFetch([]);
		const exporter = createOtlpSpanExporter({
			url: URL_HTTPS,
			headers: { 'x-api-key': 'abc' },
			tracer,
			environment: {},
			fetch: send,
			serviceVersion: '1.2.3',
		});

		fill(tracer, TRACE_LIMITS.batchSpans);
		await exporter.flush();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(URL_HTTPS);
		expect(calls[0]?.headers).toMatchObject({
			'x-api-key': 'abc',
			'content-type': 'application/json',
		});
		expect(exporter.stats()).toMatchObject({
			exported: TRACE_LIMITS.batchSpans,
			dropped: 0,
			failures: 0,
		});
		await exporter.dispose();
	});

	it('carries the OTLP shape a collector expects', async () => {
		const tracer = createTracer({ now });
		const { calls, send } = fakeFetch([]);
		const exporter = createOtlpSpanExporter({
			url: URL_HTTPS,
			tracer,
			environment: {},
			fetch: send,
			serviceVersion: '1.2.3',
		});
		const span = tracer.startSpan('endpoint', { parent: null, kind: 'server' });
		span.setAttribute('flowdular.endpoint', 'system.health');
		clock += 12;
		span.end('error', 'boom');
		await exporter.flush();

		const payload = calls[0]?.body as {
			resourceSpans: [
				{
					resource: { attributes: unknown[] };
					scopeSpans: [{ spans: Record<string, unknown>[] }];
				},
			];
		};
		const [exported] = payload.resourceSpans[0].scopeSpans[0].spans;

		expect(payload.resourceSpans[0].resource.attributes).toContainEqual({
			key: 'service.version',
			value: { stringValue: '1.2.3' },
		});
		expect(exported).toMatchObject({
			name: 'endpoint',
			kind: 2,
			traceId: span.context.traceId,
			spanId: span.context.spanId,
			startTimeUnixNano: '1700000000000000000',
			endTimeUnixNano: '1700000000012000000',
			status: { code: 2, message: 'boom' },
		});
		expect(exported?.attributes).toContainEqual({
			key: 'flowdular.endpoint',
			value: { stringValue: 'system.health' },
		});
		await exporter.dispose();
	});

	it('never sends on the stack that recorded the span', async () => {
		const tracer = createTracer({ now });
		const { calls, send } = fakeFetch([]);
		const exporter = createOtlpSpanExporter({
			url: URL_HTTPS,
			tracer,
			environment: {},
			fetch: send,
		});

		fill(tracer, TRACE_LIMITS.batchSpans);
		/* The span that filled the batch ended on a request's stack; nothing has
		   been dialled yet. */
		expect(calls).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(0);

		expect(calls).toHaveLength(1);
		expect(exporter.stats().exported).toBe(TRACE_LIMITS.batchSpans);
		await exporter.dispose();
	});

	it('drains the buffer on dispose so a stopping process still exports', async () => {
		const tracer = createTracer({ now });
		const { calls, send } = fakeFetch([]);
		const exporter = createOtlpSpanExporter({
			url: URL_HTTPS,
			tracer,
			environment: {},
			fetch: send,
		});

		fill(tracer, 3);
		await exporter.dispose();

		expect(calls).toHaveLength(1);
		expect(exporter.stats().exported).toBe(3);
	});

	it('ends the drain instead of holding a shutdown open', async () => {
		const tracer = createTracer({ now });
		const { calls, send } = fakeFetch(
			Array.from(
				{ length: 8 },
				() => () => Promise.reject(new Error('connection refused')),
			),
		);
		const exporter = createOtlpSpanExporter({
			url: URL_HTTPS,
			tracer,
			environment: {},
			fetch: send,
			batchSpans: 2,
		});

		fill(tracer, 4);
		await expect(exporter.dispose()).resolves.toBeUndefined();

		/* Two batches attempted once each: a retry past disposal would keep a
		   collector that is down between the process and its exit. */
		expect(calls).toHaveLength(2);
		expect(exporter.stats()).toMatchObject({ exported: 0, dropped: 4 });
	});

	it('sends on the flush cadence when the batch never fills', async () => {
		const tracer = createTracer({ now });
		const { calls, send } = fakeFetch([]);
		const exporter = createOtlpSpanExporter({
			url: URL_HTTPS,
			tracer,
			environment: {},
			fetch: send,
		});

		fill(tracer, 3);
		expect(calls).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(TRACE_LIMITS.flushEveryMs);

		expect(calls).toHaveLength(1);
		expect(exporter.stats().exported).toBe(3);
		await exporter.dispose();
	});

	it('isolates a failing collector from the process and retries the batch', async () => {
		const tracer = createTracer({ now });
		const { calls, send } = fakeFetch([
			() => Promise.reject(new Error('connection refused')),
			() => new Response(null, { status: 503 }),
			() => new Response(null, { status: 200 }),
		]);
		const exporter = createOtlpSpanExporter({
			url: URL_HTTPS,
			tracer,
			environment: {},
			fetch: send,
		});

		fill(tracer, 2);
		await expect(exporter.flush()).resolves.toBeUndefined();
		expect(exporter.stats()).toMatchObject({ failures: 1, retries: 1 });

		await exporter.flush();
		expect(exporter.stats()).toMatchObject({ failures: 2, retries: 2 });

		await exporter.flush();
		expect(calls).toHaveLength(3);
		expect(exporter.stats()).toMatchObject({ exported: 2, dropped: 0 });
		await exporter.dispose();
	});

	it('gives a batch up after the retry bound instead of holding it', async () => {
		const tracer = createTracer({ now });
		const { calls, send } = fakeFetch([
			() => new Response(null, { status: 500 }),
			() => new Response(null, { status: 500 }),
			() => new Response(null, { status: 500 }),
		]);
		const exporter = createOtlpSpanExporter({
			url: URL_HTTPS,
			tracer,
			environment: {},
			fetch: send,
		});

		fill(tracer, 4);
		await exporter.flush();
		await exporter.flush();
		await exporter.flush();

		expect(calls).toHaveLength(3);
		expect(exporter.stats()).toMatchObject({ exported: 0, dropped: 4 });
		await exporter.dispose();
	});

	it('does not retry a rejected payload', async () => {
		const tracer = createTracer({ now });
		const { calls, send } = fakeFetch([
			() => new Response(null, { status: 400 }),
		]);
		const exporter = createOtlpSpanExporter({
			url: URL_HTTPS,
			tracer,
			environment: {},
			fetch: send,
		});

		fill(tracer, 2);
		await exporter.flush();
		await exporter.flush();

		expect(calls).toHaveLength(1);
		expect(exporter.stats()).toMatchObject({ dropped: 2, retries: 0 });
		await exporter.dispose();
	});

	it('sends nothing when nothing was recorded', async () => {
		const tracer = createTracer({ now });
		const { calls, send } = fakeFetch([]);
		const exporter = createOtlpSpanExporter({
			url: URL_HTTPS,
			tracer,
			environment: {},
			fetch: send,
		});

		await exporter.flush();
		await vi.advanceTimersByTimeAsync(TRACE_LIMITS.flushEveryMs * 3);

		expect(calls).toHaveLength(0);
		await exporter.dispose();
	});

	it('stops its timer on dispose', async () => {
		const tracer = createTracer({ now });
		const { calls, send } = fakeFetch([]);
		const exporter = createOtlpSpanExporter({
			url: URL_HTTPS,
			tracer,
			environment: {},
			fetch: send,
		});

		await exporter.dispose();
		fill(tracer, 2);
		await vi.advanceTimersByTimeAsync(TRACE_LIMITS.flushEveryMs * 2);

		expect(calls).toHaveLength(0);
	});

	it('refuses a plain http collector in production', () => {
		expect(() =>
			createOtlpSpanExporter({
				url: URL_HTTP,
				environment: { NODE_ENV: 'production' },
				fetch: fakeFetch([]).send,
			}),
		).toThrow(/https/);
	});
});

describe('error sink', () => {
	const report = (overrides: Partial<ErrorReport> = {}): ErrorReport => ({
		at: clock,
		name: 'Error',
		message: 'endpoint failed',
		...overrides,
	});

	it('defaults to none, which holds nothing', () => {
		expect(errorSinkConfigFromEnvironment({})).toEqual({
			kind: 'none',
			url: null,
			token: null,
		});
		NO_ERRORS.report(report());
		expect(NO_ERRORS.stats()).toEqual({
			queued: 0,
			delivered: 0,
			dropped: 0,
			failures: 0,
		});
	});

	it.each([
		['an unknown sink', { FD_ERROR_SINK: 'syslog' }, /FD_ERROR_SINK/],
		[
			'the unbuilt otlp-logs sink',
			{ FD_ERROR_SINK: 'otlp-logs' },
			/FD_ERROR_SINK/,
		],
		[
			'a webhook with no url',
			{ FD_ERROR_SINK: 'webhook' },
			/FD_ERROR_SINK_URL/,
		],
	])('refuses %s at boot', (_label, environment, message) => {
		expect(() => errorSinkConfigFromEnvironment(environment)).toThrow(message);
	});

	it('refuses a plain http webhook in production and allows it elsewhere', () => {
		expect(() =>
			errorSinkConfigFromEnvironment({
				NODE_ENV: 'production',
				FD_ERROR_SINK: 'webhook',
				FD_ERROR_SINK_URL: 'http://hooks.example/errors',
			}),
		).toThrow(/https/);
		expect(
			errorSinkConfigFromEnvironment({
				FD_ERROR_SINK: 'webhook',
				FD_ERROR_SINK_URL: 'http://hooks.example/errors',
				FD_ERROR_SINK_TOKEN: 'secret',
			}),
		).toEqual({
			kind: 'webhook',
			url: 'http://hooks.example/errors',
			token: 'secret',
		});
	});

	it('posts a bounded batch with the bearer credential', async () => {
		const { calls, send } = fakeFetch([]);
		const sink = createErrorSink(
			{ kind: 'webhook', url: WEBHOOK, token: 'shhh' },
			{ environment: {}, fetch: send },
		);

		sink.report(report({ requestId: 'req-1', traceId: 'trace-1' }));
		await sink.flush();

		expect(calls[0]?.headers.authorization).toBe('Bearer shhh');
		expect(calls[0]?.body).toEqual({
			reports: [
				{
					at: clock,
					name: 'Error',
					message: 'endpoint failed',
					requestId: 'req-1',
					traceId: 'trace-1',
				},
			],
		});
		await sink.dispose();
	});

	it('bounds a message and keeps the body under its byte ceiling', async () => {
		const { calls, send } = fakeFetch([]);
		const sink = createErrorSink(
			{ kind: 'webhook', url: WEBHOOK, token: null },
			{ environment: {}, fetch: send },
		);

		for (let index = 0; index < ERROR_SINK_LIMITS.batch; index += 1) {
			sink.report(report({ message: 'x'.repeat(2_000) }));
		}
		await sink.flush();

		const body = calls[0]?.body as { reports: ErrorReport[] };
		expect(body.reports.length).toBeLessThan(ERROR_SINK_LIMITS.batch);
		for (const sent of body.reports) {
			expect(sent.message).toHaveLength(ERROR_SINK_LIMITS.messageChars);
		}
		expect(
			Buffer.byteLength(JSON.stringify(calls[0]?.body)),
		).toBeLessThanOrEqual(ERROR_SINK_LIMITS.bodyBytes);
		await sink.dispose();
	});

	it('refuses a report past the queue bound while a send is in flight', async () => {
		const { send } = fakeFetch([() => new Promise<Response>(() => undefined)]);
		const sink = createErrorSink(
			{ kind: 'webhook', url: WEBHOOK, token: null },
			{ environment: {}, fetch: send },
		);

		/* The first full batch leaves and never settles, so everything after it
		   piles up against the queue bound rather than against the batch. */
		for (let index = 0; index < ERROR_SINK_LIMITS.batch; index += 1) {
			sink.report(report());
		}
		await Promise.resolve();
		for (let index = 0; index < ERROR_SINK_LIMITS.queue + 5; index += 1) {
			sink.report(report());
		}

		expect(sink.stats()).toMatchObject({
			queued: ERROR_SINK_LIMITS.queue,
			dropped: 5,
			delivered: 0,
		});
	});

	it('keeps an unreachable webhook off the caller path', async () => {
		const { send } = fakeFetch([() => Promise.reject(new Error('down'))]);
		const sink = createErrorSink(
			{ kind: 'webhook', url: WEBHOOK, token: null },
			{ environment: {}, fetch: send },
		);

		sink.report(report());
		await expect(sink.flush()).resolves.toBeUndefined();

		expect(sink.stats()).toMatchObject({ failures: 1, queued: 1 });
		await sink.dispose();
	});

	it('reports every error line and nothing else', () => {
		const reported: ErrorReport[] = [];
		const logger = createLogger({
			format: 'json',
			level: 'debug',
			write: () => undefined,
			errorSink: {
				kind: 'webhook',
				report: (entry) => reported.push(entry),
				flush: () => Promise.resolve(),
				stats: () => ({ queued: 0, delivered: 0, dropped: 0, failures: 0 }),
				dispose: () => Promise.resolve(),
			},
		});

		logger.info('served');
		logger.warn('slow');
		logger.error('endpoint failed', {
			requestId: 'req-2',
			endpoint: 'system.health',
			err: new TypeError('bad input'),
		});

		expect(reported).toHaveLength(1);
		expect(reported[0]).toMatchObject({
			name: 'TypeError',
			message: 'bad input',
			endpoint: 'system.health',
			requestId: 'req-2',
		});
	});

	it('keeps a throwing sink from failing the line that reports a failure', () => {
		const lines: string[] = [];
		const logger = createLogger({
			format: 'json',
			write: (_level, line) => lines.push(line),
			errorSink: {
				kind: 'webhook',
				report: () => {
					throw new Error('sink defect');
				},
				flush: () => Promise.resolve(),
				stats: () => ({ queued: 0, delivered: 0, dropped: 0, failures: 0 }),
				dispose: () => Promise.resolve(),
			},
		});

		expect(() => logger.error('endpoint failed')).not.toThrow();
		expect(lines).toHaveLength(1);
	});
});
