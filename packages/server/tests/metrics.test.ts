import { createContext } from '@octanejs/app-core';
import { describe, expect, it, vi } from 'vitest';
import {
	createMetricsRegistry,
	defineEndpoint,
	serverMetrics,
} from '../src/index.ts';

function seriesValue(exposition: string, series: string): number | undefined {
	for (const line of exposition.split('\n')) {
		if (line.startsWith(`${series} `))
			return Number(line.slice(series.length + 1));
	}
	return undefined;
}

async function call(
	endpoint: ReturnType<typeof defineEndpoint>,
	path: string,
): Promise<Response> {
	return endpoint.serverRoute.handler(
		createContext(new Request(`http://localhost${path}`), {}),
	);
}

describe('endpoint instrumentation', () => {
	it('counts a served request and times it in the histogram', async () => {
		const endpoint = defineEndpoint({
			id: 'metrics.served',
			path: '/api/metrics-served',
			methods: ['GET'],
			access: { kind: 'public' },
			handler: () => Response.json({ status: 'ok' }),
		});

		await call(endpoint, '/api/metrics-served');
		await call(endpoint, '/api/metrics-served');
		const exposition = serverMetrics().expose();

		expect(
			seriesValue(
				exposition,
				'flowdular_http_requests_total{endpoint="metrics.served",method="GET",status="2xx"}',
			),
		).toBe(2);
		expect(
			seriesValue(
				exposition,
				'flowdular_http_request_duration_seconds_count{endpoint="metrics.served"}',
			),
		).toBe(2);
		expect(
			seriesValue(
				exposition,
				'flowdular_http_request_duration_seconds_bucket{endpoint="metrics.served",le="+Inf"}',
			),
		).toBe(2);
	});

	it('records the status class of a denied and of a failed request', async () => {
		const logged = vi
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		const denied = defineEndpoint({
			id: 'metrics.denied',
			path: '/api/metrics-denied',
			methods: ['GET'],
			access: { kind: 'permission', permission: 'metrics.read' },
			resolveIdentity: () => null,
			handler: () => Response.json({ secret: true }),
		});
		const failing = defineEndpoint({
			id: 'metrics.failed',
			path: '/api/metrics-failed',
			methods: ['GET'],
			access: { kind: 'public' },
			handler: () => {
				throw new Error('boom');
			},
		});

		expect((await call(denied, '/api/metrics-denied')).status).toBe(401);
		expect((await call(failing, '/api/metrics-failed')).status).toBe(500);
		const exposition = serverMetrics().expose();
		logged.mockRestore();

		expect(
			seriesValue(
				exposition,
				'flowdular_http_requests_total{endpoint="metrics.denied",method="GET",status="4xx"}',
			),
		).toBe(1);
		expect(
			seriesValue(
				exposition,
				'flowdular_http_requests_total{endpoint="metrics.failed",method="GET",status="5xx"}',
			),
		).toBe(1);
	});

	it('serves every request from one process registry', () => {
		expect(serverMetrics()).toBe(serverMetrics());
	});
});

describe('metrics registry', () => {
	it('places a duration in the bucket at or above it', () => {
		const metrics = createMetricsRegistry();
		metrics.recordHttpRequest({
			endpoint: 'billing.invoice.list',
			method: 'GET',
			status: 200,
			durationSeconds: 0.003,
		});
		metrics.recordHttpRequest({
			endpoint: 'billing.invoice.list',
			method: 'GET',
			status: 200,
			durationSeconds: 7,
		});
		const exposition = metrics.expose();
		const bucket = (bound: string) =>
			seriesValue(
				exposition,
				`flowdular_http_request_duration_seconds_bucket{endpoint="billing.invoice.list",le="${bound}"}`,
			);

		expect(bucket('0.005')).toBe(1);
		expect(bucket('1')).toBe(1);
		expect(bucket('5')).toBe(1);
		expect(bucket('10')).toBe(2);
		expect(bucket('+Inf')).toBe(2);
		expect(
			seriesValue(
				exposition,
				'flowdular_http_request_duration_seconds_sum{endpoint="billing.invoice.list"}',
			),
		).toBeCloseTo(7.003, 6);
	});

	it('counts a request above the last bucket without dropping it', () => {
		const metrics = createMetricsRegistry();
		metrics.recordHttpRequest({
			endpoint: 'billing.report',
			method: 'POST',
			status: 200,
			durationSeconds: 42,
		});
		const exposition = metrics.expose();

		expect(
			seriesValue(
				exposition,
				'flowdular_http_request_duration_seconds_bucket{endpoint="billing.report",le="10"}',
			),
		).toBe(0);
		expect(
			seriesValue(
				exposition,
				'flowdular_http_request_duration_seconds_bucket{endpoint="billing.report",le="+Inf"}',
			),
		).toBe(1);
	});

	it('stops admitting label sets at the ceiling and publishes the refusals', () => {
		const metrics = createMetricsRegistry();
		for (let index = 0; index < 2_100; index += 1) {
			metrics.recordHttpRequest({
				endpoint: `billing.endpoint-${index}`,
				method: 'GET',
				status: 200,
				durationSeconds: 0.01,
			});
		}
		// An endpoint already admitted keeps recording after the ceiling.
		metrics.recordHttpRequest({
			endpoint: 'billing.endpoint-0',
			method: 'GET',
			status: 200,
			durationSeconds: 0.01,
		});
		const exposition = metrics.expose();
		const counters = exposition
			.split('\n')
			.filter((line) => line.startsWith('flowdular_http_requests_total{'));

		expect(counters).toHaveLength(2_000);
		expect(
			seriesValue(
				exposition,
				'flowdular_http_requests_total{endpoint="billing.endpoint-0",method="GET",status="2xx"}',
			),
		).toBe(2);
		expect(exposition).not.toContain('billing.endpoint-2099');
		expect(
			seriesValue(exposition, 'flowdular_metrics_dropped_samples_total'),
		).toBe(100);
	});

	it('keeps an unknown method and an out of range status out of the label space', () => {
		const metrics = createMetricsRegistry();
		metrics.recordHttpRequest({
			endpoint: 'billing.probe',
			method: 'TRACE',
			status: 9_000,
			durationSeconds: 0.01,
		});

		expect(metrics.expose()).toContain(
			'flowdular_http_requests_total{endpoint="billing.probe",method="other",status="unknown"} 1',
		);
	});

	it('escapes a label value so one series cannot forge another line', () => {
		const metrics = createMetricsRegistry();
		metrics.setBuildVersion('1.0.0"}\n flowdular_build_info{version="forged');

		expect(metrics.expose()).toContain(
			'flowdular_build_info{version="1.0.0\\"}\\n flowdular_build_info{version=\\"forged"} 1',
		);
	});

	it('exposes the process series with a type declaration and a trailing newline', () => {
		const metrics = createMetricsRegistry();
		metrics.setBuildVersion('4.5.6');
		const exposition = metrics.expose();

		expect(exposition).toContain(
			'# TYPE flowdular_http_request_duration_seconds histogram',
		);
		expect(exposition).toContain('# TYPE flowdular_build_info gauge');
		expect(exposition).toContain('flowdular_build_info{version="4.5.6"} 1');
		expect(
			seriesValue(exposition, 'flowdular_process_start_time_seconds'),
		).toBeGreaterThan(1_600_000_000);
		expect(
			seriesValue(exposition, 'process_resident_memory_bytes'),
		).toBeGreaterThan(0);
		expect(
			seriesValue(exposition, 'nodejs_eventloop_lag_seconds'),
		).toBeGreaterThanOrEqual(0);
		expect(exposition.endsWith('\n')).toBe(true);
	});

	it('omits a build version until the platform declares one', () => {
		expect(createMetricsRegistry().expose()).not.toContain(
			'flowdular_build_info',
		);
	});

	it('reports the event loop delay of the interval since the previous scrape', async () => {
		const metrics = createMetricsRegistry();
		const lag = (exposition: string) =>
			seriesValue(exposition, 'nodejs_eventloop_lag_seconds');
		/* The first scrape starts the sampler and drains whatever earlier cases
		   left in it, so the next one measures this case alone. */
		metrics.expose();
		const busyUntil = Date.now() + 120;
		while (Date.now() < busyUntil) {
			/* Hold the loop so the sampler records a delay it cannot miss. */
		}
		await new Promise((resolve) => setTimeout(resolve, 30));

		const busy = lag(metrics.expose());
		const quiet = lag(metrics.expose());

		expect(busy).toBeGreaterThan(0);
		expect(quiet).toBe(0);
	});
});
