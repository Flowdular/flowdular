import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext } from '@octanejs/app-core';
import { createMetricsRegistry, createModuleMetrics } from '@flowdular/server';
import { describe, expect, it } from 'vitest';
import { createMetricsRoutes } from './metrics.ts';

function scrape(
	routes: ReturnType<typeof createMetricsRoutes>,
	token?: string,
): Promise<Response> {
	const request = new Request('http://localhost/api/metrics', {
		headers: token ? { authorization: token } : {},
	});
	return Promise.resolve(routes[0]!.handler(createContext(request, {})));
}

describe('metrics route', () => {
	it('is not composed unless the deployment asks for it', () => {
		expect(createMetricsRoutes({ environment: {} })).toHaveLength(0);
		expect(
			createMetricsRoutes({ environment: { FD_METRICS: 'false' } }),
		).toHaveLength(0);
	});

	it('refuses to boot on a value that is neither true nor false', () => {
		expect(() =>
			createMetricsRoutes({ environment: { FD_METRICS: 'yes' } }),
		).toThrow(/FD_METRICS/);
	});

	it('serves the exposition format when enabled without a token', async () => {
		const routes = createMetricsRoutes({
			environment: { FD_METRICS: 'true' },
			metrics: createMetricsRegistry(),
			version: '1.2.3',
		});
		const response = await scrape(routes);

		expect(routes).toHaveLength(1);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe(
			'text/plain; version=0.0.4; charset=utf-8',
		);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.text()).toContain(
			'flowdular_build_info{version="1.2.3"} 1',
		);
	});

	it('reads the running platform version when none is passed', async () => {
		const version = (
			JSON.parse(
				readFileSync(
					join(import.meta.dirname, '..', '..', 'package.json'),
					'utf8',
				),
			) as { version: string }
		).version;
		const routes = createMetricsRoutes({
			environment: { FD_METRICS: 'true' },
			metrics: createMetricsRegistry(),
		});

		expect(await (await scrape(routes)).text()).toContain(
			`flowdular_build_info{version="${version}"} 1`,
		);
	});

	it('exposes the series a module opened through the binding it composed with', async () => {
		const routes = createMetricsRoutes({
			environment: { FD_METRICS: 'true' },
			version: '1.2.3',
		});
		/* Exactly what the generated composition hands a module as context.metrics,
		   so what lands here is what a module records. */
		createModuleMetrics('demo.core').counter('jobs_started', {
			kind: 'import',
		});

		expect(await (await scrape(routes)).text()).toContain(
			'flowdular_module_demo_core_jobs_started_total{kind="import"} 1',
		);
	});

	it('denies a scrape without the configured token', async () => {
		const routes = createMetricsRoutes({
			environment: { FD_METRICS: 'true', FD_METRICS_TOKEN: 'scrape-secret' },
			metrics: createMetricsRegistry(),
			version: '1.2.3',
		});

		for (const header of [
			undefined,
			'Bearer wrong-secret',
			'Bearer scrape-secre',
			'scrape-secret',
			'Basic scrape-secret',
		]) {
			const response = await scrape(routes, header);
			expect(response.status).toBe(401);
			expect(response.headers.get('www-authenticate')).toBe('Bearer');
			expect(await response.text()).not.toContain('flowdular_build_info');
		}
	});

	it('serves a scrape that presents the configured token', async () => {
		const routes = createMetricsRoutes({
			environment: { FD_METRICS: 'true', FD_METRICS_TOKEN: ' scrape-secret ' },
			metrics: createMetricsRegistry(),
			version: '1.2.3',
		});
		const response = await scrape(routes, 'Bearer scrape-secret');

		expect(response.status).toBe(200);
		expect(await response.text()).toContain('flowdular_build_info');
	});
});
