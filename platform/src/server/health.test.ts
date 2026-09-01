import { createContext } from '@octanejs/app-core';
import { describe, expect, it } from 'vitest';
import { healthEndpoint } from './health.ts';

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
			architectureVersion: '0.2.0',
		});
	});
});
