import { createHash } from 'node:crypto';
import type {
	JsonSchemaV1,
	JsonValue,
	WorkflowDryRunResponseV1,
	WorkflowGateExpressionV1,
	WorkflowGraphV1,
	WorkflowHumanApprovalNodeV1,
	WorkflowNodeV1,
	WorkflowPayloadEvidenceV1,
	WorkflowReferenceSummaryV1,
	WorkflowTargetMappingV1,
	WorkflowValidationIssueV1,
} from './types.ts';
import { APPROVAL_LIMITS, WORKFLOW_LIMITS } from './types.ts';

const IDENTIFIER = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const PORT = /^[a-z][a-z0-9-]*$/;
const FORBIDDEN_CONFIGURATION_KEYS = new Set([
	'eval',
	'javascript',
	'script',
	'sourceCode',
	'shell',
	'dynamicImport',
]);

export interface WorkflowReferenceCatalog {
	agent(
		agentId: string,
		revision: number,
	):
		| boolean
		| {
				readonly available: boolean;
				readonly allowedTools: readonly string[];
		  };
	action(
		actionId: string,
		contractVersion: number,
	): {
		readonly available: boolean;
		readonly requiredPermissions: readonly string[];
		readonly risk?: 'read' | 'workspace-write' | 'external' | 'destructive';
		readonly idempotency?: 'required' | 'none';
	};
	/**
	 * approvals.core and the roles the workspace defines, resolved once before
	 * the compiler walks the graph. A catalog without this member reads as an
	 * absent approvals module, which is the answer a graph compiled with no
	 * catalog at all already gets.
	 */
	approval?(): {
		readonly available: boolean;
		readonly roleKeys: readonly string[];
	};
}

export const EMPTY_WORKFLOW_GRAPH: WorkflowGraphV1 = Object.freeze({
	schemaVersion: 1,
	nodes: Object.freeze([]),
	edges: Object.freeze([]),
	schemas: Object.freeze({}),
	layout: Object.freeze({}),
});

function canonical(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.filter(([, entry]) => entry !== undefined)
		.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
		.join(',')}}`;
}

export function workflowGraphChecksum(graph: WorkflowGraphV1): string {
	const semantic = {
		schemaVersion: graph.schemaVersion,
		nodes: graph.nodes,
		edges: graph.edges,
		schemas: graph.schemas,
	};
	return `sha256:${createHash('sha256').update(canonical(semantic)).digest('hex')}`;
}

export function jsonHash(value: JsonValue): string {
	return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

export function jsonByteSize(value: JsonValue): number {
	return Buffer.byteLength(canonical(value));
}

function issue(
	code: string,
	message: string,
	location: WorkflowValidationIssueV1['location'] = { kind: 'graph' },
): WorkflowValidationIssueV1 {
	return { code, severity: 'error', message, location };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJson(value: unknown, depth = 0): value is JsonValue {
	if (depth > 24) return false;
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		return true;
	}
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value))
		return value.every((entry) => isJson(entry, depth + 1));
	if (!isRecord(value)) return false;
	return Object.values(value).every((entry) => isJson(entry, depth + 1));
}

export function parseWorkflowGraph(value: unknown): WorkflowGraphV1 {
	if (!isRecord(value) || value.schemaVersion !== 1 || !isJson(value)) {
		throw new Error('WORKFLOW_GRAPH_INVALID');
	}
	if (
		!Array.isArray(value.nodes) ||
		!Array.isArray(value.edges) ||
		!isRecord(value.schemas) ||
		!isRecord(value.layout)
	) {
		throw new Error('WORKFLOW_GRAPH_INVALID');
	}
	return structuredClone(value) as unknown as WorkflowGraphV1;
}

const EXPECTED_PORTS: Record<
	WorkflowNodeV1['type'],
	{ readonly inputs: readonly string[]; readonly outputs: readonly string[] }
> = {
	input: { inputs: [], outputs: ['data'] },
	agent: { inputs: ['input'], outputs: ['success', 'failure'] },
	'agent-decision': {
		inputs: ['input'],
		outputs: ['pass', 'fail', 'failure'],
	},
	gate: { inputs: ['input'], outputs: ['pass', 'fail'] },
	validator: { inputs: ['input'], outputs: ['pass', 'fail'] },
	action: { inputs: ['input'], outputs: ['success', 'failure'] },
	'human-approval': { inputs: ['input'], outputs: ['approved'] },
	merge: { inputs: ['items'], outputs: ['data'] },
	output: { inputs: ['input'], outputs: [] },
};

function configurationIssues(
	node: WorkflowNodeV1,
): readonly WorkflowValidationIssueV1[] {
	const issues: WorkflowValidationIssueV1[] = [];
	const inspect = (value: unknown, path: string, depth: number): void => {
		if (depth > 24) {
			issues.push(
				issue(
					'WORKFLOW_LIMIT_EXCEEDED',
					'Node configuration exceeds the depth limit.',
					{
						kind: 'node',
						nodeId: node.id,
						path,
					},
				),
			);
			return;
		}
		if (Array.isArray(value)) {
			value.forEach((entry, index) =>
				inspect(entry, `${path}/${index}`, depth + 1),
			);
			return;
		}
		if (!isRecord(value)) return;
		for (const [key, entry] of Object.entries(value)) {
			if (FORBIDDEN_CONFIGURATION_KEYS.has(key)) {
				issues.push(
					issue(
						'WORKFLOW_EXECUTABLE_CONFIGURATION_FORBIDDEN',
						`Executable configuration field "${key}" is forbidden.`,
						{ kind: 'node', nodeId: node.id, path: `${path}/${key}` },
					),
				);
			}
			inspect(entry, `${path}/${key}`, depth + 1);
		}
	};
	inspect(node, '', 0);
	return issues;
}

function schemaIssues(
	id: string,
	schema: JsonSchemaV1,
): readonly WorkflowValidationIssueV1[] {
	const issues: WorkflowValidationIssueV1[] = [];
	if (!IDENTIFIER.test(id)) {
		issues.push(
			issue('WORKFLOW_SCHEMA_ID_INVALID', `Schema "${id}" has an invalid id.`),
		);
	}
	if (jsonByteSize(schema) > 16 * 1024) {
		issues.push(
			issue('WORKFLOW_LIMIT_EXCEEDED', `Schema "${id}" exceeds 16 KB.`),
		);
	}
	const allowed = new Set([
		'$id',
		'title',
		'description',
		'type',
		'properties',
		'required',
		'additionalProperties',
		'items',
		'enum',
		'const',
		'minLength',
		'maxLength',
		'minimum',
		'maximum',
	]);
	const walk = (value: JsonValue, depth: number): void => {
		if (depth > 12) {
			issues.push(
				issue('WORKFLOW_LIMIT_EXCEEDED', `Schema "${id}" is too deep.`),
			);
			return;
		}
		if (value === null || typeof value !== 'object') return;
		if (Array.isArray(value)) {
			value.forEach((entry) => walk(entry, depth + 1));
			return;
		}
		for (const [key, entry] of Object.entries(value)) {
			if (depth === 0 && !allowed.has(key)) {
				issues.push(
					issue(
						'WORKFLOW_SCHEMA_KEY_UNSUPPORTED',
						`Schema "${id}" uses unsupported keyword "${key}".`,
					),
				);
			}
			walk(entry, depth + 1);
		}
	};
	walk(schema, 0);
	return issues;
}

function validateGateExpression(
	expression: WorkflowGateExpressionV1,
	nodeId: string,
	depth = 0,
): readonly WorkflowValidationIssueV1[] {
	if (
		depth > 16 ||
		!isRecord(expression) ||
		typeof expression.op !== 'string'
	) {
		return [
			issue(
				'WORKFLOW_GATE_INVALID',
				'Gate expression is invalid or too deep.',
				{
					kind: 'node',
					nodeId,
					path: '/expression',
				},
			),
		];
	}
	if (expression.op === 'literal') {
		return isJson(expression.value)
			? []
			: [
					issue('WORKFLOW_GATE_INVALID', 'Gate literal is not JSON.', {
						kind: 'node',
						nodeId,
					}),
				];
	}
	if (expression.op === 'path') {
		return typeof expression.pointer === 'string' &&
			validPointer(expression.pointer)
			? []
			: [
					issue(
						'WORKFLOW_GATE_INVALID',
						'Gate path is not an RFC 6901 pointer.',
						{ kind: 'node', nodeId },
					),
				];
	}
	if (expression.op === 'not' || expression.op === 'exists') {
		return validateGateExpression(expression.value, nodeId, depth + 1);
	}
	if (expression.op === 'and' || expression.op === 'or') {
		return Array.isArray(expression.values) && expression.values.length > 0
			? expression.values.flatMap((entry) =>
					validateGateExpression(entry, nodeId, depth + 1),
				)
			: [
					issue(
						'WORKFLOW_GATE_INVALID',
						'Logical gates require at least one operand.',
						{ kind: 'node', nodeId },
					),
				];
	}
	if (
		expression.op === 'eq' ||
		expression.op === 'gt' ||
		expression.op === 'gte' ||
		expression.op === 'lt' ||
		expression.op === 'lte' ||
		expression.op === 'in'
	) {
		return [
			...validateGateExpression(expression.left, nodeId, depth + 1),
			...validateGateExpression(expression.right, nodeId, depth + 1),
		];
	}
	return [
		issue('WORKFLOW_GATE_INVALID', 'Gate operator is not supported.', {
			kind: 'node',
			nodeId,
		}),
	];
}

function validPointer(pointer: string): boolean {
	return (
		typeof pointer === 'string' &&
		(pointer === '' ||
			(pointer.startsWith('/') && !/~(?:[^01]|$)/.test(pointer)))
	);
}

function mappingIssues(
	mapping: WorkflowTargetMappingV1,
	node: WorkflowNodeV1,
	nodeIndex: ReadonlyMap<string, number>,
	graph: WorkflowGraphV1,
): readonly WorkflowValidationIssueV1[] {
	const issues: WorkflowValidationIssueV1[] = [];
	if (!validPointer(mapping.targetPointer)) {
		issues.push(
			issue('WORKFLOW_MAPPING_POINTER_INVALID', 'Target pointer is invalid.', {
				kind: 'node',
				nodeId: node.id,
			}),
		);
	}
	const binding = mapping.binding;
	if (binding.kind === 'literal') return issues;
	const sources = binding.kind === 'path' ? [binding] : binding.variables;
	if (
		binding.kind === 'template' &&
		Buffer.byteLength(binding.template) > 8 * 1024
	) {
		issues.push(
			issue('WORKFLOW_LIMIT_EXCEEDED', 'Template exceeds 8 KB.', {
				kind: 'node',
				nodeId: node.id,
			}),
		);
	}
	for (const source of sources) {
		if (!validPointer(source.pointer)) {
			issues.push(
				issue(
					'WORKFLOW_MAPPING_POINTER_INVALID',
					'Source pointer is invalid.',
					{ kind: 'node', nodeId: node.id },
				),
			);
		}
		const sourceIndex = nodeIndex.get(source.sourceNodeId);
		const targetIndex = nodeIndex.get(node.id);
		if (
			sourceIndex === undefined ||
			targetIndex === undefined ||
			sourceIndex >= targetIndex ||
			!graph.nodes
				.find((entry) => entry.id === source.sourceNodeId)
				?.outputPorts.some((port) => port.name === source.sourcePort) ||
			!isUpstream(graph, source.sourceNodeId, node.id)
		) {
			issues.push(
				issue(
					'WORKFLOW_MAPPING_SOURCE_INVALID',
					`Mapping source "${source.sourceNodeId}" is not upstream.`,
					{ kind: 'node', nodeId: node.id },
				),
			);
		}
	}
	return issues;
}

function isUpstream(
	graph: WorkflowGraphV1,
	source: string,
	target: string,
): boolean {
	const pending = [target];
	const visited = new Set<string>();
	while (pending.length) {
		const id = pending.pop()!;
		if (visited.has(id)) continue;
		visited.add(id);
		for (const edge of graph.edges) {
			if (edge.target.nodeId !== id) continue;
			if (edge.source.nodeId === source) return true;
			pending.push(edge.source.nodeId);
		}
	}
	return false;
}

function stableTopologicalOrder(
	nodes: readonly WorkflowNodeV1[],
	edges: WorkflowGraphV1['edges'],
): { readonly order: readonly string[]; readonly cyclic: boolean } {
	const incoming = new Map(nodes.map((node) => [node.id, 0]));
	const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
	for (const edge of edges) {
		if (!incoming.has(edge.target.nodeId) || !outgoing.has(edge.source.nodeId))
			continue;
		incoming.set(
			edge.target.nodeId,
			(incoming.get(edge.target.nodeId) ?? 0) + 1,
		);
		outgoing.get(edge.source.nodeId)!.push(edge.target.nodeId);
	}
	const ready = [...incoming.entries()]
		.filter(([, count]) => count === 0)
		.map(([id]) => id)
		.sort();
	const order: string[] = [];
	while (ready.length > 0) {
		const id = ready.shift()!;
		order.push(id);
		for (const target of [...(outgoing.get(id) ?? [])].sort()) {
			const count = (incoming.get(target) ?? 1) - 1;
			incoming.set(target, count);
			if (count === 0) {
				ready.push(target);
				ready.sort();
			}
		}
	}
	return { order, cyclic: order.length !== nodes.length };
}

/**
 * A human-approval node carries the whole requirement in the published graph,
 * so publishing is where a role the workspace does not define has to be caught:
 * a run that reached the node with an unresolvable requirement would pause on
 * nobody. An absent approvals module is the same class of problem and gets its
 * own stable code.
 */
function approvalIssues(
	node: WorkflowHumanApprovalNodeV1,
	catalog: WorkflowReferenceCatalog | undefined,
): readonly WorkflowValidationIssueV1[] {
	const issues: WorkflowValidationIssueV1[] = [];
	const at = { kind: 'node', nodeId: node.id } as const;
	const approval = catalog?.approval?.();
	if (!approval?.available) {
		issues.push(
			issue(
				'WORKFLOW_APPROVAL_CAPABILITY_UNAVAILABLE',
				`Node "${node.id}" needs approvals.core, which is not composed.`,
				at,
			),
		);
	}
	/* approvals.core receives `prompt ?? label` as the request title and a
	   summary naming the label, so a value it would refuse has to fail the
	   publish rather than the run that reaches the node. The label carries the
	   title limit because it is the title whenever no prompt is set, and being
	   bounded there keeps the composed summary inside APPROVAL_LIMITS.summary. */
	for (const [name, value] of [
		['prompt', node.prompt],
		['label', node.label],
	] as const) {
		if (typeof value === 'string' && value.length > APPROVAL_LIMITS.title) {
			issues.push(
				issue(
					'WORKFLOW_LIMIT_EXCEEDED',
					`Node "${node.id}" sets a ${name} of ${value.length} characters; approvals.core accepts ${APPROVAL_LIMITS.title}.`,
					{ ...at, path: `/${name}` },
				),
			);
		}
	}
	const requirement: unknown = node.requirement;
	if (!isRecord(requirement)) {
		issues.push(
			issue(
				'WORKFLOW_APPROVAL_REQUIREMENT_INVALID',
				`Node "${node.id}" declares no approval requirement.`,
				{ ...at, path: '/requirement' },
			),
		);
		return issues;
	}
	const roleKey = requirement.roleKey;
	const scope = requirement.scope;
	const hasRole = typeof roleKey === 'string' && roleKey !== '';
	const hasScope = typeof scope === 'string' && scope !== '';
	if (!hasRole && !hasScope) {
		issues.push(
			issue(
				'WORKFLOW_APPROVAL_REQUIREMENT_INVALID',
				`Node "${node.id}" must name a role key or a scope.`,
				{ ...at, path: '/requirement' },
			),
		);
	}
	const bound = (value: unknown, name: string, max: number): void => {
		if (value === undefined) return;
		if (
			!Number.isSafeInteger(value) ||
			(value as number) < 1 ||
			(value as number) > max
		) {
			issues.push(
				issue(
					'WORKFLOW_APPROVAL_REQUIREMENT_INVALID',
					`Node "${node.id}" must set ${name} between 1 and ${max}.`,
					{ ...at, path: `/requirement/${name}` },
				),
			);
		}
	};
	bound(
		requirement.decisions,
		'decisions',
		WORKFLOW_LIMITS.maxApprovalDecisions,
	);
	bound(
		requirement.expiresInDays,
		'expiresInDays',
		WORKFLOW_LIMITS.maxApprovalExpiryDays,
	);
	/* A scope requirement is shape-checked only: scopes come from every composed
	   module, and this compiler resolves the workspace's roles alone. */
	if (hasRole && approval && !approval.roleKeys.includes(roleKey as string)) {
		issues.push(
			issue(
				'WORKFLOW_APPROVAL_ROLE_UNKNOWN',
				`Node "${node.id}" names role "${roleKey as string}", which this workspace does not define.`,
				{ ...at, path: '/requirement/roleKey' },
			),
		);
	}
	return issues;
}

export function compileWorkflowGraph(
	graph: WorkflowGraphV1,
	catalog?: WorkflowReferenceCatalog,
): WorkflowDryRunResponseV1 {
	const issues: WorkflowValidationIssueV1[] = [];
	let checksum = 'sha256:invalid';
	try {
		checksum = workflowGraphChecksum(graph);
	} catch {
		issues.push(
			issue('WORKFLOW_GRAPH_INVALID', 'Graph must contain JSON data only.'),
		);
	}
	if (graph.schemaVersion !== 1)
		issues.push(
			issue(
				'WORKFLOW_GRAPH_VERSION_UNSUPPORTED',
				'Only graph schema version 1 is supported.',
			),
		);
	if (
		jsonByteSize(graph as unknown as JsonValue) > WORKFLOW_LIMITS.maxGraphBytes
	)
		issues.push(issue('WORKFLOW_LIMIT_EXCEEDED', 'Graph exceeds 64 KB.'));
	if (graph.nodes.length > WORKFLOW_LIMITS.maxNodes)
		issues.push(issue('WORKFLOW_LIMIT_EXCEEDED', 'Graph exceeds 100 nodes.'));
	if (graph.edges.length > WORKFLOW_LIMITS.maxEdges)
		issues.push(issue('WORKFLOW_LIMIT_EXCEEDED', 'Graph exceeds 200 edges.'));
	if (Object.keys(graph.schemas).length > WORKFLOW_LIMITS.maxSchemas)
		issues.push(issue('WORKFLOW_LIMIT_EXCEEDED', 'Graph exceeds 32 schemas.'));

	const nodeById = new Map<string, WorkflowNodeV1>();
	const references: WorkflowReferenceSummaryV1[] = [];
	const requiredPermissions = new Set<string>();
	for (const [schemaId, schema] of Object.entries(graph.schemas)) {
		issues.push(...schemaIssues(schemaId, schema));
		references.push({
			kind: 'schema',
			id: schemaId,
			version: '1',
			available: true,
		});
	}
	for (const node of graph.nodes) {
		if (!IDENTIFIER.test(node.id))
			issues.push(
				issue(
					'WORKFLOW_NODE_ID_INVALID',
					`Node "${node.id}" has an invalid id.`,
					{ kind: 'node', nodeId: node.id },
				),
			);
		if (nodeById.has(node.id))
			issues.push(
				issue('WORKFLOW_NODE_DUPLICATE', `Node "${node.id}" is duplicated.`, {
					kind: 'node',
					nodeId: node.id,
				}),
			);
		nodeById.set(node.id, node);
		issues.push(...configurationIssues(node));
		const expected = EXPECTED_PORTS[node.type];
		if (!expected) {
			issues.push(
				issue(
					'WORKFLOW_NODE_TYPE_INVALID',
					`Node "${node.id}" has an unsupported type.`,
					{ kind: 'node', nodeId: node.id },
				),
			);
			continue;
		}
		for (const [kind, ports] of [
			['input', node.inputPorts],
			['output', node.outputPorts],
		] as const) {
			const names = ports.map((port) => port.name);
			if (
				new Set(names).size !== names.length ||
				names.some((name) => !PORT.test(name))
			)
				issues.push(
					issue(
						'WORKFLOW_PORT_INVALID',
						`${kind} ports on "${node.id}" are invalid.`,
						{ kind: 'node', nodeId: node.id },
					),
				);
			for (const port of ports)
				if (!graph.schemas[port.schemaId])
					issues.push(
						issue(
							'WORKFLOW_SCHEMA_MISSING',
							`Port "${port.name}" refers to missing schema "${port.schemaId}".`,
							{ kind: 'node', nodeId: node.id },
						),
					);
		}
		if (
			[...expected.inputs].sort().join('|') !==
				node.inputPorts
					.map((port) => port.name)
					.sort()
					.join('|') ||
			[...expected.outputs].sort().join('|') !==
				node.outputPorts
					.map((port) => port.name)
					.sort()
					.join('|')
		)
			issues.push(
				issue(
					'WORKFLOW_PORT_CONTRACT_INVALID',
					`Node "${node.id}" does not declare the fixed ${node.type} ports.`,
					{ kind: 'node', nodeId: node.id },
				),
			);
		const policy = node.failurePolicy;
		if (
			policy &&
			(policy.maxAttempts < 1 ||
				policy.maxAttempts > WORKFLOW_LIMITS.maxAttemptsPerNode ||
				policy.backoff.initialMs < 0 ||
				policy.backoff.maximumMs < policy.backoff.initialMs ||
				policy.backoff.maximumMs > 3_600_000)
		)
			issues.push(
				issue(
					'WORKFLOW_RETRY_POLICY_INVALID',
					`Node "${node.id}" has an invalid retry policy.`,
					{ kind: 'node', nodeId: node.id },
				),
			);
		if (node.type === 'agent' || node.type === 'agent-decision') {
			const reference =
				catalog?.agent(node.agent.agentId, node.agent.revision) ?? false;
			const available =
				typeof reference === 'boolean' ? reference : reference.available;
			if (
				!Array.isArray(node.toolGrants) ||
				node.toolGrants.length > 32 ||
				new Set(node.toolGrants).size !== node.toolGrants.length ||
				node.toolGrants.some(
					(tool) => typeof tool !== 'string' || !IDENTIFIER.test(tool),
				)
			) {
				issues.push(
					issue(
						'WORKFLOW_AGENT_TOOL_GRANTS_INVALID',
						`Agent node "${node.id}" must declare at most 32 unique tool grants.`,
						{ kind: 'node', nodeId: node.id, path: '/toolGrants' },
					),
				);
			} else if (typeof reference !== 'boolean') {
				const invalidGrant = node.toolGrants.find(
					(tool) => !reference.allowedTools.includes(tool),
				);
				if (invalidGrant) {
					issues.push(
						issue(
							'WORKFLOW_AGENT_TOOL_GRANT_NOT_ALLOWED',
							`Tool "${invalidGrant}" is not allowed by pinned agent revision ${node.agent.revision}.`,
							{ kind: 'node', nodeId: node.id, path: '/toolGrants' },
						),
					);
				}
			}
			references.push({
				kind: 'agent',
				id: node.agent.agentId,
				version: String(node.agent.revision),
				available,
			});
		}
		if (node.type === 'human-approval') {
			issues.push(...approvalIssues(node, catalog));
			/* validate() accepts an unparsed graph, so the node may carry no
			   requirement at all. `approvalIssues` has already reported that;
			   the reference names nothing rather than throwing over it. */
			const requirement: unknown = node.requirement;
			const named = isRecord(requirement)
				? (requirement.roleKey ?? requirement.scope)
				: undefined;
			references.push({
				kind: 'approval',
				id: typeof named === 'string' ? named : '',
				version: '1',
				available: catalog?.approval?.().available === true,
			});
		}
		if (node.type === 'action') {
			const action = catalog?.action(
				node.action.actionId,
				node.action.contractVersion,
			) ?? { available: false, requiredPermissions: [] };
			const available =
				action.available &&
				(action.risk === undefined ||
					action.risk === 'read' ||
					action.risk === 'workspace-write') &&
				(action.idempotency === undefined || action.idempotency === 'required');
			references.push({
				kind: 'action',
				id: node.action.actionId,
				version: String(node.action.contractVersion),
				available,
			});
			action.requiredPermissions.forEach((permission) =>
				requiredPermissions.add(permission),
			);
			if (action.risk === 'external' || action.risk === 'destructive')
				issues.push(
					issue(
						'WORKFLOW_ACTION_RISK_DENIED',
						`Action "${node.action.actionId}" has an unsupported risk.`,
						{ kind: 'node', nodeId: node.id },
					),
				);
		}
	}

	const edgeIds = new Set<string>();
	const incoming = new Map<string, number>();
	const outgoing = new Map<string, number>();
	for (const edge of graph.edges) {
		if (!IDENTIFIER.test(edge.id))
			issues.push(
				issue(
					'WORKFLOW_EDGE_ID_INVALID',
					`Edge "${edge.id}" has an invalid id.`,
					{ kind: 'edge', edgeId: edge.id },
				),
			);
		if (edgeIds.has(edge.id))
			issues.push(
				issue('WORKFLOW_EDGE_DUPLICATE', `Edge "${edge.id}" is duplicated.`, {
					kind: 'edge',
					edgeId: edge.id,
				}),
			);
		edgeIds.add(edge.id);
		const source = nodeById.get(edge.source.nodeId);
		const target = nodeById.get(edge.target.nodeId);
		if (!source || !target) {
			issues.push(
				issue(
					'WORKFLOW_EDGE_DANGLING',
					`Edge "${edge.id}" refers to a missing node.`,
					{ kind: 'edge', edgeId: edge.id },
				),
			);
			continue;
		}
		const sourcePort = source.outputPorts.find(
			(port) => port.name === edge.source.port,
		);
		const targetPort = target.inputPorts.find(
			(port) => port.name === edge.target.port,
		);
		if (!sourcePort || !targetPort)
			issues.push(
				issue(
					'WORKFLOW_EDGE_PORT_MISSING',
					`Edge "${edge.id}" refers to a missing port.`,
					{ kind: 'edge', edgeId: edge.id },
				),
			);
		else if (sourcePort.schemaId !== targetPort.schemaId)
			issues.push(
				issue(
					'WORKFLOW_EDGE_SCHEMA_INCOMPATIBLE',
					`Edge "${edge.id}" connects incompatible schemas.`,
					{ kind: 'edge', edgeId: edge.id },
				),
			);
		const targetKey = `${edge.target.nodeId}:${edge.target.port}`;
		incoming.set(targetKey, (incoming.get(targetKey) ?? 0) + 1);
		outgoing.set(
			edge.source.nodeId,
			(outgoing.get(edge.source.nodeId) ?? 0) + 1,
		);
	}
	for (const node of graph.nodes) {
		for (const port of node.inputPorts) {
			const count = incoming.get(`${node.id}:${port.name}`) ?? 0;
			if (count === 0)
				issues.push(
					issue(
						'WORKFLOW_INPUT_UNCONNECTED',
						`Input "${node.id}.${port.name}" is not connected.`,
						{ kind: 'node', nodeId: node.id },
					),
				);
			if (count > 1 && !(node.type === 'merge' && port.name === 'items'))
				issues.push(
					issue(
						'WORKFLOW_INPUT_CARDINALITY',
						`Input "${node.id}.${port.name}" has more than one edge.`,
						{ kind: 'node', nodeId: node.id },
					),
				);
		}
		if (node.type !== 'output' && (outgoing.get(node.id) ?? 0) === 0)
			issues.push(
				issue(
					'WORKFLOW_TERMINAL_OUTPUT_MISSING',
					`Node "${node.id}" has no path to an output.`,
					{ kind: 'node', nodeId: node.id },
				),
			);
	}
	const inputs = graph.nodes.filter((node) => node.type === 'input');
	const outputs = graph.nodes.filter((node) => node.type === 'output');
	if (inputs.length !== 1)
		issues.push(
			issue(
				'WORKFLOW_INPUT_COUNT_INVALID',
				'A graph requires exactly one input node.',
			),
		);
	if (outputs.length === 0)
		issues.push(
			issue(
				'WORKFLOW_OUTPUT_MISSING',
				'A graph requires at least one output node.',
			),
		);

	const topological = stableTopologicalOrder(graph.nodes, graph.edges);
	if (topological.cyclic)
		issues.push(issue('WORKFLOW_GRAPH_CYCLE', 'The graph contains a cycle.'));
	const reachable = new Set<string>();
	if (inputs[0]) {
		const queue = [inputs[0].id];
		while (queue.length > 0) {
			const current = queue.shift()!;
			if (reachable.has(current)) continue;
			reachable.add(current);
			for (const edge of graph.edges)
				if (edge.source.nodeId === current) queue.push(edge.target.nodeId);
		}
	}
	for (const node of graph.nodes)
		if (!reachable.has(node.id))
			issues.push(
				issue(
					'WORKFLOW_NODE_UNREACHABLE',
					`Node "${node.id}" is unreachable.`,
					{ kind: 'node', nodeId: node.id },
				),
			);
	const index = new Map(
		topological.order.map((id, position) => [id, position]),
	);
	for (const node of graph.nodes) {
		if (node.type === 'gate')
			issues.push(...validateGateExpression(node.expression, node.id));
		for (const mapping of node.mappings ?? [])
			issues.push(...mappingIssues(mapping, node, index, graph));
	}
	for (const reference of references) {
		if (reference.kind !== 'schema' && !reference.available)
			issues.push(
				issue(
					reference.kind === 'agent'
						? 'WORKFLOW_AGENT_REVISION_MISSING'
						: 'WORKFLOW_ACTION_VERSION_MISSING',
					`${reference.kind} "${reference.id}" version ${reference.version} is unavailable.`,
				),
			);
	}
	return {
		reportVersion: 1,
		graphChecksum: checksum,
		valid: issues.every((entry) => entry.severity !== 'error'),
		issues,
		compiledOrder: topological.cyclic ? [] : topological.order,
		references,
		requiredPermissions: [...requiredPermissions].sort(),
		limits: WORKFLOW_LIMITS,
	};
}

export interface JsonValidationError {
	readonly path: string;
	readonly code: string;
}

export function validateJsonSchema(
	value: JsonValue,
	schema: JsonSchemaV1,
	path = '',
): readonly JsonValidationError[] {
	const errors: JsonValidationError[] = [];
	const type = schema.type;
	const matches =
		type === undefined ||
		(type === 'null' && value === null) ||
		(type === 'string' && typeof value === 'string') ||
		(type === 'number' && typeof value === 'number') ||
		(type === 'integer' &&
			typeof value === 'number' &&
			Number.isSafeInteger(value)) ||
		(type === 'boolean' && typeof value === 'boolean') ||
		(type === 'array' && Array.isArray(value)) ||
		(type === 'object' && isRecord(value));
	if (!matches) return [{ path, code: 'type' }];
	if (
		Array.isArray(schema.enum) &&
		!schema.enum.some((entry) => canonical(entry) === canonical(value))
	)
		errors.push({ path, code: 'enum' });
	if (
		schema.const !== undefined &&
		canonical(schema.const) !== canonical(value)
	)
		errors.push({ path, code: 'const' });
	if (typeof value === 'string') {
		if (typeof schema.minLength === 'number' && value.length < schema.minLength)
			errors.push({ path, code: 'minLength' });
		if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
			errors.push({ path, code: 'maxLength' });
	}
	if (typeof value === 'number') {
		if (typeof schema.minimum === 'number' && value < schema.minimum)
			errors.push({ path, code: 'minimum' });
		if (typeof schema.maximum === 'number' && value > schema.maximum)
			errors.push({ path, code: 'maximum' });
	}
	if (Array.isArray(value) && isRecord(schema.items))
		value.forEach((entry, index) =>
			errors.push(
				...validateJsonSchema(
					entry,
					schema.items as JsonSchemaV1,
					`${path}/${index}`,
				),
			),
		);
	if (isRecord(value)) {
		const properties = isRecord(schema.properties) ? schema.properties : {};
		const required = Array.isArray(schema.required)
			? new Set(
					schema.required.filter(
						(entry): entry is string => typeof entry === 'string',
					),
				)
			: new Set<string>();
		for (const name of required)
			if (!Object.hasOwn(value, name))
				errors.push({ path: `${path}/${name}`, code: 'required' });
		for (const [name, entry] of Object.entries(value)) {
			const child = Object.hasOwn(properties, name)
				? properties[name]
				: undefined;
			if (isRecord(child))
				errors.push(
					...validateJsonSchema(
						entry as JsonValue,
						child as JsonSchemaV1,
						`${path}/${name}`,
					),
				);
			else if (schema.additionalProperties === false)
				errors.push({ path: `${path}/${name}`, code: 'additionalProperties' });
		}
	}
	return errors.slice(0, 100);
}

export function readJsonPointer(
	value: JsonValue,
	pointer: string,
): JsonValue | undefined {
	if (pointer === '') return value;
	if (!validPointer(pointer)) return undefined;
	let current: JsonValue | undefined = value;
	for (const raw of pointer.slice(1).split('/')) {
		const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
		if (Array.isArray(current)) {
			if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
			const index = Number(key);
			current =
				Number.isSafeInteger(index) && index >= 0 ? current[index] : undefined;
		} else if (isRecord(current))
			current = Object.hasOwn(current, key)
				? (current[key] as JsonValue)
				: undefined;
		else return undefined;
	}
	return current;
}

function writeJsonPointer(
	target: Record<string, JsonValue>,
	pointer: string,
	value: JsonValue,
): void {
	if (
		!validPointer(pointer) ||
		pointer
			.split('/')
			.some((part) =>
				['__proto__', 'constructor', 'prototype'].includes(
					part.replaceAll('~1', '/').replaceAll('~0', '~'),
				),
			)
	)
		throw new Error('WORKFLOW_MAPPING_TARGET_INVALID');
	if (pointer === '') {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('WORKFLOW_MAPPING_TARGET_INVALID');
		}
		for (const key of Object.keys(target)) delete target[key];
		for (const [key, entry] of Object.entries(value))
			Object.defineProperty(target, key, {
				value: structuredClone(entry),
				enumerable: true,
				configurable: true,
				writable: true,
			});
		return;
	}
	const parts = pointer
		.slice(1)
		.split('/')
		.map((entry) => entry.replaceAll('~1', '/').replaceAll('~0', '~'));
	let current = target;
	for (const part of parts.slice(0, -1)) {
		const existing = Object.hasOwn(current, part) ? current[part] : undefined;
		if (
			existing === null ||
			typeof existing !== 'object' ||
			Array.isArray(existing)
		) {
			current[part] = {};
		}
		current = current[part] as Record<string, JsonValue>;
	}
	const last = parts.at(-1);
	if (last === undefined) throw new Error('WORKFLOW_MAPPING_TARGET_INVALID');
	current[last] = structuredClone(value);
}

export function applyWorkflowMappings(
	input: JsonValue,
	mappings: readonly WorkflowTargetMappingV1[],
	outputs: ReadonlyMap<string, JsonValue>,
): JsonValue {
	if (mappings.length === 0) return structuredClone(input);
	const target: Record<string, JsonValue> = {};
	for (const mapping of mappings) {
		let value: JsonValue | undefined;
		if (mapping.binding.kind === 'literal') value = mapping.binding.value;
		if (mapping.binding.kind === 'path') {
			if (
				!outputs.has(
					`${mapping.binding.sourceNodeId}:${mapping.binding.sourcePort}`,
				)
			)
				throw new Error('WORKFLOW_MAPPING_SOURCE_INVALID');
			value = readJsonPointer(
				outputs.get(
					`${mapping.binding.sourceNodeId}:${mapping.binding.sourcePort}`,
				) ?? null,
				mapping.binding.pointer,
			);
		}
		if (mapping.binding.kind === 'template') {
			const values = new Map<string, string>();
			for (const variable of mapping.binding.variables) {
				if (!outputs.has(`${variable.sourceNodeId}:${variable.sourcePort}`))
					throw new Error('WORKFLOW_MAPPING_SOURCE_INVALID');
				const resolved = readJsonPointer(
					outputs.get(`${variable.sourceNodeId}:${variable.sourcePort}`) ??
						null,
					variable.pointer,
				);
				if (
					resolved === undefined ||
					(resolved !== null && typeof resolved === 'object')
				) {
					throw new Error('WORKFLOW_MAPPING_SOURCE_INVALID');
				}
				values.set(variable.name, resolved === null ? '' : String(resolved));
			}
			value = mapping.binding.template.replace(
				/{{\s*([a-z][a-z0-9.-]*)\s*}}/g,
				(_match, name: string) => {
					const resolved = values.get(name);
					if (resolved === undefined)
						throw new Error('WORKFLOW_TEMPLATE_VARIABLE_MISSING');
					return resolved;
				},
			);
		}
		if (value === undefined) throw new Error('WORKFLOW_MAPPING_SOURCE_INVALID');
		writeJsonPointer(target, mapping.targetPointer, value);
	}
	return target;
}

export function evaluateGate(
	expression: WorkflowGateExpressionV1,
	input: JsonValue,
): boolean {
	const required = (value: JsonValue | undefined): JsonValue => {
		if (value === undefined) throw new Error('WORKFLOW_GATE_PATH_MISSING');
		return value;
	};
	const boolean = (value: JsonValue | undefined): boolean => {
		if (typeof required(value) !== 'boolean')
			throw new Error('WORKFLOW_GATE_TYPE_MISMATCH');
		return value as boolean;
	};
	const evaluate = (entry: WorkflowGateExpressionV1): JsonValue | undefined => {
		switch (entry.op) {
			case 'literal':
				return entry.value;
			case 'path':
				return readJsonPointer(input, entry.pointer);
			case 'exists':
				return evaluate(entry.value) !== undefined;
			case 'not':
				return !boolean(evaluate(entry.value));
			case 'and':
				return entry.values.every((value) => boolean(evaluate(value)));
			case 'or':
				return entry.values.some((value) => boolean(evaluate(value)));
			case 'eq':
				return (
					canonical(required(evaluate(entry.left))) ===
					canonical(required(evaluate(entry.right)))
				);
			case 'gt':
			case 'gte':
			case 'lt':
			case 'lte': {
				const left = evaluate(entry.left);
				const right = evaluate(entry.right);
				if (typeof left !== 'number' || typeof right !== 'number')
					throw new Error('WORKFLOW_GATE_TYPE_MISMATCH');
				return entry.op === 'gt'
					? left > right
					: entry.op === 'gte'
						? left >= right
						: entry.op === 'lt'
							? left < right
							: left <= right;
			}
			case 'in': {
				const right = required(evaluate(entry.right));
				const left = required(evaluate(entry.left));
				if (!Array.isArray(right))
					throw new Error('WORKFLOW_GATE_TYPE_MISMATCH');
				return (
					Array.isArray(right) &&
					right.some((value) => canonical(value) === canonical(left))
				);
			}
		}
	};
	const result = evaluate(expression);
	if (typeof result !== 'boolean')
		throw new Error('WORKFLOW_GATE_RESULT_INVALID');
	return result;
}

export function evidenceOf(
	value: JsonValue | undefined,
	schemaId: string,
): WorkflowPayloadEvidenceV1 {
	if (value === undefined)
		return {
			version: 1,
			state: 'absent',
			schemaId,
			hash: jsonHash(null),
			originalByteSize: 0,
			reason: 'not-emitted',
		};
	const originalByteSize = jsonByteSize(value);
	const hash = jsonHash(value);
	if (originalByteSize > WORKFLOW_LIMITS.maxEnvelopeBytes)
		return {
			version: 1,
			state: 'truncated',
			schemaId,
			hash,
			originalByteSize,
			reason: 'size-limit',
		};
	return {
		version: 1,
		state: 'available',
		schemaId,
		hash,
		originalByteSize,
		preview: structuredClone(value),
	};
}
