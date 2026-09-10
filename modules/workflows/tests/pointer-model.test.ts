import { describe, expect, it } from 'vitest';
import {
	filterPointers,
	pointerCatalog,
	sourcePointerCatalog,
} from '../src/client/pointer-model.ts';
import { upstreamPorts } from '../src/client/mapping-model.ts';
import {
	addWorkflowNode,
	connectWorkflowNodes,
	emptyWorkflowGraph,
} from '../src/client/canvas-model.ts';
import { readJsonPointer } from '../src/domain/graph.ts';
import type { JsonSchemaV1 } from '../src/domain/types.ts';

describe('schema pointer suggestions', () => {
	it('discovers nested fields, labels, descriptions, types and required ancestors', () => {
		const catalog = pointerCatalog({
			type: 'object',
			additionalProperties: false,
			required: ['customer'],
			properties: {
				customer: {
					type: 'object',
					additionalProperties: false,
					required: ['name'],
					properties: {
						name: {
							type: 'string',
							title: 'Customer name',
							description: 'Legal name',
						},
						age: { type: 'integer' },
					},
				},
				optional: {
					type: 'object',
					additionalProperties: false,
					required: ['child'],
					properties: { child: { type: 'boolean' } },
				},
			},
		});
		expect(catalog.incomplete).toBe(false);
		expect(
			catalog.entries.find((entry) => entry.pointer === '/customer/name'),
		).toMatchObject({
			label: 'Customer name',
			type: 'string',
			description: 'Legal name',
			required: true,
		});
		expect(
			catalog.entries.find((entry) => entry.pointer === '/optional/child')
				?.required,
		).toBe(false);
		expect(
			filterPointers(catalog.entries, 'legal name').map(
				(entry) => entry.pointer,
			),
		).toEqual(['/customer/name']);
		expect(
			filterPointers(catalog.entries, 'integer').map((entry) => entry.pointer),
		).toEqual(['/customer/age']);
	});
	it('uses real RFC6901 escaping including empty keys and root', () => {
		const catalog = pointerCatalog({
			type: 'object',
			properties: {
				'a/b': { type: 'object', properties: { '~': { type: 'number' } } },
				'': { type: 'string' },
			},
		});
		const data = { 'a/b': { '~': 42 }, '': 'empty' };
		expect(catalog.entries.map((entry) => entry.pointer)).toEqual([
			'',
			'/a~1b',
			'/a~1b/~0',
			'/',
		]);
		for (const entry of catalog.entries)
			expect(readJsonPointer(data, entry.pointer)).not.toBeUndefined();
	});
	it('marks array descendants as examples and never invents wildcard pointers', () => {
		const schema: JsonSchemaV1 = {
			type: 'array',
			items: { type: 'object', properties: { amount: { type: 'number' } } },
		};
		expect(
			pointerCatalog(schema).entries.find(
				(entry) => entry.pointer === '/0/amount',
			),
		).toMatchObject({ arrayExample: true, required: false });
		expect(
			pointerCatalog(schema, false).entries.map((entry) => entry.pointer),
		).toEqual(['']);
	});
	it('identifies unknown/open schemas without inventing output fields', () => {
		for (const schema of [
			undefined,
			{},
			{ type: 'object' },
			{ type: 'array' },
			{ $ref: '#/unknown' },
		])
			expect(pointerCatalog(schema).incomplete).toBe(true);
		expect(pointerCatalog(undefined).entries).toHaveLength(1);
	});
	it('bounds huge and cyclic schemas, omits unsafe keys and never returns default values', () => {
		const properties = Object.fromEntries(
			Array.from({ length: 2000 }, (_, index) => [
				'field' + index,
				{ type: 'string', default: 'secret' },
			]),
		);
		const catalog = pointerCatalog({ type: 'object', properties });
		expect(catalog.entries).toHaveLength(500);
		expect(catalog.truncated).toBe(true);
		expect(JSON.stringify(catalog)).not.toContain('secret');
		const recursive: Record<string, unknown> = { type: 'object' };
		recursive.properties = { child: recursive };
		expect(pointerCatalog(recursive as JsonSchemaV1).truncated).toBe(true);
		expect(
			pointerCatalog({
				properties: JSON.parse(
					'{"__proto__":{},"constructor":{},"prototype":{},"safe":{}}',
				),
			}).entries.map((entry) => entry.pointer),
		).toEqual(['', '/safe']);
	});
	it('gets the selected output schema and only offers upstream source steps', () => {
		const input = addWorkflowNode(emptyWorkflowGraph(), 'input', 'Input');
		const agent = addWorkflowNode(input.graph, 'agent', 'Agent');
		const output = addWorkflowNode(agent.graph, 'output', 'Output');
		const unrelated = addWorkflowNode(output.graph, 'input', 'Unrelated');
		const graph = connectWorkflowNodes(
			connectWorkflowNodes(
				unrelated.graph,
				input.nodeId,
				'data',
				agent.nodeId,
				'input',
			),
			agent.nodeId,
			'success',
			output.nodeId,
			'input',
		);
		const sources = upstreamPorts(graph, output.nodeId);
		expect(
			sources.some(
				(source) => source.nodeId === agent.nodeId && source.port === 'failure',
			),
		).toBe(false);
		expect(
			sources.some(
				(source) => source.nodeId === agent.nodeId && source.port === 'success',
			),
		).toBe(true);
		expect(sources.some((source) => source.nodeId === input.nodeId)).toBe(true);
		expect(
			sources.some((source) =>
				[output.nodeId, unrelated.nodeId].includes(source.nodeId),
			),
		).toBe(false);
		expect(
			sourcePointerCatalog(graph, agent.nodeId + '|failure').entries.map(
				(entry) => entry.pointer,
			),
		).toContain('/code');
		expect(sourcePointerCatalog(graph, 'missing|data').incomplete).toBe(true);
	});
});
