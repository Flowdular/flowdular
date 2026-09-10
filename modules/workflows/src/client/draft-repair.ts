import type { WorkflowGraphV1 } from '../domain/types.ts';

/** Repair only the numeric identifiers emitted by the old canvas, in drafts. */
export function repairCanvasIdentifiers(
	graph: WorkflowGraphV1,
): WorkflowGraphV1 {
	const names = new Map<string, string>();
	const occupied = new Set(graph.nodes.map((node) => node.id));
	for (const node of graph.nodes) {
		if (!/\.[0-9]+$/.test(node.id)) continue;
		const base = node.id.replace(/\.([0-9]+)$/, '.n$1');
		let name = base;
		let suffix = 1;
		while (occupied.has(name)) name = base + '-' + suffix++;
		occupied.add(name);
		names.set(node.id, name);
	}
	const edgeIds = new Set(graph.edges.map((edge) => edge.id));
	let changed = names.size > 0;
	const edges = graph.edges.map((edge) => {
		let id = edge.id;
		if (/\.[0-9]+$/.test(id)) {
			const base = id.replace(/\.([0-9]+)$/, '.e$1');
			id = base;
			let suffix = 1;
			while (edgeIds.has(id)) id = base + '-' + suffix++;
			edgeIds.add(id);
			changed = true;
		}
		return {
			...edge,
			id,
			source: {
				...edge.source,
				nodeId: names.get(edge.source.nodeId) ?? edge.source.nodeId,
			},
			target: {
				...edge.target,
				nodeId: names.get(edge.target.nodeId) ?? edge.target.nodeId,
			},
		};
	});
	if (!changed) return graph;
	return {
		...graph,
		edges,
		layout: Object.fromEntries(
			Object.entries(graph.layout).map(([id, point]) => [
				names.get(id) ?? id,
				point,
			]),
		),
		nodes: graph.nodes.map((node) => ({
			...node,
			id: names.get(node.id) ?? node.id,
			...(node.mappings
				? {
						mappings: node.mappings.map((mapping) => ({
							...mapping,
							binding:
								mapping.binding.kind === 'path'
									? {
											...mapping.binding,
											sourceNodeId:
												names.get(mapping.binding.sourceNodeId) ??
												mapping.binding.sourceNodeId,
										}
									: mapping.binding.kind === 'template'
										? {
												...mapping.binding,
												variables: mapping.binding.variables.map(
													(variable) => ({
														...variable,
														sourceNodeId:
															names.get(variable.sourceNodeId) ??
															variable.sourceNodeId,
													}),
												),
											}
										: mapping.binding,
						})),
					}
				: {}),
		})),
	};
}
