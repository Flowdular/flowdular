import type {
	WorkflowGraphV1,
	WorkflowTargetMappingV1,
} from '../domain/types.ts';

export function upstreamPorts(graph: WorkflowGraphV1, nodeId: string) {
	const incoming = new Map<string, string[]>();
	for (const edge of graph.edges)
		incoming.set(edge.target.nodeId, [
			...(incoming.get(edge.target.nodeId) ?? []),
			edge.source.nodeId,
		]);
	const visited = new Set<string>();
	const pending = [...(incoming.get(nodeId) ?? [])];
	while (pending.length) {
		const id = pending.pop()!;
		if (id === nodeId || visited.has(id)) continue;
		visited.add(id);
		pending.push(...(incoming.get(id) ?? []));
	}
	const reachablePorts = new Set(
		graph.edges
			.filter(
				(edge) =>
					visited.has(edge.source.nodeId) &&
					(edge.target.nodeId === nodeId || visited.has(edge.target.nodeId)),
			)
			.map((edge) => edge.source.nodeId + '|' + edge.source.port),
	);
	return graph.nodes
		.filter((node) => visited.has(node.id))
		.flatMap((node) =>
			node.outputPorts
				.filter((port) => reachablePorts.has(node.id + '|' + port.name))
				.map((port) => ({
					key: node.id + '|' + port.name,
					label: node.label + ' · ' + port.name,
					nodeId: node.id,
					port: port.name,
				})),
		);
}

export function isMappingPointer(value: string): boolean {
	return (
		(value === '' || (value.startsWith('/') && !/~(?:[^01]|$)/.test(value))) &&
		value.length <= 1024
	);
}

export function validateMappingInput(
	mapping: WorkflowTargetMappingV1,
	graph: WorkflowGraphV1,
	nodeId: string,
): boolean {
	if (
		!mapping ||
		typeof mapping.targetPointer !== 'string' ||
		!isMappingPointer(mapping.targetPointer) ||
		!mapping.binding
	)
		return false;
	if (
		mapping.targetPointer
			.split('/')
			.some((key) => ['__proto__', 'constructor', 'prototype'].includes(key))
	)
		return false;
	const binding = mapping.binding;
	if (binding.kind === 'literal') return binding.value !== undefined;
	if (binding.kind !== 'path' && binding.kind !== 'template') return false;
	if (
		binding.kind === 'template' &&
		(typeof binding.template !== 'string' ||
			binding.template.length > 8192 ||
			!Array.isArray(binding.variables))
	)
		return false;
	const sources = upstreamPorts(graph, nodeId);
	const variables = binding.kind === 'path' ? [binding] : binding.variables;
	if (
		!variables.every(
			(entry) =>
				entry &&
				typeof entry.pointer === 'string' &&
				isMappingPointer(entry.pointer) &&
				sources.some(
					(source) =>
						source.nodeId === entry.sourceNodeId &&
						source.port === entry.sourcePort,
				),
		)
	)
		return false;
	if (binding.kind === 'template') {
		const names = binding.variables.map((entry) => entry.name);
		if (
			names.some(
				(name) => typeof name !== 'string' || !/^[a-z][a-z0-9.-]*$/.test(name),
			) ||
			new Set(names).size !== names.length
		)
			return false;
		for (const match of binding.template.matchAll(
			/{{\s*([a-z][a-z0-9.-]*)\s*}}/g,
		))
			if (!names.includes(match[1]!)) return false;
	}
	return true;
}
