import type {
	JsonSchemaV1,
	JsonValue,
	WorkflowEdgeTransfer,
	WorkflowGraphV1,
	WorkflowNodeExecution,
	WorkflowPayloadEvidenceV1,
	WorkflowRunDetail,
	WorkflowRunEventV1,
} from '../domain/types.ts';
import {
	safePayloadEvidence,
	schemaHasRestrictedEvidence,
} from './payload-codec.ts';

type EvidenceScope =
	| { readonly kind: 'run-input' }
	| { readonly kind: 'run-output' }
	| { readonly kind: 'node-input'; readonly nodeId: string }
	| { readonly kind: 'node-output'; readonly nodeId: string }
	| { readonly kind: 'edge'; readonly edgeId: string };

function jsonRecord(
	value: JsonValue | undefined,
): value is Readonly<Record<string, JsonValue>> {
	return (
		value !== null &&
		value !== undefined &&
		typeof value === 'object' &&
		!Array.isArray(value)
	);
}

interface EvidenceTaint {
	readonly connectorNodeIds: ReadonlySet<string>;
	readonly legacyConnector: boolean;
	readonly edgesById: ReadonlyMap<string, WorkflowGraphV1['edges'][number]>;
	readonly inputNodeIds: ReadonlySet<string>;
	readonly outputNodeIds: ReadonlySet<string>;
	readonly edgeIds: ReadonlySet<string>;
	readonly runOutput: boolean;
}

const taintByGraph = new WeakMap<WorkflowGraphV1, EvidenceTaint | null>();

interface RestrictedEvidenceTaint {
	readonly nodeIds: ReadonlySet<string>;
	readonly edgeIds: ReadonlySet<string>;
	readonly runInput: boolean;
	readonly runOutput: boolean;
}

const restrictedByGraph = new WeakMap<
	WorkflowGraphV1,
	RestrictedEvidenceTaint | null
>();

function hasActionNode(graph: WorkflowGraphV1): boolean {
	return graph.nodes.some((node) => node.type === 'action');
}

function sourceNodes(graph: WorkflowGraphV1): Map<string, string[]> {
	const consumers = new Map<string, string[]>();
	for (const node of graph.nodes) {
		for (const mapping of node.mappings ?? []) {
			const sources =
				mapping.binding.kind === 'path'
					? [mapping.binding.sourceNodeId]
					: mapping.binding.kind === 'template'
						? mapping.binding.variables.map((entry) => entry.sourceNodeId)
						: [];
			for (const source of sources) {
				const targets = consumers.get(source) ?? [];
				targets.push(node.id);
				consumers.set(source, targets);
			}
		}
	}
	return consumers;
}

function restrictedEvidenceTaint(
	graph: WorkflowGraphV1,
): RestrictedEvidenceTaint | null {
	if (restrictedByGraph.has(graph)) return restrictedByGraph.get(graph) ?? null;
	const restrictedSchemas = new Set(
		Object.entries(graph.schemas)
			.filter(([, schema]) => schemaHasRestrictedEvidence(schema))
			.map(([id]) => id),
	);
	const starts = graph.nodes.filter((node) =>
		[...node.inputPorts, ...node.outputPorts].some((port) =>
			restrictedSchemas.has(port.schemaId),
		),
	);
	if (starts.length === 0) {
		restrictedByGraph.set(graph, null);
		return null;
	}
	const outgoing = new Map<string, WorkflowGraphV1['edges'][number][]>();
	for (const edge of graph.edges) {
		const edges = outgoing.get(edge.source.nodeId) ?? [];
		edges.push(edge);
		outgoing.set(edge.source.nodeId, edges);
	}
	const mappedConsumers = sourceNodes(graph);
	const nodeIds = new Set(starts.map((node) => node.id));
	const edgeIds = new Set<string>();
	const queue = [...nodeIds];
	for (let index = 0; index < queue.length; index++) {
		const source = queue[index]!;
		const reach = (target: string) => {
			if (nodeIds.has(target)) return;
			nodeIds.add(target);
			queue.push(target);
		};
		for (const edge of outgoing.get(source) ?? []) {
			edgeIds.add(edge.id);
			reach(edge.target.nodeId);
		}
		for (const target of mappedConsumers.get(source) ?? []) reach(target);
	}
	const taint = {
		nodeIds,
		edgeIds,
		runInput: starts.some((node) => node.type === 'input'),
		runOutput: graph.nodes.some(
			(node) => node.type === 'output' && nodeIds.has(node.id),
		),
	};
	restrictedByGraph.set(graph, taint);
	return taint;
}

function evidenceTaint(graph: WorkflowGraphV1): EvidenceTaint | null {
	if (taintByGraph.has(graph)) return taintByGraph.get(graph) ?? null;
	const connectorNodeIds = new Set(
		graph.nodes
			.filter(
				(node) =>
					node.type === 'action' && node.action.actionId === 'connectors.call',
			)
			.map((node) => node.id),
	);
	if (connectorNodeIds.size === 0) {
		taintByGraph.set(graph, null);
		return null;
	}
	const outgoing = new Map<string, WorkflowGraphV1['edges'][number][]>();
	const edgesById = new Map<string, WorkflowGraphV1['edges'][number]>();
	for (const edge of graph.edges) {
		edgesById.set(edge.id, edge);
		const edges = outgoing.get(edge.source.nodeId) ?? [];
		edges.push(edge);
		outgoing.set(edge.source.nodeId, edges);
	}
	const mappedConsumers = sourceNodes(graph);
	const inputNodes = new Set(
		graph.nodes.filter((node) => node.type === 'input').map((node) => node.id),
	);
	const inputNodeIds = new Set([...connectorNodeIds, ...inputNodes]);
	const outputNodeIds = new Set(inputNodes);
	const edgeIds = new Set<string>();
	const queue = [...outputNodeIds];
	for (let index = 0; index < queue.length; index++) {
		const source = queue[index]!;
		const reach = (target: string) => {
			inputNodeIds.add(target);
			if (!connectorNodeIds.has(target) && !outputNodeIds.has(target)) {
				outputNodeIds.add(target);
				queue.push(target);
			}
		};
		for (const edge of outgoing.get(source) ?? []) {
			edgeIds.add(edge.id);
			reach(edge.target.nodeId);
		}
		for (const target of mappedConsumers.get(source) ?? []) reach(target);
	}
	const runOutput = graph.nodes.some(
		(node) => node.type === 'output' && inputNodeIds.has(node.id),
	);
	const taint = {
		connectorNodeIds,
		legacyConnector: graph.nodes.some(
			(node) =>
				node.type === 'action' &&
				node.action.actionId === 'connectors.call' &&
				node.action.contractVersion !== 2,
		),
		edgesById,
		inputNodeIds,
		outputNodeIds,
		edgeIds,
		runOutput,
	};
	taintByGraph.set(graph, taint);
	return taint;
}

function masked(
	evidence: WorkflowPayloadEvidenceV1,
): WorkflowPayloadEvidenceV1 {
	if (
		evidence.preview === undefined &&
		(evidence.state === 'absent' ||
			evidence.state === 'expired' ||
			evidence.state === 'truncated')
	)
		return evidence;
	return {
		version: 1,
		state: 'redacted',
		schemaId: evidence.schemaId,
		hash: evidence.hash,
		originalByteSize: evidence.originalByteSize,
		reason: 'secret',
	};
}

function safeConnectorOutput(evidence: WorkflowPayloadEvidenceV1): boolean {
	if (evidence.state === 'absent') return true;
	const preview = evidence.preview;
	return (
		jsonRecord(preview) &&
		(preview.body === null || preview.body === '[redacted]') &&
		preview.bodyOmitted === true &&
		!('bodyPreview' in preview)
	);
}

export function projectWorkflowEvidence(
	graph: WorkflowGraphV1,
	scope: EvidenceScope,
	evidence: WorkflowPayloadEvidenceV1,
): WorkflowPayloadEvidenceV1 {
	/* Older action attempts may predate schema-aware redaction. A preview
	   without the current policy marker cannot be proved safe on read. */
	if (hasActionNode(graph) && evidence.redactionPolicyVersion !== 2)
		return masked(evidence);
	const restricted = restrictedEvidenceTaint(graph);
	if (
		restricted &&
		((scope.kind === 'run-input' && restricted.runInput) ||
			(scope.kind === 'run-output' && restricted.runOutput) ||
			(scope.kind === 'node-input' && restricted.nodeIds.has(scope.nodeId)) ||
			(scope.kind === 'node-output' && restricted.nodeIds.has(scope.nodeId)) ||
			(scope.kind === 'edge' && restricted.edgeIds.has(scope.edgeId)))
	)
		return masked(evidence);
	const taint = evidenceTaint(graph);
	if (!taint) return evidence;
	if (scope.kind === 'run-input') return masked(evidence);
	if (scope.kind === 'run-output')
		return taint.runOutput ? masked(evidence) : evidence;
	if (scope.kind === 'node-input')
		return taint.inputNodeIds.has(scope.nodeId) ? masked(evidence) : evidence;
	if (scope.kind === 'node-output') {
		if (taint.connectorNodeIds.has(scope.nodeId))
			return safeConnectorOutput(evidence) ? evidence : masked(evidence);
		return taint.outputNodeIds.has(scope.nodeId) ? masked(evidence) : evidence;
	}
	if (scope.kind !== 'edge') return evidence;
	const edge = taint.edgesById.get(scope.edgeId);
	if (edge && taint.connectorNodeIds.has(edge.source.nodeId))
		return edge.source.port === 'success' && safeConnectorOutput(evidence)
			? evidence
			: masked(evidence);
	return taint.edgeIds.has(scope.edgeId) ? masked(evidence) : evidence;
}

export function safeWorkflowEvidence(
	graph: WorkflowGraphV1,
	scope: EvidenceScope,
	value: JsonValue | undefined,
	schemaId: string,
	policy: {
		readonly schema?: JsonSchemaV1;
		readonly permissionSnapshot?: readonly string[];
	} = {},
): WorkflowPayloadEvidenceV1 {
	return projectWorkflowEvidence(
		graph,
		scope,
		safePayloadEvidence(value, schemaId, policy),
	);
}

function projectWorkflowNodeEvidence(
	graph: WorkflowGraphV1,
	nodes: readonly WorkflowNodeExecution[],
	unsafeConnectorOutput: boolean,
): readonly WorkflowNodeExecution[] {
	if (
		!evidenceTaint(graph) &&
		!hasActionNode(graph) &&
		!restrictedEvidenceTaint(graph)
	)
		return nodes;
	return nodes.map((node) => ({
		...node,
		attempts: node.attempts.map((attempt) => ({
			...attempt,
			input: unsafeConnectorOutput
				? masked(attempt.input)
				: projectWorkflowEvidence(
						graph,
						{ kind: 'node-input', nodeId: node.nodeId },
						attempt.input,
					),
			output: unsafeConnectorOutput
				? masked(attempt.output)
				: projectWorkflowEvidence(
						graph,
						{ kind: 'node-output', nodeId: node.nodeId },
						attempt.output,
					),
		})),
	}));
}

function projectWorkflowEdgeEvidence(
	graph: WorkflowGraphV1,
	edges: readonly WorkflowEdgeTransfer[],
	unsafeConnectorOutput: boolean,
): readonly WorkflowEdgeTransfer[] {
	if (
		!evidenceTaint(graph) &&
		!hasActionNode(graph) &&
		!restrictedEvidenceTaint(graph)
	)
		return edges;
	return edges.map((edge) => ({
		...edge,
		evidence: unsafeConnectorOutput
			? masked(edge.evidence)
			: projectWorkflowEvidence(
					graph,
					{ kind: 'edge', edgeId: edge.edgeId },
					edge.evidence,
				),
	}));
}

export function projectWorkflowTraceEvidence(
	graph: WorkflowGraphV1,
	nodes: readonly WorkflowNodeExecution[],
	edges: readonly WorkflowEdgeTransfer[],
): {
	readonly nodes: readonly WorkflowNodeExecution[];
	readonly edges: readonly WorkflowEdgeTransfer[];
	readonly unsafeConnectorOutput: boolean;
} {
	const taint = evidenceTaint(graph);
	const unsafeConnectorOutput =
		taint !== null &&
		(taint.legacyConnector ||
			nodes.some(
				(node) =>
					taint.connectorNodeIds.has(node.nodeId) &&
					node.attempts.some((attempt) => !safeConnectorOutput(attempt.output)),
			));
	return {
		nodes: projectWorkflowNodeEvidence(graph, nodes, unsafeConnectorOutput),
		edges: projectWorkflowEdgeEvidence(graph, edges, unsafeConnectorOutput),
		unsafeConnectorOutput,
	};
}

function projectEventPayload(
	value: JsonValue,
	maskConnector: boolean,
	maskUnversionedAction: boolean,
	depth = 0,
): JsonValue {
	if (depth > 24) return '[redacted]';
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value))
		return value.map((entry) =>
			projectEventPayload(
				entry,
				maskConnector,
				maskUnversionedAction,
				depth + 1,
			),
		);
	if (
		jsonRecord(value) &&
		value.version === 1 &&
		typeof value.schemaId === 'string' &&
		typeof value.hash === 'string' &&
		typeof value.originalByteSize === 'number'
	) {
		const evidence = value as unknown as WorkflowPayloadEvidenceV1;
		return (maskConnector ||
		(maskUnversionedAction && evidence.redactionPolicyVersion !== 2)
			? masked(evidence)
			: evidence) as unknown as JsonValue;
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			projectEventPayload(
				entry,
				maskConnector,
				maskUnversionedAction,
				depth + 1,
			),
		]),
	);
}

export function projectWorkflowEvents(
	graph: WorkflowGraphV1,
	events: readonly WorkflowRunEventV1[],
): readonly WorkflowRunEventV1[] {
	const maskConnector =
		evidenceTaint(graph) !== null || restrictedEvidenceTaint(graph) !== null;
	const maskUnversionedAction = hasActionNode(graph);
	if (!maskConnector && !maskUnversionedAction) return events;
	return events.map((event) => ({
		...event,
		payload: projectEventPayload(
			event.payload,
			maskConnector,
			maskUnversionedAction,
		) as Readonly<Record<string, JsonValue>>,
	}));
}

export function projectWorkflowRunEvidence(
	detail: WorkflowRunDetail,
): WorkflowRunDetail {
	const graph = detail.graph;
	if (
		!evidenceTaint(graph) &&
		!hasActionNode(graph) &&
		!restrictedEvidenceTaint(graph)
	)
		return detail;
	const trace = projectWorkflowTraceEvidence(graph, detail.nodes, detail.edges);
	return {
		...detail,
		input: projectWorkflowEvidence(graph, { kind: 'run-input' }, detail.input),
		output: trace.unsafeConnectorOutput
			? masked(detail.output)
			: projectWorkflowEvidence(graph, { kind: 'run-output' }, detail.output),
		nodes: trace.nodes,
		edges: trace.edges,
		events: projectWorkflowEvents(graph, detail.events),
	};
}
