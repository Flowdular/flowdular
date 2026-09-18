import { describe, expect, it } from 'vitest';
import { curlExample, describeApi } from '../src/client/api-docs.ts';

const DOCUMENT = {
	info: { title: 'Flowdular API', version: '0.4.1' },
	servers: [{ url: 'https://erp.example.com' }],
	paths: {
		'/api/catalog/items': {
			get: {
				operationId: 'catalog.items.list',
				summary: 'List catalog items',
				tags: ['catalog.core'],
				parameters: [{ name: 'limit', in: 'query' }],
				responses: { '200': { description: 'One page of items.' } },
				'x-flowdular-permission': 'catalog.items.read',
			},
			post: {
				operationId: 'catalog.items.create',
				summary: 'Create a catalog item',
				tags: ['catalog.core'],
				requestBody: {
					content: { 'application/json': { schema: { type: 'object' } } },
				},
				responses: { '201': { description: 'The created item.' } },
				'x-flowdular-permission': 'catalog.items.manage',
				'x-flowdular-token-write': true,
				'x-flowdular-documented': false,
			},
		},
		'/api/health': {
			get: {
				operationId: 'system.health',
				summary: 'Health',
				tags: ['system'],
			},
		},
	},
};

describe('describeApi', () => {
	it('flattens the document into operations a screen can list', () => {
		const description = describeApi(DOCUMENT);
		expect(description.serverUrl).toBe('https://erp.example.com');
		expect(description.operations.map((operation) => operation.id)).toEqual([
			'catalog.items.list',
			'catalog.items.create',
			'system.health',
		]);
	});

	it('carries the bounds a caller has to satisfy', () => {
		const [read, write] = describeApi(DOCUMENT).operations;
		expect(read).toMatchObject({
			method: 'GET',
			moduleId: 'catalog.core',
			permission: 'catalog.items.read',
			needsWriteToken: false,
			documented: true,
		});
		expect(write).toMatchObject({
			method: 'POST',
			permission: 'catalog.items.manage',
			needsWriteToken: true,
			documented: false,
		});
		expect(read?.parameters).toEqual([
			{ name: 'limit', in: 'query', required: false, description: '' },
		]);
		expect(write?.requestBody).toEqual({ type: 'object' });
	});

	it('survives a document that declares nothing beyond an address', () => {
		const [operation] = describeApi({
			paths: { '/api/thing': { get: {} } },
		}).operations;
		expect(operation?.id).toBe('get:/api/thing');
		expect(operation?.summary).toBe('/api/thing');
		expect(operation?.responses).toEqual([]);
	});
});

describe('curlExample', () => {
	it('shows a read as one call with the token placeholder', () => {
		const [read] = describeApi(DOCUMENT).operations;
		expect(curlExample(read!, 'https://erp.example.com')).toBe(
			[
				"curl -X GET 'https://erp.example.com/api/catalog/items' \\",
				"  -H 'authorization: Bearer $FLOWDULAR_TOKEN'",
			].join('\n'),
		);
	});

	it('adds the content type and a body for a mutation', () => {
		const write = describeApi(DOCUMENT).operations[1]!;
		expect(curlExample(write, 'https://erp.example.com')).toContain(
			"-H 'content-type: application/json'",
		);
	});
});
