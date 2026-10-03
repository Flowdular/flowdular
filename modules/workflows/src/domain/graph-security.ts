import type {
	JsonSchemaV1,
	WorkflowActionNodeV1,
	WorkflowGraphV1,
	WorkflowTargetMappingV1,
} from './types.ts';

export type WorkflowGraphDiagnostic =
	| {
			readonly code:
				| 'WORKFLOW_ACTION_SECRET_BINDING'
				| 'WORKFLOW_ACTION_SCHEMA_UNAVAILABLE';
			readonly nodeId: string;
			readonly targetPointer: string;
	  }
	| {
			readonly code: 'WORKFLOW_SECRET_SCHEMA_VALUE';
			readonly schemaId: string;
			readonly path: string;
	  };

type WorkflowActionBindingDiagnostic = Extract<
	WorkflowGraphDiagnostic,
	{ readonly nodeId: string }
>;

export type WorkflowActionInputSchema = (
	actionId: string,
	contractVersion: number,
) => Readonly<Record<string, unknown>> | undefined;

function record(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function markedSecret(schema: Readonly<Record<string, unknown>>): boolean {
	return (
		schema.writeOnly === true ||
		schema['x-flowdular-secret'] === true ||
		schema['x-coreloom-secret'] === true
	);
}

const SCHEMA_VALUE_KEYS = new Set([
	'default',
	'const',
	'enum',
	'example',
	'examples',
]);

const SCHEMA_MAP_KEYS = new Set([
	'properties',
	'patternProperties',
	'$defs',
	'definitions',
	'dependentSchemas',
]);

function pointerPart(value: string): string {
	return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

interface SchemaProjection {
	readonly value: unknown;
	readonly containsSecret: boolean;
	readonly diagnostics: readonly WorkflowGraphDiagnostic[];
}

function projectSchemaValue(
	value: unknown,
	schemaId: string,
	path: string,
	depth = 0,
): SchemaProjection {
	if (depth > 24) {
		return {
			value: {},
			containsSecret: true,
			diagnostics: [{ code: 'WORKFLOW_SECRET_SCHEMA_VALUE', schemaId, path }],
		};
	}
	if (!record(value)) return { value, containsSecret: false, diagnostics: [] };
	const children = new Map<string, unknown>();
	const diagnostics: WorkflowGraphDiagnostic[] = [];
	let containsSecret = markedSecret(value);
	for (const [key, child] of Object.entries(value)) {
		if (SCHEMA_VALUE_KEYS.has(key)) continue;
		const childPath = `${path}/${pointerPart(key)}`;
		if (SCHEMA_MAP_KEYS.has(key) && record(child)) {
			const projected: Record<string, unknown> = {};
			for (const [name, nested] of Object.entries(child)) {
				const result = projectSchemaValue(
					nested,
					schemaId,
					`${childPath}/${pointerPart(name)}`,
					depth + 1,
				);
				projected[name] = result.value;
				containsSecret ||= result.containsSecret;
				diagnostics.push(...result.diagnostics);
			}
			children.set(key, projected);
			continue;
		}
		if (Array.isArray(child)) {
			const projected = child.map((nested, index) => {
				const result = projectSchemaValue(
					nested,
					schemaId,
					`${childPath}/${index}`,
					depth + 1,
				);
				containsSecret ||= result.containsSecret;
				diagnostics.push(...result.diagnostics);
				return result.value;
			});
			children.set(key, projected);
			continue;
		}
		if (record(child)) {
			const result = projectSchemaValue(child, schemaId, childPath, depth + 1);
			children.set(key, result.value);
			containsSecret ||= result.containsSecret;
			diagnostics.push(...result.diagnostics);
			continue;
		}
		children.set(key, child);
	}
	const projected: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (SCHEMA_VALUE_KEYS.has(key) && containsSecret) {
			diagnostics.push({
				code: 'WORKFLOW_SECRET_SCHEMA_VALUE',
				schemaId,
				path: `${path}/${pointerPart(key)}`,
			});
			continue;
		}
		projected[key] = children.get(key) ?? child;
	}
	return { value: projected, containsSecret, diagnostics };
}

function projectGraphSchemas(graph: WorkflowGraphV1): {
	readonly schemas: WorkflowGraphV1['schemas'];
	readonly diagnostics: readonly WorkflowGraphDiagnostic[];
} {
	const schemas: Record<string, JsonSchemaV1> = {};
	const diagnostics: WorkflowGraphDiagnostic[] = [];
	for (const [schemaId, schema] of Object.entries(graph.schemas)) {
		const result = projectSchemaValue(schema, schemaId, '');
		schemas[schemaId] = result.value as JsonSchemaV1;
		diagnostics.push(...result.diagnostics);
	}
	return { schemas, diagnostics };
}

export function secretSchemaValueDiagnostics(
	graph: WorkflowGraphV1,
): readonly WorkflowGraphDiagnostic[] {
	return projectGraphSchemas(graph).diagnostics;
}

function descendantSecret(value: unknown, depth = 0): boolean {
	if (depth > 24) return true;
	if (Array.isArray(value))
		return value.some((child) => descendantSecret(child, depth + 1));
	if (!record(value)) return false;
	if (markedSecret(value)) return true;
	return Object.values(value).some((child) =>
		descendantSecret(child, depth + 1),
	);
}

function opaqueSchema(value: unknown, depth = 0): boolean {
	if (depth > 24 || !record(value)) return true;
	if (
		'$ref' in value ||
		'oneOf' in value ||
		'anyOf' in value ||
		'allOf' in value ||
		'not' in value ||
		'if' in value ||
		'then' in value ||
		'else' in value ||
		'patternProperties' in value ||
		'unevaluatedProperties' in value ||
		'unevaluatedItems' in value ||
		'contains' in value ||
		'prefixItems' in value ||
		'propertyNames' in value ||
		'$defs' in value ||
		'definitions' in value ||
		'dependentSchemas' in value ||
		value.additionalProperties === true
	)
		return true;
	const properties = record(value.properties) ? value.properties : {};
	for (const child of Object.values(properties))
		if (opaqueSchema(child, depth + 1)) return true;
	for (const child of [value.items, value.additionalProperties])
		if (
			child !== undefined &&
			child !== true &&
			child !== false &&
			opaqueSchema(child, depth + 1)
		)
			return true;
	return false;
}

function bindingSafety(
	schema: Readonly<Record<string, unknown>> | undefined,
	pointer: string,
): 'safe' | 'secret' | 'unknown' {
	if (!record(schema)) return 'unknown';
	let current: Readonly<Record<string, unknown>> = schema;
	const segments =
		pointer === ''
			? []
			: pointer.startsWith('/')
				? pointer.slice(1).split('/')
				: null;
	if (!segments) return 'unknown';
	for (const segment of segments) {
		if (markedSecret(current)) return 'secret';
		if (
			'patternProperties' in current ||
			'unevaluatedProperties' in current ||
			'unevaluatedItems' in current ||
			'contains' in current ||
			'prefixItems' in current ||
			'propertyNames' in current ||
			'dependentSchemas' in current ||
			'$ref' in current ||
			'oneOf' in current ||
			'anyOf' in current ||
			'allOf' in current ||
			'if' in current ||
			'then' in current ||
			'else' in current ||
			'not' in current
		)
			return descendantSecret(current) ? 'secret' : 'unknown';
		const decoded = segment.replace(/~1/g, '/').replace(/~0/g, '~');
		const properties = record(current.properties) ? current.properties : null;
		const child =
			properties?.[decoded] ??
			(/^(0|[1-9][0-9]*)$/.test(decoded) && record(current.items)
				? current.items
				: undefined);
		if (!record(child))
			return descendantSecret(current.additionalProperties)
				? 'secret'
				: 'unknown';
		current = child;
	}
	if (descendantSecret(current)) return 'secret';
	return opaqueSchema(current) ? 'unknown' : 'safe';
}

function diagnostic(
	graph: WorkflowGraphV1,
	node: WorkflowActionNodeV1,
	mapping: WorkflowTargetMappingV1,
	lookup: WorkflowActionInputSchema,
): WorkflowActionBindingDiagnostic | null {
	const descriptorSafety = bindingSafety(
		lookup(node.action.actionId, node.action.contractVersion),
		mapping.targetPointer,
	);
	const inputId = node.inputPorts.find(
		(port) => port.name === 'input',
	)?.schemaId;
	const snapshotSafety = bindingSafety(
		inputId ? graph.schemas[inputId] : undefined,
		mapping.targetPointer,
	);
	const safety = snapshotSafety === 'secret' ? 'secret' : descriptorSafety;
	if (safety === 'safe') return null;
	return {
		code:
			safety === 'secret'
				? 'WORKFLOW_ACTION_SECRET_BINDING'
				: 'WORKFLOW_ACTION_SCHEMA_UNAVAILABLE',
		nodeId: node.id,
		targetPointer: mapping.targetPointer,
	};
}

export function actionBindingDiagnostics(
	graph: WorkflowGraphV1,
	lookup: WorkflowActionInputSchema,
): readonly WorkflowActionBindingDiagnostic[] {
	const diagnostics: WorkflowActionBindingDiagnostic[] = [];
	for (const node of graph.nodes) {
		if (node.type !== 'action') continue;
		for (const mapping of node.mappings ?? []) {
			const finding = diagnostic(graph, node, mapping, lookup);
			if (finding) diagnostics.push(finding);
		}
	}
	return diagnostics;
}

export function projectSafeGraph(
	graph: WorkflowGraphV1,
	lookup: WorkflowActionInputSchema,
): {
	readonly graph: WorkflowGraphV1;
	readonly diagnostics: readonly WorkflowGraphDiagnostic[];
} {
	const projectedSchemas = projectGraphSchemas(graph);
	const bindings = actionBindingDiagnostics(graph, lookup);
	const diagnostics = [...bindings, ...projectedSchemas.diagnostics];
	if (diagnostics.length === 0) return { graph, diagnostics };
	const affected = new Set(
		bindings.map((entry) => `${entry.nodeId}\u0000${entry.targetPointer}`),
	);
	return {
		graph: {
			...graph,
			schemas: projectedSchemas.schemas,
			nodes: graph.nodes.map((node) =>
				node.type === 'action' && node.mappings
					? {
							...node,
							mappings: node.mappings.map((mapping) =>
								affected.has(`${node.id}\u0000${mapping.targetPointer}`)
									? {
											...mapping,
											binding: { kind: 'literal', value: '[redacted]' },
										}
									: mapping,
							),
						}
					: node,
			),
		},
		diagnostics,
	};
}
