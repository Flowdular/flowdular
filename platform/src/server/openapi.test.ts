import { createContext } from '@octanejs/app-core';
import { defineEndpoint, serverEndpointCatalog } from '@flowdular/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { createHealthEndpoint } from './health.ts';
import { createOpenApiRoutes } from './openapi.ts';

function ask(
	routes: ReturnType<typeof createOpenApiRoutes>,
): Promise<Response> {
	return Promise.resolve(
		routes[0]!.handler(
			createContext(new Request('https://erp.example/api/openapi.json'), {}),
		),
	);
}

beforeEach(() => {
	serverEndpointCatalog().beginGeneration();
	defineEndpoint({
		id: 'catalog.items.list',
		path: '/api/catalog/items',
		methods: ['GET'],
		access: { kind: 'permission', permission: 'catalog.items.read' },
		resolveIdentity: () => null,
		handler: () => Response.json({ items: [] }),
	});
	defineEndpoint({
		id: 'users.members.list',
		path: '/api/users/members',
		methods: ['GET'],
		access: { kind: 'permission', permission: 'users.members.read' },
		resolveIdentity: () => null,
		handler: () => Response.json({ members: [] }),
	});
});

describe('openapi route', () => {
	it('demands a credential before describing anything', async () => {
		const response = await ask(
			createOpenApiRoutes({ resolveIdentity: () => null }),
		);
		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).toBe('Bearer');
		expect(await response.json()).toMatchObject({
			error: { code: 'UNAUTHENTICATED' },
		});
	});

	it('describes only what the presented credential may call', async () => {
		const response = await ask(
			createOpenApiRoutes({
				resolveIdentity: () => ({
					subjectId: 'token-1',
					tenantId: 'tenant-1',
					permissions: new Set(['catalog.items.read']),
				}),
			}),
		);
		const document = (await response.json()) as {
			openapi: string;
			servers: readonly { url: string }[];
			paths: Record<string, unknown>;
		};
		expect(response.status).toBe(200);
		expect(document.openapi).toBe('3.1.0');
		expect(Object.keys(document.paths)).toContain('/api/catalog/items');
		expect(Object.keys(document.paths)).not.toContain('/api/users/members');
		expect(document.servers[0]?.url).toBe('https://erp.example');
	});

	it('names the configured public address rather than the one reached', async () => {
		const response = await ask(
			createOpenApiRoutes({
				resolveIdentity: () => ({
					subjectId: 'session-1',
					tenantId: 'tenant-1',
					permissions: new Set(['catalog.items.read']),
				}),
				publicBaseUrl: 'https://erp.example.com',
			}),
		);
		const document = (await response.json()) as {
			servers: readonly { url: string }[];
		};
		expect(document.servers[0]?.url).toBe('https://erp.example.com');
	});

	/* The catalogue is cleared when a generation starts composing, so a platform
	   endpoint built at import time would be recorded before that and never
	   appear. Health is the one that used to be. */
	it('describes a platform endpoint the generation builds', async () => {
		createHealthEndpoint();
		const routes = createOpenApiRoutes({
			resolveIdentity: () => ({
				subjectId: 'session-1',
				tenantId: 'tenant-1',
				permissions: new Set<string>(),
			}),
		});
		const document = (await (await ask(routes)).json()) as {
			paths: Record<string, Record<string, { operationId: string }>>;
		};
		expect(document.paths['/api/health']?.get?.operationId).toBe(
			'system.health',
		);
	});

	it('describes itself, so a caller can find the document from the document', async () => {
		const routes = createOpenApiRoutes({
			resolveIdentity: () => ({
				subjectId: 'session-1',
				tenantId: 'tenant-1',
				permissions: new Set<string>(),
			}),
		});
		const document = (await (await ask(routes)).json()) as {
			paths: Record<string, Record<string, { operationId: string }>>;
		};
		expect(document.paths['/api/openapi.json']?.get?.operationId).toBe(
			'system.openapi',
		);
	});
});
