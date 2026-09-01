import { createContext } from '@octanejs/app-core';
import { describe, expect, it } from 'vitest';
import { defineEndpoint } from '../src/index.ts';

describe('defineEndpoint', () => {
	it('serves a public endpoint with a request id', async () => {
		const endpoint = defineEndpoint({
			id: 'system.health',
			path: '/api/health',
			methods: ['GET'],
			access: { kind: 'public' },
			handler: () => Response.json({ status: 'ok' }),
		});
		const context = createContext(
			new Request('http://localhost/api/health'),
			{},
		);
		const response = await endpoint.serverRoute.handler(context);
		expect(response.status).toBe(200);
		expect(response.headers.get('x-request-id')).toBeTruthy();
	});

	it('denies a protected endpoint by default', async () => {
		const endpoint = defineEndpoint({
			id: 'system.secret',
			path: '/api/secret',
			methods: ['GET'],
			access: { kind: 'permission', permission: 'system.secret.read' },
			resolveIdentity: () => null,
			handler: () => Response.json({ secret: true }),
		});
		const context = createContext(
			new Request('http://localhost/api/secret'),
			{},
		);
		const response = await endpoint.serverRoute.handler(context);
		expect(response.status).toBe(401);
	});
});
