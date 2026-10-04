import { describe, expect, it } from 'vitest';
import {
	compileWorkflowGraph,
	validateJsonSchema,
} from '../src/domain/graph.ts';
import {
	actionBindingDiagnostics,
	projectSafeGraph,
	secretSchemaValueDiagnostics,
	sourcePointerIsSafe,
	sourcePointerIsObject,
} from '../src/domain/graph-security.ts';
import type {
	JsonSchemaV1,
	WorkflowGraphV1,
	WorkflowTargetMappingV1,
} from '../src/domain/types.ts';

const sourceSchema: JsonSchemaV1 = {
	type: 'object',
	additionalProperties: false,
	properties: {
		public: { type: 'string' },
		secret: { type: 'string', 'x-flowdular-secret': true },
		writeOnly: { type: 'string', writeOnly: true },
		restricted: {
			type: 'string',
			'x-flowdular-read-permission': 'finance.records.read',
		},
		copy: { type: 'string' },
	},
};

function graphWithMapping(
	mapping: WorkflowTargetMappingV1,
	schema: JsonSchemaV1 = sourceSchema,
): WorkflowGraphV1 {
	return {
		schemaVersion: 1,
		nodes: [
			{
				id: 'input.start',
				label: 'Input',
				type: 'input',
				inputPorts: [],
				outputPorts: [{ name: 'data', schemaId: 'workflow.source' }],
			},
			{
				id: 'output.done',
				label: 'Output',
				type: 'output',
				inputPorts: [{ name: 'input', schemaId: 'workflow.source' }],
				outputPorts: [],
				mappings: [mapping],
			},
		],
		edges: [
			{
				id: 'edge.done',
				source: { nodeId: 'input.start', port: 'data' },
				target: { nodeId: 'output.done', port: 'input' },
			},
		],
		schemas: { 'workflow.source': schema },
		layout: {
			'input.start': { x: 0, y: 0 },
			'output.done': { x: 300, y: 0 },
		},
	};
}

function path(pointer: string): WorkflowTargetMappingV1 {
	return {
		targetPointer: '/copy',
		binding: {
			kind: 'path',
			sourceNodeId: 'input.start',
			sourcePort: 'data',
			pointer,
		},
	};
}

function template(pointer: string): WorkflowTargetMappingV1 {
	return {
		targetPointer: '/copy',
		binding: {
			kind: 'template',
			template: 'Value: {{ value }}',
			variables: [
				{
					name: 'value',
					sourceNodeId: 'input.start',
					sourcePort: 'data',
					pointer,
				},
			],
		},
	};
}

describe('workflow source mapping security', () => {
	it.each([
		['secret path', path('/secret')],
		['write-only template', template('/writeOnly')],
		['restricted path', path('/restricted')],
		['secret-bearing root', path('')],
	])('refuses %s before a non-action output node', (_case, mapping) => {
		const report = compileWorkflowGraph(graphWithMapping(mapping));
		expect(report.issues).toContainEqual(
			expect.objectContaining({
				code: 'WORKFLOW_MAPPING_SOURCE_UNSAFE',
				location: expect.objectContaining({
					kind: 'node',
					nodeId: 'output.done',
				}),
			}),
		);
	});

	it('refuses an unprovable source field and a secret dynamic field', () => {
		const unknown = compileWorkflowGraph(graphWithMapping(path('/undeclared')));
		const dynamic = compileWorkflowGraph(
			graphWithMapping(path('/dynamic'), {
				type: 'object',
				additionalProperties: {
					type: 'string',
					'x-flowdular-secret': true,
				},
			}),
		);
		for (const report of [unknown, dynamic])
			expect(report.issues.map((issue) => issue.code)).toContain(
				'WORKFLOW_MAPPING_SOURCE_UNSAFE',
			);
	});

	it.each([
		['path', path('/public')],
		['template', template('/public')],
	])('keeps the declared public %s mapping valid', (_case, mapping) => {
		expect(compileWorkflowGraph(graphWithMapping(mapping)).valid).toBe(true);
	});

	it('keeps a declared nested path valid when ancestors omit additionalProperties', () => {
		const schema: JsonSchemaV1 = {
			type: 'object',
			properties: {
				box: {
					type: 'object',
					properties: { public: { type: 'string' } },
				},
			},
		};
		expect(
			compileWorkflowGraph(graphWithMapping(path('/box/public'), schema)).valid,
		).toBe(true);
	});

	it.each(['$dynamicRef', '$recursiveRef'])(
		'refuses a source field with %s pointing at a secret',
		(referenceKeyword) => {
			const schema: JsonSchemaV1 = {
				type: 'object',
				properties: {
					alias: {
						type: 'string',
						[referenceKeyword]: '#/$defs/private',
					},
					copy: { type: 'string' },
				},
				$defs: {
					private: { type: 'string', 'x-flowdular-secret': true },
				},
			};
			const report = compileWorkflowGraph(
				graphWithMapping(path('/alias'), schema),
			);
			expect(sourcePointerIsSafe(schema, '/alias')).toBe(false);
			expect(report.valid).toBe(false);
		},
	);

	it.each(['#/__proto__', '#/properties/~2'])(
		'redacts a legacy value beside an unresolved reference %s',
		(reference) => {
			const schema: JsonSchemaV1 = {
				type: 'object',
				properties: {
					alias: { $ref: reference, default: 'needle-secret' },
					'~2': { type: 'string' },
				},
			};
			const graph = graphWithMapping(path('/public'), schema);
			expect(secretSchemaValueDiagnostics(graph)).toContainEqual(
				expect.objectContaining({ code: 'WORKFLOW_SECRET_SCHEMA_VALUE' }),
			);
			expect(
				JSON.stringify(projectSafeGraph(graph, () => undefined).graph),
			).not.toContain('needle-secret');
		},
	);

	it.each(['$dynamicRef', '$recursiveRef'])(
		'redacts an action literal targeting %s before graph read',
		(referenceKeyword) => {
			const actionSchema: JsonSchemaV1 = {
				type: 'object',
				properties: {
					credential: {
						type: 'string',
						[referenceKeyword]: '#/$defs/private',
					},
				},
				$defs: {
					private: { type: 'string', 'x-flowdular-secret': true },
				},
			};
			const graph: WorkflowGraphV1 = {
				schemaVersion: 1,
				nodes: [
					{
						id: 'action.write',
						label: 'Write',
						type: 'action',
						inputPorts: [{ name: 'input', schemaId: 'action.input' }],
						outputPorts: [],
						action: { actionId: 'test.write', contractVersion: 1 },
						mappings: [
							{
								targetPointer: '/credential',
								binding: { kind: 'literal', value: 'needle-secret' },
							},
						],
					},
				],
				edges: [],
				schemas: { 'action.input': actionSchema },
				layout: { 'action.write': { x: 0, y: 0 } },
			};
			const lookup = () => actionSchema;
			expect(actionBindingDiagnostics(graph, lookup)).toEqual([
				expect.objectContaining({
					code: 'WORKFLOW_ACTION_SCHEMA_UNAVAILABLE',
					targetPointer: '/credential',
				}),
			]);
			const projected = projectSafeGraph(graph, lookup);
			expect(JSON.stringify(projected.graph)).not.toContain('needle-secret');
		},
	);

	it.each(['/__proto__/polluted', '/constructor/name', '/prototype/value'])(
		'refuses a target pointer that runtime cannot write: %s',
		(targetPointer) => {
			const report = compileWorkflowGraph(
				graphWithMapping({ ...path('/public'), targetPointer }),
			);
			expect(report.issues.map((issue) => issue.code)).toContain(
				'WORKFLOW_MAPPING_POINTER_INVALID',
			);
		},
	);

	it.each(['$dynamicRef', '$recursiveRef'])(
		'projects a legacy schema value under %s without exposing it',
		(referenceKeyword) => {
			const schema: JsonSchemaV1 = {
				type: 'object',
				properties: {
					public: { type: 'string' },
					alias: {
						type: 'string',
						[referenceKeyword]: '#/$defs/private',
						default: 'needle-secret',
					},
				},
				$defs: {
					private: { type: 'string', 'x-flowdular-secret': true },
				},
			};
			const graph = graphWithMapping(path('/public'), schema);
			expect(secretSchemaValueDiagnostics(graph)).toContainEqual(
				expect.objectContaining({ code: 'WORKFLOW_SECRET_SCHEMA_VALUE' }),
			);
			expect(
				JSON.stringify(projectSafeGraph(graph, () => undefined).graph),
			).not.toContain('needle-secret');
		},
	);

	it('refuses and redacts a literal mapped to a secret non-action input', () => {
		const graph = graphWithMapping({
			targetPointer: '/secret',
			binding: { kind: 'literal', value: 'needle-secret' },
		});
		expect(
			compileWorkflowGraph(graph).issues.map((issue) => issue.code),
		).toContain('WORKFLOW_MAPPING_TARGET_UNSAFE');
		expect(
			JSON.stringify(projectSafeGraph(graph, () => undefined).graph),
		).not.toContain('needle-secret');
	});

	it('refuses and redacts a secret literal on the workflow input node', () => {
		const base = graphWithMapping(path('/public'));
		const graph: WorkflowGraphV1 = {
			...base,
			nodes: base.nodes.map((node) =>
				node.type === 'input'
					? {
							...node,
							mappings: [
								{
									targetPointer: '/secret',
									binding: { kind: 'literal', value: 'needle-secret' },
								},
							],
						}
					: node,
			),
		};
		expect(
			compileWorkflowGraph(graph).issues.map((issue) => issue.code),
		).toContain('WORKFLOW_MAPPING_TARGET_UNSAFE');
		expect(
			JSON.stringify(projectSafeGraph(graph, () => undefined).graph),
		).not.toContain('needle-secret');
	});

	it.each([
		{ kind: 'literal', value: 'scalar' },
		{ kind: 'literal', value: null },
		{ kind: 'template', template: 'scalar', variables: [] },
	] as const)('refuses a scalar mapping to the output root', (binding) => {
		const graph = graphWithMapping(
			{ targetPointer: '', binding },
			{
				type: 'object',
				properties: { public: { type: 'string' }, copy: { type: 'string' } },
			},
		);
		expect(
			compileWorkflowGraph(graph).issues.map((issue) => issue.code),
		).toContain('WORKFLOW_MAPPING_TARGET_INVALID');
	});

	it('refuses a scalar path mapped to the output root', () => {
		const graph = graphWithMapping(
			{ ...path('/public'), targetPointer: '' },
			{
				type: 'object',
				properties: { public: { type: 'string' }, copy: { type: 'string' } },
			},
		);
		expect(
			compileWorkflowGraph(graph).issues.map((issue) => issue.code),
		).toContain('WORKFLOW_MAPPING_TARGET_INVALID');
	});

	it.each([
		{
			name: 'object key 0',
			schema: {
				type: 'object',
				items: { type: 'string' },
				additionalProperties: {
					type: 'string',
					'x-flowdular-secret': true,
				},
			} as JsonSchemaV1,
		},
		{
			name: 'array item 0',
			schema: {
				type: 'array',
				properties: { '0': { type: 'string' } },
				items: { type: 'string', 'x-flowdular-secret': true },
			} as JsonSchemaV1,
		},
	])('refuses a numeric source path through $name', ({ schema }) => {
		expect(sourcePointerIsSafe(schema, '/0')).toBe(false);
		expect(sourcePointerIsObject(schema, '/0')).toBe(false);
		expect(
			compileWorkflowGraph(graphWithMapping(path('/0'), schema)).issues.map(
				(issue) => issue.code,
			),
		).toContain('WORKFLOW_MAPPING_SOURCE_UNSAFE');
	});

	it.each([
		{
			name: 'declared object property',
			schema: {
				type: 'object',
				properties: { '0': { type: 'string' } },
				items: { type: 'string', 'x-flowdular-secret': true },
				additionalProperties: false,
			} as JsonSchemaV1,
		},
		{
			name: 'array item',
			schema: {
				type: 'array',
				properties: {
					'0': { type: 'string', 'x-flowdular-secret': true },
				},
				items: { type: 'string' },
			} as JsonSchemaV1,
		},
	])('keeps a safe numeric source through its $name', ({ schema }) => {
		expect(sourcePointerIsSafe(schema, '/0')).toBe(true);
	});

	it.each([
		{
			name: 'object key 0',
			schema: {
				type: 'object',
				items: { type: 'string' },
				additionalProperties: {
					type: 'string',
					'x-flowdular-secret': true,
				},
			} as JsonSchemaV1,
		},
		{
			name: 'array item 0',
			schema: {
				type: 'array',
				properties: { '0': { type: 'string' } },
				items: { type: 'string', 'x-flowdular-secret': true },
			} as JsonSchemaV1,
		},
	])('refuses and redacts a numeric literal on $name', ({ schema }) => {
		const base = graphWithMapping(path('/0'), schema);
		const graph: WorkflowGraphV1 = {
			...base,
			nodes: base.nodes.map((node) =>
				node.type === 'input'
					? {
							...node,
							mappings: [
								{
									targetPointer: '/0',
									binding: { kind: 'literal', value: 'needle-secret' },
								},
							],
						}
					: node,
			),
		};
		expect(compileWorkflowGraph(graph).issues).toContainEqual(
			expect.objectContaining({
				code: 'WORKFLOW_MAPPING_TARGET_UNSAFE',
				location: expect.objectContaining({ nodeId: 'input.start' }),
			}),
		);
		expect(
			JSON.stringify(projectSafeGraph(graph, () => undefined).graph),
		).not.toContain('needle-secret');
	});

	it('checks schema-valued additionalProperties for object values and action literals', () => {
		const schema: JsonSchemaV1 = {
			type: 'object',
			items: { type: 'string' },
			additionalProperties: { type: 'number' },
		};
		expect(validateJsonSchema({ '0': 'wrong' }, schema)).toContainEqual({
			path: '/0',
			code: 'type',
		});
		const graph: WorkflowGraphV1 = {
			schemaVersion: 1,
			nodes: [
				{
					id: 'action.write',
					label: 'Write',
					type: 'action',
					inputPorts: [{ name: 'input', schemaId: 'action.input' }],
					outputPorts: [],
					action: { actionId: 'test.write', contractVersion: 1 },
					mappings: [
						{
							targetPointer: '/0',
							binding: { kind: 'literal', value: 'wrong' },
						},
					],
				},
			],
			edges: [],
			schemas: { 'action.input': schema },
			layout: { 'action.write': { x: 0, y: 0 } },
		};
		expect(
			compileWorkflowGraph(graph).issues.map((issue) => issue.code),
		).toContain('WORKFLOW_ACTION_LITERAL_INVALID');
	});

	it.each([
		{
			name: 'object key',
			schema: {
				type: 'object',
				items: { type: 'string' },
				additionalProperties: {
					type: 'string',
					'x-flowdular-secret': true,
				},
			} as JsonSchemaV1,
		},
		{
			name: 'array item',
			schema: {
				type: 'array',
				properties: { '0': { type: 'string' } },
				items: { type: 'string', 'x-flowdular-secret': true },
			} as JsonSchemaV1,
		},
	])(
		'refuses and redacts an action literal on a numeric $name',
		({ schema }) => {
			const graph: WorkflowGraphV1 = {
				schemaVersion: 1,
				nodes: [
					{
						id: 'action.write',
						label: 'Write',
						type: 'action',
						inputPorts: [{ name: 'input', schemaId: 'action.input' }],
						outputPorts: [],
						action: { actionId: 'test.write', contractVersion: 1 },
						mappings: [
							{
								targetPointer: '/0',
								binding: { kind: 'literal', value: 'needle-secret' },
							},
						],
					},
				],
				edges: [],
				schemas: { 'action.input': schema },
				layout: { 'action.write': { x: 0, y: 0 } },
			};
			expect(actionBindingDiagnostics(graph, () => schema)).toContainEqual(
				expect.objectContaining({
					code: 'WORKFLOW_ACTION_SECRET_BINDING',
					targetPointer: '/0',
				}),
			);
			expect(
				JSON.stringify(projectSafeGraph(graph, () => schema).graph),
			).not.toContain('needle-secret');
		},
	);

	it('redacts a legacy action literal when its pinned input schema is missing', () => {
		const currentDescriptor: JsonSchemaV1 = {
			type: 'object',
			properties: { credential: { type: 'string' } },
		};
		const graph: WorkflowGraphV1 = {
			schemaVersion: 1,
			nodes: [
				{
					id: 'action.write',
					label: 'Write',
					type: 'action',
					inputPorts: [{ name: 'input', schemaId: 'missing.snapshot' }],
					outputPorts: [],
					action: { actionId: 'test.write', contractVersion: 1 },
					mappings: [
						{
							targetPointer: '/credential',
							binding: {
								kind: 'literal',
								value: 'legacy-secret-token',
							},
						},
					],
				},
			],
			edges: [],
			schemas: {},
			layout: { 'action.write': { x: 0, y: 0 } },
		};
		expect(
			actionBindingDiagnostics(graph, () => currentDescriptor),
		).toContainEqual(
			expect.objectContaining({
				code: 'WORKFLOW_ACTION_SCHEMA_UNAVAILABLE',
				targetPointer: '/credential',
			}),
		);
		expect(
			JSON.stringify(projectSafeGraph(graph, () => currentDescriptor).graph),
		).not.toContain('legacy-secret-token');
		expect(
			actionBindingDiagnostics(
				{ ...graph, schemas: { 'missing.snapshot': currentDescriptor } },
				() => currentDescriptor,
			),
		).toEqual([]);
	});

	it('redacts a legacy non-action literal when its schema is missing', () => {
		const graph: WorkflowGraphV1 = {
			...graphWithMapping({
				targetPointer: '/credential',
				binding: { kind: 'literal', value: 'legacy-secret-token' },
			}),
			schemas: {},
		};
		expect(
			JSON.stringify(projectSafeGraph(graph, () => undefined).graph),
		).not.toContain('legacy-secret-token');
	});
});
