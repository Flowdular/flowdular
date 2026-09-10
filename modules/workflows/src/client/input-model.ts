import type {
	JsonSchemaV1,
	JsonValue,
	WorkflowGraphV1,
} from '../domain/types.ts';

export const INPUT_FIELD_TYPES = [
	'string',
	'number',
	'integer',
	'boolean',
	'object',
	'array',
] as const;
export type InputFieldType = (typeof INPUT_FIELD_TYPES)[number];
export function inputFields(schema: JsonSchemaV1) {
	const properties = schema.properties;
	if (
		!properties ||
		typeof properties !== 'object' ||
		Array.isArray(properties)
	)
		return [];
	return Object.entries(properties).flatMap(([name, value]) =>
		value && typeof value === 'object' && !Array.isArray(value)
			? [
					{
						name,
						schema: value as JsonSchemaV1,
						required:
							Array.isArray(schema.required) && schema.required.includes(name),
					},
				]
			: [],
	);
}
export function workflowInputSchema(graph: WorkflowGraphV1): JsonSchemaV1 {
	const id = graph.nodes.find((node) => node.type === 'input')?.outputPorts[0]
		?.schemaId;
	return id ? (graph.schemas[id] ?? {}) : {};
}
export function updateInputField(
	schema: JsonSchemaV1,
	original: string | null,
	name: string,
	field: JsonSchemaV1,
	required: boolean,
): JsonSchemaV1 {
	if (
		!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name) ||
		['constructor', 'prototype'].includes(name)
	)
		throw new Error('WORKFLOW_FIELD_NAME_INVALID');
	const properties = Object.fromEntries(
		inputFields(schema).map((entry) => [entry.name, entry.schema]),
	);
	if (original !== name && Object.hasOwn(properties, name))
		throw new Error('WORKFLOW_FIELD_DUPLICATE');
	if (original) delete properties[original];
	properties[name] = field;
	const names = (Array.isArray(schema.required) ? schema.required : []).filter(
		(entry) => entry !== original && entry !== name,
	);
	if (required) names.push(name);
	return { ...schema, type: 'object', properties, required: names };
}
export function removeInputField(
	schema: JsonSchemaV1,
	name: string,
): JsonSchemaV1 {
	return {
		...schema,
		properties: Object.fromEntries(
			inputFields(schema)
				.filter((entry) => entry.name !== name)
				.map((entry) => [entry.name, entry.schema]),
		),
		required: (Array.isArray(schema.required) ? schema.required : []).filter(
			(entry) => entry !== name,
		),
	};
}
export function setInputValue(
	text: string,
	name: string,
	value: JsonValue | undefined,
): string {
	const parsed: unknown = JSON.parse(text);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
		throw new Error('WORKFLOW_INPUT_INVALID');
	const next = { ...parsed };
	if (value === undefined) delete (next as Record<string, unknown>)[name];
	else
		Object.defineProperty(next, name, {
			value,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	return JSON.stringify(next, null, 2);
}

export function parseInputFieldText(
	type: unknown,
	text: string,
): JsonValue | undefined {
	if (type === 'string') return text;
	if (text === '') return undefined;
	const value: JsonValue = JSON.parse(text);
	const valid =
		type === 'object'
			? value !== null && typeof value === 'object' && !Array.isArray(value)
			: type === 'array'
				? Array.isArray(value)
				: type === 'integer'
					? typeof value === 'number' && Number.isSafeInteger(value)
					: type === 'number'
						? typeof value === 'number' && Number.isFinite(value)
						: type === 'boolean'
							? typeof value === 'boolean'
							: true;
	if (!valid) throw new Error('WORKFLOW_INPUT_INVALID');
	return value;
}
