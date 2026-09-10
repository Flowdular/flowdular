import { describe, expect, it } from 'vitest';
import {
	applyWorkflowMappings,
	compileWorkflowGraph,
	evaluateGate,
	readJsonPointer,
	validateJsonSchema,
} from '../src/domain/graph.ts';
import {
	addWorkflowNode,
	connectWorkflowNodes,
	emptyWorkflowGraph,
} from '../src/client/canvas-model.ts';
import type {
	WorkflowGraphV1,
	WorkflowTargetMappingV1,
} from '../src/domain/types.ts';

describe('workflow data contract', () => {
	it('distinguishes the document root, empty keys, escaped keys and strict array indexes', () => {
		const data = { '': 'empty', 'a/b': { '~': 3 }, items: ['first', 'second'] };
		expect(readJsonPointer(data, '')).toBe(data);
		expect(readJsonPointer(data, '/')).toBe('empty');
		expect(readJsonPointer(data, '/a~1b/~0')).toBe(3);
		expect(readJsonPointer(data, '/items/1')).toBe('second');
		for (const pointer of [
			'/items/01',
			'/items/',
			'/items/+1',
			'/items/1e0',
			'/toString',
			'/__proto__',
		])
			expect(readJsonPointer(data, pointer)).toBeUndefined();
	});
	it('never writes through inherited properties or changes Object.prototype', () => {
		const mapping: WorkflowTargetMappingV1 = {
			targetPointer: '/__proto__/workflowPolluted',
			binding: { kind: 'literal', value: true },
		};
		expect(() => applyWorkflowMappings({}, [mapping], new Map())).toThrow(
			'WORKFLOW_MAPPING_TARGET_INVALID',
		);
		expect(Object.prototype).not.toHaveProperty('workflowPolluted');
	});
	it('preserves JSON null but refuses a missing source even when reading the root', () => {
		const mapping: WorkflowTargetMappingV1 = {
			targetPointer: '/value',
			binding: {
				kind: 'path',
				sourceNodeId: 'input.1',
				sourcePort: 'data',
				pointer: '',
			},
		};
		expect(
			applyWorkflowMappings({}, [mapping], new Map([['input.1:data', null]])),
		).toEqual({ value: null });
		expect(() => applyWorkflowMappings({}, [mapping], new Map())).toThrow(
			'WORKFLOW_MAPPING_SOURCE_INVALID',
		);
	});
	it('supports literal, path and single-pass template mappings without mutating input', () => {
		const source = { amount: 42, name: '{{ hidden }}' };
		const mappings: WorkflowTargetMappingV1[] = [
			{ targetPointer: '/fixed', binding: { kind: 'literal', value: false } },
			{
				targetPointer: '/amount',
				binding: {
					kind: 'path',
					sourceNodeId: 'input.1',
					sourcePort: 'data',
					pointer: '/amount',
				},
			},
			{
				targetPointer: '/message',
				binding: {
					kind: 'template',
					template: 'Hello {{ name }}',
					variables: [
						{
							name: 'name',
							sourceNodeId: 'input.1',
							sourcePort: 'data',
							pointer: '/name',
						},
					],
				},
			},
		];
		expect(
			applyWorkflowMappings(
				source,
				mappings,
				new Map([['input.1:data', source]]),
			),
		).toEqual({ fixed: false, amount: 42, message: 'Hello {{ hidden }}' });
		expect(source).toEqual({ amount: 42, name: '{{ hidden }}' });
	});
	it('does not coerce strings or missing values in boolean gates', () => {
		expect(() =>
			evaluateGate({ op: 'not', value: { op: 'literal', value: 'false' } }, {}),
		).toThrow('WORKFLOW_GATE_TYPE_MISMATCH');
		expect(() =>
			evaluateGate(
				{
					op: 'eq',
					left: { op: 'path', pointer: '/missing' },
					right: { op: 'path', pointer: '/also-missing' },
				},
				{},
			),
		).toThrow('WORKFLOW_GATE_PATH_MISSING');
		expect(
			evaluateGate(
				{ op: 'exists', value: { op: 'path', pointer: '/missing' } },
				{},
			),
		).toBe(false);
	});
	it('checks required and additional properties even when no properties map is declared', () => {
		expect(
			validateJsonSchema({}, { type: 'object', required: ['name'] }),
		).toContainEqual({ path: '/name', code: 'required' });
		expect(
			validateJsonSchema(
				{ name: 'Ada' },
				{ type: 'object', additionalProperties: false },
			),
		).toContainEqual({ path: '/name', code: 'additionalProperties' });
	});
	it('rejects mappings from an earlier unrelated branch and missing ports', () => {
		const input = addWorkflowNode(emptyWorkflowGraph(), 'input', 'Input');
		const a = addWorkflowNode(input.graph, 'output', 'A');
		const b = addWorkflowNode(a.graph, 'output', 'B');
		const graph = connectWorkflowNodes(
			connectWorkflowNodes(b.graph, input.nodeId, 'data', a.nodeId, 'input'),
			input.nodeId,
			'data',
			b.nodeId,
			'input',
		);
		for (const source of [
			{ sourceNodeId: a.nodeId, sourcePort: 'data' },
			{ sourceNodeId: input.nodeId, sourcePort: 'missing' },
		]) {
			const mapped: WorkflowGraphV1 = {
				...graph,
				nodes: graph.nodes.map((node) =>
					node.id === b.nodeId
						? {
								...node,
								mappings: [
									{
										targetPointer: '',
										binding: { kind: 'path', ...source, pointer: '' },
									},
								],
							}
						: node,
				),
			};
			expect(
				compileWorkflowGraph(mapped).issues.some(
					(issue) => issue.code === 'WORKFLOW_MAPPING_SOURCE_INVALID',
				),
			).toBe(true);
		}
	});
});
