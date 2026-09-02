import type {
	JsonValue,
	WorkflowEdgeTransfer,
	WorkflowEdgeV1,
	WorkflowGraphV1,
	WorkflowNodeExecution,
	WorkflowNodeV1,
	WorkflowPayloadEvidenceV1,
	WorkflowSimulationFixture,
} from '../domain/types.ts';

export const WORKFLOW_NODE_TYPES = [
	'input',
	'agent',
	'agent-decision',
	'gate',
	'validator',
	'action',
	'merge',
	'output',
] as const;

export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

export interface ConnectionProposal {
	readonly valid: boolean;
	readonly code?:
		| 'SAME_NODE'
		| 'SOURCE_PORT_MISSING'
		| 'TARGET_PORT_MISSING'
		| 'TARGET_CARDINALITY'
		| 'DUPLICATE_EDGE'
		| 'SCHEMA_INCOMPATIBLE'
		| 'CYCLE';
}

export interface WorkflowOverlay {
	readonly nodes: Readonly<Record<string, WorkflowNodeExecution['status']>>;
	readonly edges: Readonly<Record<string, WorkflowEdgeTransfer['state']>>;
}

export interface WorkflowChangeSummary {
	readonly semanticChanged: boolean;
	readonly layoutChanged: boolean;
}

const DATA_SCHEMA = 'workflow.data';
const ERROR_SCHEMA = 'workflow.error';

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`;
	}
	if (value !== null && typeof value === 'object') {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

export function workflowChangeSummary(
	previous: WorkflowGraphV1 | null,
	current: WorkflowGraphV1,
): WorkflowChangeSummary {
	if (!previous) return { semanticChanged: true, layoutChanged: true };
	return {
		semanticChanged:
			canonicalJson({
				nodes: previous.nodes,
				edges: previous.edges,
				schemas: previous.schemas,
			}) !==
			canonicalJson({
				nodes: current.nodes,
				edges: current.edges,
				schemas: current.schemas,
			}),
		layoutChanged:
			canonicalJson(previous.layout) !== canonicalJson(current.layout),
	};
}

export function emptyWorkflowGraph(): WorkflowGraphV1 {
	return {
		schemaVersion: 1,
		nodes: [],
		edges: [],
		schemas: {
			[DATA_SCHEMA]: { type: 'object', additionalProperties: true },
			[ERROR_SCHEMA]: {
				type: 'object',
				properties: { code: { type: 'string' }, message: { type: 'string' } },
			},
		},
		layout: {},
	};
}

function nextIdentifier(
	graph: WorkflowGraphV1,
	type: WorkflowNodeType,
): string {
	let sequence = 1;
	const prefix = type.replace('-', '.');
	while (graph.nodes.some((node) => node.id === `${prefix}.${sequence}`)) {
		sequence += 1;
	}
	return `${prefix}.${sequence}`;
}

function nodeTemplate(
	type: WorkflowNodeType,
	id: string,
	label: string,
): WorkflowNodeV1 {
	const data = { name: 'data', schemaId: DATA_SCHEMA } as const;
	const input = { name: 'input', schemaId: DATA_SCHEMA } as const;
	const success = { name: 'success', schemaId: DATA_SCHEMA } as const;
	const failure = { name: 'failure', schemaId: ERROR_SCHEMA } as const;
	switch (type) {
		case 'input':
			return { id, label, type, inputPorts: [], outputPorts: [data] };
		case 'agent':
			return {
				id,
				label,
				type,
				inputPorts: [input],
				outputPorts: [success, failure],
				agent: { agentId: '', revision: 1 },
				toolGrants: [],
				outputSchemaId: DATA_SCHEMA,
			};
		case 'agent-decision':
			return {
				id,
				label,
				type,
				inputPorts: [input],
				outputPorts: [
					{ name: 'pass', schemaId: DATA_SCHEMA },
					{ name: 'fail', schemaId: DATA_SCHEMA },
					failure,
				],
				agent: { agentId: '', revision: 1 },
				toolGrants: [],
				passSchemaId: DATA_SCHEMA,
				failSchemaId: DATA_SCHEMA,
			};
		case 'gate':
			return {
				id,
				label,
				type,
				inputPorts: [input],
				outputPorts: [
					{ name: 'pass', schemaId: DATA_SCHEMA },
					{ name: 'fail', schemaId: DATA_SCHEMA },
				],
				logicVersion: 1,
				expression: {
					op: 'exists',
					value: { op: 'path', pointer: '/' },
				},
			};
		case 'validator':
			return {
				id,
				label,
				type,
				inputPorts: [input],
				outputPorts: [
					{ name: 'pass', schemaId: DATA_SCHEMA },
					{ name: 'fail', schemaId: ERROR_SCHEMA },
				],
				schemaId: DATA_SCHEMA,
			};
		case 'action':
			return {
				id,
				label,
				type,
				inputPorts: [input],
				outputPorts: [success, failure],
				action: { actionId: '', contractVersion: 1 },
			};
		case 'merge':
			return {
				id,
				label,
				type,
				inputPorts: [{ name: 'items', schemaId: DATA_SCHEMA }],
				outputPorts: [data],
				mode: 'all',
			};
		case 'output':
			return { id, label, type, inputPorts: [input], outputPorts: [] };
	}
}

export function addWorkflowNode(
	graph: WorkflowGraphV1,
	type: WorkflowNodeType,
	label: string,
): { readonly graph: WorkflowGraphV1; readonly nodeId: string } {
	const id = nextIdentifier(graph, type);
	const index = graph.nodes.length;
	return {
		nodeId: id,
		graph: {
			...graph,
			nodes: [...graph.nodes, nodeTemplate(type, id, label)],
			layout: {
				...graph.layout,
				[id]: {
					x: 56 + (index % 3) * 248,
					y: 52 + Math.floor(index / 3) * 160,
				},
			},
		},
	};
}

export function moveWorkflowNode(
	graph: WorkflowGraphV1,
	nodeId: string,
	x: number,
	y: number,
): WorkflowGraphV1 {
	if (!graph.nodes.some((node) => node.id === nodeId)) return graph;
	return {
		...graph,
		layout: {
			...graph.layout,
			[nodeId]: {
				x: Math.max(0, Math.round(x)),
				y: Math.max(0, Math.round(y)),
			},
		},
	};
}

export function replaceWorkflowNode(
	graph: WorkflowGraphV1,
	node: WorkflowNodeV1,
): WorkflowGraphV1 {
	return {
		...graph,
		nodes: graph.nodes.map((current) =>
			current.id === node.id ? node : current,
		),
	};
}

export function removeWorkflowNode(
	graph: WorkflowGraphV1,
	nodeId: string,
): WorkflowGraphV1 {
	const { [nodeId]: _removed, ...layout } = graph.layout;
	return {
		...graph,
		nodes: graph.nodes.filter((node) => node.id !== nodeId),
		edges: graph.edges.filter(
			(edge) => edge.source.nodeId !== nodeId && edge.target.nodeId !== nodeId,
		),
		layout,
	};
}

function reaches(
	graph: WorkflowGraphV1,
	from: string,
	target: string,
): boolean {
	const pending = [from];
	const visited = new Set<string>();
	while (pending.length > 0) {
		const current = pending.shift()!;
		if (current === target) return true;
		if (visited.has(current)) continue;
		visited.add(current);
		for (const edge of graph.edges) {
			if (edge.source.nodeId === current) pending.push(edge.target.nodeId);
		}
	}
	return false;
}

export function proposeWorkflowConnection(
	graph: WorkflowGraphV1,
	sourceNodeId: string,
	sourcePort: string,
	targetNodeId: string,
	targetPort: string,
): ConnectionProposal {
	if (sourceNodeId === targetNodeId) return { valid: false, code: 'SAME_NODE' };
	const source = graph.nodes.find((node) => node.id === sourceNodeId);
	const target = graph.nodes.find((node) => node.id === targetNodeId);
	const output = source?.outputPorts.find((port) => port.name === sourcePort);
	const input = target?.inputPorts.find((port) => port.name === targetPort);
	if (!output) return { valid: false, code: 'SOURCE_PORT_MISSING' };
	if (!input) return { valid: false, code: 'TARGET_PORT_MISSING' };
	if (
		target?.type !== 'merge' &&
		graph.edges.some(
			(edge) =>
				edge.target.nodeId === targetNodeId && edge.target.port === targetPort,
		)
	) {
		return { valid: false, code: 'TARGET_CARDINALITY' };
	}
	if (
		graph.edges.some(
			(edge) =>
				edge.source.nodeId === sourceNodeId &&
				edge.source.port === sourcePort &&
				edge.target.nodeId === targetNodeId &&
				edge.target.port === targetPort,
		)
	) {
		return { valid: false, code: 'DUPLICATE_EDGE' };
	}
	if (output.schemaId !== input.schemaId) {
		return { valid: false, code: 'SCHEMA_INCOMPATIBLE' };
	}
	if (reaches(graph, targetNodeId, sourceNodeId)) {
		return { valid: false, code: 'CYCLE' };
	}
	return { valid: true };
}

export function connectWorkflowNodes(
	graph: WorkflowGraphV1,
	sourceNodeId: string,
	sourcePort: string,
	targetNodeId: string,
	targetPort: string,
): WorkflowGraphV1 {
	if (
		!proposeWorkflowConnection(
			graph,
			sourceNodeId,
			sourcePort,
			targetNodeId,
			targetPort,
		).valid
	)
		return graph;
	let sequence = graph.edges.length + 1;
	let id = `edge.${sequence}`;
	while (graph.edges.some((edge) => edge.id === id)) {
		sequence += 1;
		id = `edge.${sequence}`;
	}
	return {
		...graph,
		edges: [
			...graph.edges,
			{
				id,
				source: { nodeId: sourceNodeId, port: sourcePort },
				target: { nodeId: targetNodeId, port: targetPort },
			},
		],
	};
}

export function removeWorkflowEdge(
	graph: WorkflowGraphV1,
	edgeId: string,
): WorkflowGraphV1 {
	return { ...graph, edges: graph.edges.filter((edge) => edge.id !== edgeId) };
}

export function workflowOutline(
	graph: WorkflowGraphV1,
): readonly WorkflowNodeV1[] {
	const indegree = new Map<string, number>(
		graph.nodes.map((node) => [node.id, 0]),
	);
	for (const edge of graph.edges) {
		if (indegree.has(edge.target.nodeId)) {
			indegree.set(
				edge.target.nodeId,
				(indegree.get(edge.target.nodeId) ?? 0) + 1,
			);
		}
	}
	const ready = graph.nodes
		.filter((node) => indegree.get(node.id) === 0)
		.map((node) => node.id)
		.sort();
	const ordered: WorkflowNodeV1[] = [];
	while (ready.length > 0) {
		const id = ready.shift()!;
		const node = graph.nodes.find((candidate) => candidate.id === id);
		if (node) ordered.push(node);
		for (const edge of graph.edges.filter(
			(candidate) => candidate.source.nodeId === id,
		)) {
			const next = (indegree.get(edge.target.nodeId) ?? 1) - 1;
			indegree.set(edge.target.nodeId, next);
			if (next === 0) {
				ready.push(edge.target.nodeId);
				ready.sort();
			}
		}
	}
	for (const node of [...graph.nodes].sort((a, b) =>
		a.id.localeCompare(b.id),
	)) {
		if (!ordered.some((current) => current.id === node.id)) ordered.push(node);
	}
	return ordered;
}

export function workflowOverlay(
	nodes: readonly WorkflowNodeExecution[],
	edges: readonly WorkflowEdgeTransfer[],
): WorkflowOverlay {
	return {
		nodes: Object.fromEntries(nodes.map((node) => [node.nodeId, node.status])),
		edges: Object.fromEntries(edges.map((edge) => [edge.edgeId, edge.state])),
	};
}

export function simulationFixtures(
	graph: WorkflowGraphV1,
	durationMs = 500,
): readonly WorkflowSimulationFixture[] {
	return graph.nodes
		.filter((node) => ['agent', 'agent-decision', 'action'].includes(node.type))
		.map((node) => ({
			nodeId: node.id,
			outcomePort: node.type === 'agent-decision' ? 'pass' : 'success',
			output: {} as JsonValue,
			simulatedDurationMs: durationMs,
		}));
}

export function evidenceText(evidence: WorkflowPayloadEvidenceV1): string {
	if (evidence.state === 'available' || evidence.state === 'truncated') {
		return JSON.stringify(evidence.preview ?? null, null, 2);
	}
	return `[${evidence.state}${evidence.reason ? `: ${evidence.reason}` : ''}]`;
}

export function edgeCoordinates(
	edge: WorkflowEdgeV1,
	layout: WorkflowGraphV1['layout'],
): {
	readonly x1: number;
	readonly y1: number;
	readonly x2: number;
	readonly y2: number;
} {
	const source = layout[edge.source.nodeId] ?? { x: 0, y: 0 };
	const target = layout[edge.target.nodeId] ?? { x: 0, y: 0 };
	return {
		x1: source.x + 216,
		y1: source.y + 48,
		x2: target.x,
		y2: target.y + 48,
	};
}
