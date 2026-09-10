import { describe, expect, it } from 'vitest';
import {
	canvasPoint,
	connectionPath,
	draggedNode,
	fitCanvas,
	snapPoint,
	zoomCanvas,
} from '../src/client/viewport.ts';
import { addConnectedNode } from '../src/client/connected-node.ts';
import {
	suggestedWorkflowKey,
	WORKFLOW_KEY_PATTERN,
} from '../src/client/create-model.ts';
import {
	addWorkflowNode,
	emptyWorkflowGraph,
	moveWorkflowNode,
} from '../src/client/canvas-model.ts';

describe('workflow viewport', () => {
	it('keeps the pointer anchored while zooming and clamps zoom', () => {
		const view = { x: -200, y: 50, zoom: 0.5 };
		const anchor = { x: 300, y: 120 };
		for (const requested of [0.01, 0.75, 20]) {
			const next = zoomCanvas(view, requested, anchor);
			expect(canvasPoint(anchor, next)).toEqual(canvasPoint(anchor, view));
			expect(next.zoom).toBeGreaterThanOrEqual(0.25);
			expect(next.zoom).toBeLessThanOrEqual(2);
		}
		expect(zoomCanvas(view, NaN, anchor)).toBe(view);
	});
	it('moves nodes in world coordinates at different zoom levels without accumulating deltas', () => {
		const origin = { x: 100, y: 100 };
		expect(draggedNode(origin, { x: 50, y: -10 }, 0.5)).toEqual({
			x: 200,
			y: 80,
		});
		expect(draggedNode(origin, { x: 60, y: -10 }, 0.5)).toEqual({
			x: 220,
			y: 80,
		});
		expect(draggedNode(origin, { x: 50, y: -500 }, 2)).toEqual({
			x: 125,
			y: 0,
		});
	});
	it('fits distant nodes and handles an empty or hidden canvas', () => {
		const a = addWorkflowNode(emptyWorkflowGraph(), 'input', 'Input');
		const b = addWorkflowNode(a.graph, 'output', 'Output');
		const graph = moveWorkflowNode(b.graph, b.nodeId, 1400, 800);
		const fit = fitCanvas(graph, 900, 600);
		for (const node of graph.nodes) {
			const p = graph.layout[node.id]!;
			expect(p.x * fit.zoom + fit.x).toBeGreaterThanOrEqual(0);
			expect((p.x + 216) * fit.zoom + fit.x).toBeLessThanOrEqual(900);
		}
		expect(fitCanvas(emptyWorkflowGraph(), 900, 600)).toEqual({
			x: 0,
			y: 0,
			zoom: 1,
		});
		expect(fitCanvas(graph, 0, 0)).toEqual({ x: 0, y: 0, zoom: 1 });
	});
	it('routes orthogonal lines on the grid, including backwards connections', () => {
		expect(connectionPath({ x: 200, y: 50 }, { x: 100, y: 80 })).toBe(
			'M 200 50 H 224 V 144 H 76 V 80 H 100',
		);
		expect(connectionPath({ x: 200, y: 50 }, { x: 500, y: 80 })).toBe(
			'M 200 50 H 360 V 80 H 500',
		);
		expect(snapPoint({ x: 101, y: -20 })).toEqual({ x: 96, y: 0 });
	});
});

describe('connected node creation', () => {
	it('adds and connects a matching step in one immutable graph update', () => {
		const source = addWorkflowNode(emptyWorkflowGraph(), 'input', 'Input');
		const request = {
			position: { x: 501, y: 201 },
			source: { nodeId: source.nodeId, port: 'data' },
		};
		for (const type of [
			'agent',
			'agent-decision',
			'gate',
			'validator',
			'action',
			'merge',
			'output',
		] as const) {
			const added = addConnectedNode(source.graph, type, type, request)!;
			expect(added.graph.nodes).toHaveLength(2);
			expect(added.graph.edges).toHaveLength(1);
			expect(added.graph.edges[0]?.source).toEqual(request.source);
			expect(added.graph.edges[0]?.target.nodeId).toBe(added.nodeId);
			expect(added.graph.layout[added.nodeId]).toEqual({ x: 504, y: 192 });
		}
		expect(source.graph.nodes).toHaveLength(1);
		expect(source.graph.edges).toHaveLength(0);
	});
	it('rejects missing, incompatible and input-only targets without leaving an orphan', () => {
		const source = addWorkflowNode(emptyWorkflowGraph(), 'agent', 'Agent');
		const request = {
			position: { x: 200, y: 200 },
			source: { nodeId: source.nodeId, port: 'success' },
		};
		expect(
			addConnectedNode(source.graph, 'input', 'Input', request),
		).toBeNull();
		expect(
			addConnectedNode(source.graph, 'agent', 'Agent', {
				...request,
				source: { ...request.source, port: 'failure' },
			}),
		).toBeNull();
		expect(
			addConnectedNode(source.graph, 'output', 'Output', {
				...request,
				source: { nodeId: 'gone', port: 'success' },
			}),
		).toBeNull();
		expect(source.graph.nodes).toHaveLength(1);
	});
});

describe('workflow create form contract', () => {
	it('suggests tenant-local slugs from business names', () => {
		expect(suggestedWorkflowKey(' Analiza ryzyka płatności ')).toBe(
			'analiza-ryzyka-platnosci',
		);
		expect(suggestedWorkflowKey('claims.review')).toBe('claims-review');
		expect(suggestedWorkflowKey('123 Risk')).toBe('risk');
		expect(suggestedWorkflowKey('x'.repeat(200))).toHaveLength(120);
	});
	it('uses a browser v-mode pattern matching the server slug contract', () => {
		const pattern = new RegExp(`^(?:${WORKFLOW_KEY_PATTERN})$`, 'v');
		for (const value of ['claims-review', 'abc', 'a'.repeat(120)])
			expect(pattern.test(value)).toBe(true);
		for (const value of [
			'claims.review',
			'A-flow',
			'a',
			'a'.repeat(121),
			'white space',
		])
			expect(pattern.test(value)).toBe(false);
	});
});
