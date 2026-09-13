import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@flowdular/client/i18n';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowNodeExecution } from '../src/domain/types.ts';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import {
	addWorkflowNode,
	connectWorkflowNodes,
	emptyWorkflowGraph,
	evidenceText,
	moveWorkflowNode,
	proposeWorkflowConnection,
	simulationFixtures,
	workflowOutline,
	workflowOverlay,
	workflowChangeSummary,
} from '../src/client/canvas-model.ts';
import {
	FIRST_PAGE,
	FIRST_PAGE_REQUEST,
	listOrder,
	pageOpened,
	pageRequest,
	searchPending,
} from '../src/client/state.ts';

function graphWith(type: 'input' | 'agent' | 'gate' | 'merge' | 'output') {
	return addWorkflowNode(emptyWorkflowGraph(), type, type);
}

afterEach(() => setActiveLocale('en'));

describe('workflow canvas model', () => {
	it('creates stable node ids and clamps dragged layout to the canvas origin', () => {
		const first = graphWith('input');
		const second = addWorkflowNode(first.graph, 'input', 'second');
		expect(first.nodeId).toBe('input.n1');
		expect(second.nodeId).toBe('input.n2');
		expect(
			moveWorkflowNode(second.graph, second.nodeId, -12, 18).layout[
				second.nodeId
			],
		).toEqual({ x: 0, y: 18 });
	});

	it('refuses cycles and a second edge into a normal input', () => {
		const input = graphWith('input');
		const gate = addWorkflowNode(input.graph, 'gate', 'gate');
		const output = addWorkflowNode(gate.graph, 'output', 'output');
		const connected = connectWorkflowNodes(
			connectWorkflowNodes(
				output.graph,
				input.nodeId,
				'data',
				gate.nodeId,
				'input',
			),
			gate.nodeId,
			'pass',
			output.nodeId,
			'input',
		);
		expect(
			proposeWorkflowConnection(
				connected,
				output.nodeId,
				'input',
				input.nodeId,
				'data',
			).code,
		).toBe('SOURCE_PORT_MISSING');
		expect(
			proposeWorkflowConnection(
				connected,
				gate.nodeId,
				'fail',
				output.nodeId,
				'input',
			).code,
		).toBe('TARGET_CARDINALITY');
		const cycleInput = graphWith('input');
		const merge = addWorkflowNode(cycleInput.graph, 'merge', 'merge');
		const compatibleMerge = {
			...merge.graph,
			nodes: merge.graph.nodes.map((node) =>
				node.id === merge.nodeId
					? {
							...node,
							outputPorts: [{ name: 'data', schemaId: 'workflow.data' }],
						}
					: node,
			),
		};
		const cycleGate = addWorkflowNode(compatibleMerge, 'gate', 'cycle gate');
		const withSecond = connectWorkflowNodes(
			connectWorkflowNodes(
				cycleGate.graph,
				cycleInput.nodeId,
				'data',
				merge.nodeId,
				'items',
			),
			merge.nodeId,
			'data',
			cycleGate.nodeId,
			'input',
		);
		expect(
			proposeWorkflowConnection(
				withSecond,
				cycleGate.nodeId,
				'pass',
				merge.nodeId,
				'items',
			).code,
		).toBe('CYCLE');
	});

	it('returns a deterministic keyboard outline', () => {
		const input = graphWith('input');
		const gate = addWorkflowNode(input.graph, 'gate', 'gate');
		const output = addWorkflowNode(gate.graph, 'output', 'output');
		const graph = connectWorkflowNodes(
			connectWorkflowNodes(
				output.graph,
				input.nodeId,
				'data',
				gate.nodeId,
				'input',
			),
			gate.nodeId,
			'pass',
			output.nodeId,
			'input',
		);
		expect(workflowOutline(graph).map((node) => node.id)).toEqual([
			'input.n1',
			'gate.n1',
			'output.n1',
		]);
	});

	it('builds fixtures only for nondeterministic nodes', () => {
		const input = graphWith('input');
		const agent = addWorkflowNode(input.graph, 'agent', 'agent');
		const gate = addWorkflowNode(agent.graph, 'gate', 'gate');
		expect(simulationFixtures(gate.graph)).toEqual([
			{
				nodeId: agent.nodeId,
				outcomePort: 'success',
				output: {},
				simulatedDurationMs: 500,
			},
		]);
	});

	it('projects persisted execution evidence without driving execution', () => {
		const execution: WorkflowNodeExecution = {
			nodeId: 'agent.1',
			status: 'waiting-child',
			latestAttempt: 1,
			selectedOutcomePort: null,
			nextAttemptAt: null,
			readyAt: 1,
			startedAt: 2,
			settledAt: null,
			attempts: [],
		};
		expect(workflowOverlay([execution], [])).toEqual({
			nodes: { 'agent.1': 'waiting-child' },
			edges: {},
		});
		expect(
			evidenceText({
				version: 1,
				state: 'redacted',
				schemaId: 'workflow.data',
				hash: 'safe-hash',
				originalByteSize: 42,
				reason: 'secret',
			}),
		).toBe('[redacted: secret]');
	});

	it('separates semantic graph changes from layout-only changes', () => {
		const input = graphWith('input');
		const moved = moveWorkflowNode(input.graph, input.nodeId, 220, 140);
		expect(workflowChangeSummary(input.graph, moved)).toEqual({
			semanticChanged: false,
			layoutChanged: true,
		});
		const output = addWorkflowNode(moved, 'output', 'output');
		expect(workflowChangeSummary(moved, output.graph)).toEqual({
			semanticChanged: true,
			layoutChanged: true,
		});
	});
});

describe('workflow client translations', () => {
	it('ships every workflow key in English and Polish without raw-key fallbacks', () => {
		expect(Object.keys(translationsPl).sort()).toEqual(
			Object.keys(translationsEn).sort(),
		);
		registerModuleTranslations([
			{
				moduleId: 'workflows.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		for (const locale of ['en', 'pl']) {
			setActiveLocale(locale);
			for (const key of Object.keys(translationsEn)) {
				expect(t('workflows.' + key), `${locale}:${key}`).not.toBe(
					'workflows.' + key,
				);
			}
		}
	});
});

describe('workflow list paging state', () => {
	/* Forward pages open with the cursor the page before handed back, an
	   earlier page reopens with the cursor stored for it, and a reader can only
	   step one page past what was walked. */
	it('keeps one cursor per page walked and steps back through them', () => {
		expect(pageRequest(FIRST_PAGE, 0)).toEqual(FIRST_PAGE_REQUEST);
		expect(pageRequest(FIRST_PAGE, 1)).toBeNull();

		const first = pageOpened(FIRST_PAGE, FIRST_PAGE_REQUEST, 'c1');
		expect(first).toEqual({ pageIndex: 0, cursors: [''], nextCursor: 'c1' });
		expect(pageRequest(first, 2)).toBeNull();
		const toSecond = pageRequest(first, 1)!;
		expect(toSecond).toEqual({ pageIndex: 1, cursor: 'c1' });

		const second = pageOpened(first, toSecond, 'c2');
		const toThird = pageRequest(second, 2)!;
		expect(toThird).toEqual({ pageIndex: 2, cursor: 'c2' });
		const third = pageOpened(second, toThird, null);
		expect(third.cursors).toEqual(['', 'c1', 'c2']);
		expect(pageRequest(third, 3)).toBeNull();

		expect(pageRequest(third, 1)).toEqual({ pageIndex: 1, cursor: 'c1' });
		expect(pageRequest(third, 0)).toEqual(FIRST_PAGE_REQUEST);
		/* Stepping back keeps the pages before, and the page reopened hands back
		   its own next cursor again. */
		const back = pageOpened(third, pageRequest(third, 1)!, 'c2-again');
		expect(back).toEqual({
			pageIndex: 1,
			cursors: ['', 'c1'],
			nextCursor: 'c2-again',
		});
	});

	/* A filter or sort change asks for the first page again: the stack starts
	   over from the request the screen sends, whatever it held before. */
	it('resets to the first page when a listing is reloaded from the start', () => {
		const deep = pageOpened(
			pageOpened(FIRST_PAGE, FIRST_PAGE_REQUEST, 'c1'),
			{ pageIndex: 1, cursor: 'c1' },
			'c2',
		);
		expect(pageOpened(deep, FIRST_PAGE_REQUEST, 'other')).toEqual({
			pageIndex: 0,
			cursors: [''],
			nextCursor: 'other',
		});
	});

	it('maps the sorted column to a server sort key or falls back to the default', () => {
		const columns = { workflow: 'name', updated: 'updatedAt' } as const;
		const fallback = { sort: 'name', direction: 'asc' } as const;
		expect(listOrder([], columns, fallback)).toEqual(fallback);
		expect(
			listOrder([{ key: 'updated', desc: true }], columns, fallback),
		).toEqual({ sort: 'updatedAt', direction: 'desc' });
		expect(
			listOrder([{ key: 'workflow', desc: false }], columns, fallback),
		).toEqual({ sort: 'name', direction: 'asc' });
		expect(
			listOrder([{ key: 'status', desc: true }], columns, fallback),
		).toEqual(fallback);
	});

	it('holds a typed term pending until a page was loaded with it', () => {
		expect(searchPending('invoice', '')).toBe(true);
		expect(searchPending('invoice ', 'invoice')).toBe(false);
		expect(searchPending('   ', '')).toBe(false);
		expect(searchPending('', 'invoice')).toBe(true);
	});
});
