import { describe, expect, it } from 'vitest';
import {
	createTracer,
	ERROR_SINK_LIMITS,
	type ErrorReport,
	type ErrorSink,
} from '@flowdular/server';
import { createPlatformObservability, drainErrorSink } from './tracing.ts';

/** The bounded queue of the webhook sink, without its transport. */
function fakeErrorSink(queued: number, sends = true): ErrorSink {
	const queue: ErrorReport[] = Array.from({ length: queued }, () => ({
		at: 0,
		name: 'Error',
	}));
	let delivered = 0;
	return {
		kind: 'webhook',
		report: (entry) => void queue.push(entry),
		flush: async () => {
			if (!sends) return;
			delivered += queue.splice(0, ERROR_SINK_LIMITS.batch).length;
		},
		stats: () => ({ queued: queue.length, delivered, dropped: 0, failures: 0 }),
		dispose: () => Promise.resolve(),
	};
}

const OTLP = {
	FD_TRACE_EXPORTER: 'otlp',
	FD_TRACE_OTLP_URL: 'https://collector.example/v1/traces',
} as const;

describe('platform observability', () => {
	it('composes no egress by default', async () => {
		const observability = createPlatformObservability({ environment: {} });

		expect(observability.exporter).toBeNull();
		expect(observability.errorSink.kind).toBe('none');
		await expect(observability.dispose()).resolves.toBeUndefined();
	});

	it('composes the exporter the deployment asked for and drains it', async () => {
		const observability = createPlatformObservability({
			environment: { ...OTLP },
			version: '1.2.3',
		});

		expect(observability.exporter).not.toBeNull();
		expect(observability.exporter?.stats()).toEqual({
			exported: 0,
			dropped: 0,
			failures: 0,
			retries: 0,
		});
		await observability.dispose();
		await expect(observability.dispose()).resolves.toBeUndefined();
	});

	it('exports a span recorded while the process stopped', async () => {
		const tracer = createTracer();
		const bodies: string[] = [];
		const observability = createPlatformObservability({
			environment: { ...OTLP },
			tracer,
			fetch: (async (_url, init) => {
				bodies.push(String((init as { body: string }).body));
				return new Response(null, { status: 200 });
			}) as typeof fetch,
		});

		tracer.startSpan('shutdown', { parent: null }).end('ok');
		await observability.dispose();

		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toContain('"name":"shutdown"');
		expect(observability.exporter?.stats().exported).toBe(1);
	});

	it('empties a queue that holds more reports than one batch', async () => {
		const sink = fakeErrorSink(ERROR_SINK_LIMITS.queue);

		await drainErrorSink(sink);

		expect(sink.stats()).toMatchObject({
			queued: 0,
			delivered: ERROR_SINK_LIMITS.queue,
		});
	});

	it('stops draining a sink that sends nothing', async () => {
		const sink = fakeErrorSink(ERROR_SINK_LIMITS.queue, false);

		await expect(drainErrorSink(sink)).resolves.toBeUndefined();

		expect(sink.stats().queued).toBe(ERROR_SINK_LIMITS.queue);
	});

	it('composes the collector a build hands it', () => {
		/* A build runs with the deployment's NODE_ENV and FD_INTERNAL_BUILD=true;
		   both octane.config.ts files relax that to development before reading, the
		   way the database, mail and storage readers are relaxed, so a collector
		   the build never dials cannot fail it. */
		expect(() =>
			createPlatformObservability({
				environment: {
					...OTLP,
					NODE_ENV: 'development',
					FD_TRACE_OTLP_URL: 'http://collector.internal/v1/traces',
				},
			}),
		).not.toThrow();
	});

	it.each([
		[
			'an unknown exporter',
			{ FD_TRACE_EXPORTER: 'jaeger' },
			/FD_TRACE_EXPORTER/,
		],
		[
			'an exporter with no endpoint',
			{ FD_TRACE_EXPORTER: 'otlp' },
			/FD_TRACE_OTLP_URL/,
		],
		[
			'a plain http collector in production',
			{ ...OTLP, NODE_ENV: 'production', FD_TRACE_OTLP_URL: 'http://c/v1' },
			/https/,
		],
		[
			'an unusable sample ratio',
			{ FD_TRACE_SAMPLE: 'half' },
			/FD_TRACE_SAMPLE/,
		],
		['an unknown error sink', { FD_ERROR_SINK: 'syslog' }, /FD_ERROR_SINK/],
		[
			'a webhook with no endpoint',
			{ FD_ERROR_SINK: 'webhook' },
			/FD_ERROR_SINK_URL/,
		],
	])('refuses to compose with %s', (_label, environment, message) => {
		expect(() => createPlatformObservability({ environment })).toThrow(message);
	});
});
