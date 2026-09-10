import { createContext } from '@octanejs/app-core';
import { describe, expect, it } from 'vitest';
import { createReadinessEndpoint, healthEndpoint } from './health.ts';

describe('health endpoint', () => {
	it('reports the architecture version', async () => {
		const context = createContext(
			new Request('http://localhost/api/health'),
			{},
		);
		const response = await healthEndpoint.serverRoute.handler(context);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: 'ok',
			service: 'flowdular',
			architectureVersion: '0.2.0',
		});
	});
});

describe('readiness endpoint', () => {
	it('includes database readiness without exposing connection details', async () => {
		const endpoint = createReadinessEndpoint({
			adapter: 'postgresql',
			check: async () => ({ adapter: 'postgresql', status: 'ready' }),
			acquire: async () => {
				throw new Error('unused');
			},
			dispose: async () => {},
		});
		const context = createContext(
			new Request('http://localhost/api/ready'),
			{},
		);
		const response = await endpoint.serverRoute.handler(context);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: 'ready',
			database: { adapter: 'postgresql', status: 'ready' },
		});
	});

	it('returns a generic 503 when the database check fails', async () => {
		const endpoint = createReadinessEndpoint({
			adapter: 'postgresql',
			check: async () => {
				throw new Error('postgresql://runtime:secret@example/flowdular');
			},
			acquire: async () => {
				throw new Error('unused');
			},
			dispose: async () => {},
		});
		const context = createContext(
			new Request('http://localhost/api/ready'),
			{},
		);
		const response = await endpoint.serverRoute.handler(context);
		const body = JSON.stringify(await response.json());

		expect(response.status).toBe(503);
		expect(response.headers.get('retry-after')).toBe('1');
		expect(body).toContain('unavailable');
		expect(body).not.toContain('secret');
	});
});
