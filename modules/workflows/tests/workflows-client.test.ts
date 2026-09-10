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
