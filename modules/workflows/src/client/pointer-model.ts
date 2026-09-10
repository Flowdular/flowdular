import type { JsonSchemaV1, WorkflowGraphV1 } from '../domain/types.ts';

export interface PointerSuggestion {
	readonly pointer: string;
	readonly label: string;
	readonly type: string;
	readonly description: string;
	readonly required: boolean;
	readonly arrayExample: boolean;
}

export interface PointerCatalog {
	readonly entries: readonly PointerSuggestion[];
	readonly incomplete: boolean;
	readonly truncated: boolean;
}

function record(value: unknown): value is JsonSchemaV1 {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Bounded schema-only discovery. Never inspects execution payloads or fetches data. */
export function pointerCatalog(
	schema: JsonSchemaV1 | undefined,
	arrays = true,
): PointerCatalog {
	const entries: PointerSuggestion[] = [];
	let incomplete = !schema;
	let truncated = false;
	const visit = (
		value: JsonSchemaV1,
		pointer: string,
		name: string,
		required: boolean,
		arrayExample: boolean,
		depth: number,
	) => {
		if (entries.length >= 500 || depth > 16 || pointer.length > 1024) {
			truncated = true;
			return;
		}
		const type =
			typeof value.type === 'string'
				? value.type
				: record(value.properties)
					? 'object'
					: value.items
						? 'array'
						: 'unknown';
		entries.push({
			pointer,
			label: typeof value.title === 'string' ? value.title : name,
			type,
			description:
				typeof value.description === 'string' ? value.description : '',
			required,
			arrayExample,
		});
		if (
			type === 'unknown' ||
			value.$ref ||
			value.oneOf ||
			value.anyOf ||
			value.allOf
		)
			incomplete = true;
		if (type === 'object' || record(value.properties)) {
			if (value.additionalProperties !== false) incomplete = true;
			if (record(value.properties)) {
				for (const [key, child] of Object.entries(value.properties)) {
					if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
					if (entries.length >= 500) {
						truncated = true;
						break;
					}
					const path =
						pointer + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1');
					visit(
						record(child) ? child : {},
						path,
						key,
						required &&
							Array.isArray(value.required) &&
							value.required.includes(key),
						arrayExample,
						depth + 1,
					);
				}
			}
		}
		if (type === 'array') {
			if (arrays && record(value.items))
				visit(value.items, pointer + '/0', '0', false, true, depth + 1);
			else incomplete = true;
		}
	};
	visit(schema ?? {}, '', '', true, false, 0);
	return { entries, incomplete, truncated };
}

export function sourcePointerCatalog(
	graph: WorkflowGraphV1,
	sourceKey: string,
): PointerCatalog {
	const [nodeId, portName] = sourceKey.split('|');
	const port = graph.nodes
		.find((node) => node.id === nodeId)
		?.outputPorts.find((entry) => entry.name === portName);
	return pointerCatalog(port ? graph.schemas[port.schemaId] : undefined);
}

export function filterPointers(
	entries: readonly PointerSuggestion[],
	query: string,
): readonly PointerSuggestion[] {
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return entries.filter((entry) => {
		const text = [entry.pointer, entry.label, entry.type, entry.description]
			.join(' ')
			.toLowerCase();
		return words.every((word) => text.includes(word));
	});
}
