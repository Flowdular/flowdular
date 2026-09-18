import { describe, expect, it } from 'vitest';
import {
	bindModuleRoutes,
	buildOpenApiDocument,
	defineEndpoint,
	installModuleActivationGate,
	serverEndpointCatalog,
	type CatalogedEndpoint,
} from '../src/index.ts';

function catalogue(...ids: readonly string[]): readonly CatalogedEndpoint[] {
	const wanted = new Set(ids);
	return serverEndpointCatalog()
		.list()
		.filter((entry) => wanted.has(entry.id));
}

function read(id: string) {
	return defineEndpoint({
		id,
		path: '/api/catalog/items',
		methods: ['GET'],
		access: { kind: 'permission', permission: 'catalog.items.read' },
		resolveIdentity: () => null,
		handler: () => Response.json({ items: [] }),
		documentation: {
			summary: 'List catalog items',
			parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
			responses: [
				{
					status: 200,
					description: 'One page of items.',
					schema: { type: 'object' },
				},
			],
		},
	});
}

describe('endpoint catalogue', () => {
	it('records every defined endpoint with its access and documentation', () => {
		read('catalog.items.list');
		const [entry] = catalogue('catalog.items.list');
		expect(entry?.path).toBe('/api/catalog/items');
		expect(entry?.methods).toEqual(['GET']);
		expect(entry?.access).toEqual({
			kind: 'permission',
			permission: 'catalog.items.read',
		});
		expect(entry?.documentation?.summary).toBe('List catalog items');
	});

	it('refuses documentation that would make the document unservable', () => {
		expect(() =>
			defineEndpoint({
				id: 'catalog.items.broken',
				path: '/api/catalog/broken',
				methods: ['GET'],
				access: { kind: 'public' },
				handler: () => new Response(null),
				documentation: { summary: '' },
			}),
		).toThrow(/summary must be 1 to 160 characters/);
	});

	it('replaces an entry when the same endpoint is composed again', () => {
		read('catalog.items.recomposed');
		read('catalog.items.recomposed');
		expect(catalogue('catalog.items.recomposed')).toHaveLength(1);
	});
});

describe('buildOpenApiDocument', () => {
	it('describes an endpoint that declared documentation', async () => {
		const endpoint = read('catalog.items.documented');
		bindModuleRoutes([endpoint.serverRoute], 'catalog.core');
		const document = await buildOpenApiDocument({
			endpoints: catalogue('catalog.items.documented'),
			serverUrl: 'https://erp.example.com',
		});
		const operation = (
			document.paths as Record<string, Record<string, Record<string, unknown>>>
		)['/api/catalog/items']!.get!;
		expect(document.openapi).toBe('3.1.0');
		expect(operation.operationId).toBe('catalog.items.documented');
		expect(operation.summary).toBe('List catalog items');
		expect(operation.tags).toEqual(['catalog.core']);
		expect(operation['x-flowdular-permission']).toBe('catalog.items.read');
		expect(operation.security).toEqual([{ apiToken: [] }]);
		expect(operation.responses).toHaveProperty('401');
		expect(document.servers).toEqual([{ url: 'https://erp.example.com' }]);
	});

	it('describes an endpoint that declared none, from its address alone', async () => {
		defineEndpoint({
			id: 'ledger.entries.list',
			path: '/api/ledger/entries/:entryId',
			methods: ['GET'],
			access: { kind: 'permission', permission: 'ledger.entries.read' },
			resolveIdentity: () => null,
			handler: () => Response.json({}),
		});
		const document = await buildOpenApiDocument({
			endpoints: catalogue('ledger.entries.list'),
		});
		const operation = (
			document.paths as Record<string, Record<string, Record<string, unknown>>>
		)['/api/ledger/entries/{entryId}']!.get!;
		expect(operation['x-flowdular-documented']).toBe(false);
		expect(operation.description).toBe(
			'Requires the ledger.entries.read permission.',
		);
		expect(operation.parameters).toEqual([
			{
				name: 'entryId',
				in: 'path',
				required: true,
				schema: { type: 'string' },
			},
		]);
	});

	it('leaves out an operation the caller has no permission for', async () => {
		read('catalog.items.filtered');
		defineEndpoint({
			id: 'catalog.items.delete',
			path: '/api/catalog/items/delete',
			methods: ['POST'],
			access: { kind: 'permission', permission: 'catalog.items.manage' },
			resolveIdentity: () => null,
			handler: () => Response.json({}),
		});
		const document = await buildOpenApiDocument({
			endpoints: catalogue('catalog.items.filtered', 'catalog.items.delete'),
			permissions: new Set(['catalog.items.read']),
		});
		expect(Object.keys(document.paths)).toEqual(['/api/catalog/items']);
	});

	it('keeps a public operation for a caller with no permissions at all', async () => {
		defineEndpoint({
			id: 'system.health.probe',
			path: '/api/health',
			methods: ['GET'],
			access: { kind: 'public' },
			handler: () => Response.json({ status: 'ok' }),
		});
		const document = await buildOpenApiDocument({
			endpoints: catalogue('system.health.probe'),
			permissions: new Set<string>(),
		});
		const operation = (
			document.paths as Record<string, Record<string, Record<string, unknown>>>
		)['/api/health']!.get!;
		expect(operation.security).toEqual([]);
	});

	it('marks a mutation as needing a write-enabled token', async () => {
		defineEndpoint({
			id: 'catalog.items.create',
			path: '/api/catalog/items',
			methods: ['POST'],
			access: { kind: 'permission', permission: 'catalog.items.manage' },
			resolveIdentity: () => null,
			handler: () => Response.json({}, { status: 201 }),
			documentation: {
				summary: 'Create a catalog item',
				body: { schema: { type: 'object' } },
			},
		});
		const document = await buildOpenApiDocument({
			endpoints: catalogue('catalog.items.create'),
		});
		const operation = (
			document.paths as Record<string, Record<string, Record<string, unknown>>>
		)['/api/catalog/items']!.post!;
		expect(operation['x-flowdular-token-write']).toBe(true);
		expect(operation.requestBody).toMatchObject({ required: true });
	});

	it('leaves out an operation of a module inactive in the workspace', async () => {
		const endpoint = read('catalog.items.inactive');
		bindModuleRoutes([endpoint.serverRoute], 'catalog.core');
		installModuleActivationGate({ isActive: () => false });
		try {
			const document = await buildOpenApiDocument({
				endpoints: catalogue('catalog.items.inactive'),
				tenantId: 'tenant-1',
			});
			expect(Object.keys(document.paths)).toEqual([]);
		} finally {
			installModuleActivationGate(null);
		}
	});
});
