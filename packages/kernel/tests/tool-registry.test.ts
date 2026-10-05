import { describe, expect, it } from 'vitest';
import { createPlatformToolRegistry } from '../src/index.ts';

describe('platform tool registry', () => {
	it('collects tools from several modules and rejects duplicate ids', () => {
		const registry = createPlatformToolRegistry<{
			readonly id: string;
			readonly module: string;
		}>();
		registry.register([{ id: 'catalog.items.search', module: 'catalog.core' }]);
		registry.register([{ id: 'parties.lookup', module: 'parties.core' }]);
		expect(registry.list().map((tool) => tool.id)).toEqual([
			'catalog.items.search',
			'parties.lookup',
		]);
		expect(() =>
			registry.register([{ id: 'parties.lookup', module: 'other.core' }]),
		).toThrowError(expect.objectContaining({ code: 'AGENT_TOOL_DUPLICATE' }));
	});

	it('keeps native tools apart from invocable tools in one id space', () => {
		const registry = createPlatformToolRegistry<
			{ readonly id: string },
			{ readonly id: string; readonly kind: 'web-search' }
		>();
		registry.register([{ id: 'research.search' }]);
		registry.registerNative({ id: 'research.web-search', kind: 'web-search' });
		expect(registry.list().map((tool) => tool.id)).toEqual(['research.search']);
		expect(registry.listNative()).toEqual([
			{ id: 'research.web-search', kind: 'web-search' },
		]);
		expect(() =>
			registry.registerNative({ id: 'research.search', kind: 'web-search' }),
		).toThrowError(expect.objectContaining({ code: 'AGENT_TOOL_DUPLICATE' }));
		expect(() =>
			registry.register([{ id: 'research.web-search' }]),
		).toThrowError(expect.objectContaining({ code: 'AGENT_TOOL_DUPLICATE' }));
	});

	/* Workflows and agents read only the flowdular markers. A field marked with
	   another vendor's key would be bound into a graph and returned unredacted,
	   so the tool is refused before any consumer sees it. */
	describe('schema markers', () => {
		type SchemaTool = {
			readonly id: string;
			readonly inputSchema?: Readonly<Record<string, unknown>>;
			readonly outputSchema?: Readonly<Record<string, unknown>>;
		};
		const register = (tool: Omit<SchemaTool, 'id'>) =>
			createPlatformToolRegistry<SchemaTool>().register([
				{ id: 'billing.invoices.send', ...tool },
			]);

		it('accepts the flowdular markers and marker-shaped field names', () => {
			expect(() =>
				register({
					inputSchema: {
						type: 'object',
						properties: {
							token: { type: 'string', 'x-flowdular-secret': true },
							'x-api-secret': { type: 'string', writeOnly: true },
						},
					},
					outputSchema: {
						type: 'object',
						properties: {
							total: {
								type: 'number',
								'x-flowdular-read-permission': 'billing.read',
							},
						},
						default: { 'x-acme-secret': 'example data' },
					},
				}),
			).not.toThrow();
		});

		it.each([
			[
				'a foreign secret marker on a nested input field',
				{
					inputSchema: {
						type: 'object',
						properties: {
							account: {
								type: 'object',
								properties: {
									token: { type: 'string', 'x-acme-secret': true },
								},
							},
						},
					},
				},
				'x-acme-secret',
			],
			[
				'a foreign read-permission marker on an output array item',
				{
					outputSchema: {
						type: 'array',
						items: {
							type: 'string',
							'x-acme-read-permission': 'billing.read',
						},
					},
				},
				'x-acme-read-permission',
			],
			[
				'a differently cased flowdular marker',
				{
					inputSchema: {
						anyOf: [{ type: 'string', 'X-Flowdular-Secret': true }],
					},
				},
				'X-Flowdular-Secret',
			],
		])('refuses %s', (_label, schemas, marker) => {
			expect(() => register(schemas)).toThrowError(
				expect.objectContaining({
					code: 'AGENT_TOOL_SCHEMA_MARKER_UNKNOWN',
					message: expect.stringContaining(marker),
				}),
			);
		});
	});
});
