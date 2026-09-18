import { createContext } from '@octanejs/app-core';
import { describe, expect, it, vi } from 'vitest';
import { createCorsMiddleware } from '../src/index.ts';

const BLOG = 'https://blog.example.com';

function run(
	request: Request,
	allowOrigin: (origin: string) => boolean | Promise<boolean>,
	next = () => Promise.resolve(Response.json({ items: [] })),
) {
	const middleware = createCorsMiddleware({ allowOrigin });
	return middleware(createContext(request, {}), next);
}

function preflight(origin: string, path = '/api/catalog/items'): Request {
	return new Request(`http://localhost${path}`, {
		method: 'OPTIONS',
		headers: {
			origin,
			'access-control-request-method': 'GET',
			'access-control-request-headers': 'authorization',
		},
	});
}

describe('createCorsMiddleware', () => {
	it('admits an allowed origin on the preflight without reaching a route', async () => {
		const next = vi.fn(() => Promise.resolve(Response.json({})));
		const response = await run(preflight(BLOG), () => true, next);
		expect(response.status).toBe(204);
		expect(response.headers.get('access-control-allow-origin')).toBe(BLOG);
		expect(response.headers.get('access-control-allow-headers')).toContain(
			'authorization',
		);
		expect(response.headers.get('access-control-allow-credentials')).toBeNull();
		expect(next).not.toHaveBeenCalled();
	});

	it('answers a refused origin without any cross-origin permission', async () => {
		const response = await run(preflight(BLOG), () => false);
		expect(response.status).toBe(204);
		expect(response.headers.get('access-control-allow-origin')).toBeNull();
		expect(response.headers.get('access-control-allow-methods')).toBeNull();
	});

	it('allows a cross-origin read and never allows credentials', async () => {
		const response = await run(
			new Request('http://localhost/api/catalog/items', {
				headers: { origin: BLOG },
			}),
			() => true,
		);
		expect(response.headers.get('access-control-allow-origin')).toBe(BLOG);
		expect(response.headers.get('access-control-allow-credentials')).toBeNull();
		expect(response.headers.get('vary')).toContain('origin');
	});

	it('serves a refused origin without the header that would let it be read', async () => {
		const response = await run(
			new Request('http://localhost/api/catalog/items', {
				headers: { origin: 'https://attacker.example.com' },
			}),
			(origin) => origin === BLOG,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('access-control-allow-origin')).toBeNull();
	});

	it('never asks about a same-origin or an address outside the API', async () => {
		const allowOrigin = vi.fn(() => true);
		await run(
			new Request('http://localhost/api/catalog/items', {
				headers: { origin: 'http://localhost' },
			}),
			allowOrigin,
		);
		await run(
			new Request('http://localhost/app', { headers: { origin: BLOG } }),
			allowOrigin,
		);
		expect(allowOrigin).not.toHaveBeenCalled();
	});

	it('ignores a malformed origin header', async () => {
		const allowOrigin = vi.fn(() => true);
		await run(
			new Request('http://localhost/api/catalog/items', {
				headers: { origin: 'null' },
			}),
			allowOrigin,
		);
		expect(allowOrigin).not.toHaveBeenCalled();
	});
});
