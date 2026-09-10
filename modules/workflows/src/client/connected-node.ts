import type { WorkflowGraphV1 } from '../domain/types.ts';
import {
	addWorkflowNode,
	connectWorkflowNodes,
	moveWorkflowNode,
	proposeWorkflowConnection,
	type WorkflowNodeType,
} from './canvas-model.ts';
import { snapPoint, type CanvasPoint } from './viewport.ts';

export interface ConnectedNodeRequest {
	readonly position: CanvasPoint;
	readonly source: { readonly nodeId: string; readonly port: string };
}

/** Build node and edge atomically. Invalid or stale sources never leave an orphan. */
export function addConnectedNode(
	graph: WorkflowGraphV1,
	type: WorkflowNodeType,
	label: string,
	request: ConnectedNodeRequest,
) {
	let added = addWorkflowNode(graph, type, label);
	// Terminal output accepts the exact source envelope, including lists and errors.
	if (type === 'output') {
		const schemaId = graph.nodes
			.find((node) => node.id === request.source.nodeId)
			?.outputPorts.find((port) => port.name === request.source.port)?.schemaId;
		if (schemaId)
			added = {
				...added,
				graph: {
					...added.graph,
					nodes: added.graph.nodes.map((node) =>
						node.id === added.nodeId
							? {
									...node,
									inputPorts: node.inputPorts.map((port) => ({
										...port,
										schemaId,
									})),
								}
							: node,
					),
				},
			};
	}
	const node = added.graph.nodes.find((entry) => entry.id === added.nodeId)!;
	const input = node.inputPorts.find(
		(port) =>
			proposeWorkflowConnection(
				added.graph,
				request.source.nodeId,
				request.source.port,
				node.id,
				port.name,
			).valid,
	);
	if (!input) return null;
	const position = snapPoint(request.position);
	return {
		nodeId: node.id,
		graph: connectWorkflowNodes(
			moveWorkflowNode(added.graph, node.id, position.x, position.y),
			request.source.nodeId,
			request.source.port,
			node.id,
			input.name,
		),
	};
}
