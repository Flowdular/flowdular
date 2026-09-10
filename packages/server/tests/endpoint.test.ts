import { createContext } from '@octanejs/app-core';
import { describe, expect, it, vi } from 'vitest';
import { defineEndpoint } from '../src/index.ts';

describe('defineEndpoint', () => {
	it.each([
		{ access: { kind: 'permission', permission: 'secret.read' } },
		{ access: { kind: 'unknown' } },
		{},
		{ access: { kind: 'public' }, resolveIdentity: () => null },
	])(
		'rejects malformed runtime access declarations before a handler can run',
		(definition) => {
			const handler = vi.fn(() => Response.json({ secret: true }));
			expect(() =>
				defineEndpoint({
					id: 'test.secret',
					path: '/secret',
					methods: ['GET'],
					handler,
					...definition,
				} as never),
			).toThrow(/invalid access policy/);
			expect(handler).not.toHaveBeenCalled();
		},
	);
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

	it('logs only safe failure metadata when a handler throws a secret-bearing error', async () => {
		const logged = vi
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		const endpoint = defineEndpoint({
			id: 'system.failure',
			path: '/api/failure',
			methods: ['GET'],
			access: { kind: 'public' },
			handler: () => {
				throw new Error('provider token sk-secret-value');
			},
		});
		const response = await endpoint.serverRoute.handler(
			createContext(
				new Request('http://localhost/api/failure', {
					headers: { 'x-request-id': 'request-1' },
				}),
				{},
			),
		);

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			error: { code: 'INTERNAL_ERROR' },
			requestId: 'request-1',
		});
		expect(logged).toHaveBeenCalledWith(
			'[request-1] endpoint system.failure failed (Error)',
		);
		expect(JSON.stringify(logged.mock.calls)).not.toContain('sk-secret-value');
		logged.mockRestore();
	});
});
