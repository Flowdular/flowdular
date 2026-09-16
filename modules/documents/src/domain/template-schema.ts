import { DOCUMENT_TEMPLATE_LIMITS } from './templates.ts';

export type TemplateScalarSchema =
	| {
			readonly type: 'string';
			readonly maxLength?: number;
			readonly enum?: readonly string[];
			readonly title?: string;
			readonly description?: string;
	  }
	| {
			readonly type: 'number' | 'integer' | 'boolean';
			readonly title?: string;
			readonly description?: string;
	  };

export interface TemplateObjectSchema {
	readonly type: 'object';
	readonly properties: Readonly<Record<string, TemplateInputSchema>>;
	readonly required?: readonly string[];
	readonly title?: string;
	readonly description?: string;
}

export interface TemplateArraySchema {
	readonly type: 'array';
	readonly items: TemplateObjectSchema | TemplateScalarSchema;
	readonly title?: string;
	readonly description?: string;
}

/** The JSON Schema subset a template declares its input with. */
export type TemplateInputSchema =
	| TemplateObjectSchema
	| TemplateArraySchema
	| TemplateScalarSchema;

export interface TemplateInputIssue {
	readonly path: string;
	readonly code:
		| 'REQUIRED'
		| 'TYPE'
		| 'MAX_LENGTH'
		| 'ENUM'
		| 'TOO_MANY_ITEMS'
		| 'TOO_LARGE';
	readonly message: string;
}

const PROPERTY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ANNOTATIONS = ['title', 'description'] as const;

function plainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

/**
 * Why a value is not a schema of the subset, or null when it is. Keywords
 * outside the subset are refused rather than ignored, so a schema never
 * promises a check the validator does not make.
 */
export function templateSchemaProblem(value: unknown): string | null {
	if (!plainObject(value) || value.type !== 'object') {
		return 'The input schema must be an object schema at its root.';
	}
	return schemaProblem(value, '', 1, false);
}

function schemaProblem(
	value: unknown,
	path: string,
	depth: number,
	inArray: boolean,
): string | null {
	const at = path === '' ? 'the root' : path;
	if (!plainObject(value)) return `The schema at ${at} must be an object.`;
	if (depth > DOCUMENT_TEMPLATE_LIMITS.schemaDepth) {
		return `The schema nests deeper than ${DOCUMENT_TEMPLATE_LIMITS.schemaDepth} levels at ${at}.`;
	}
	const allowed = new Set<string>(['type', ...ANNOTATIONS]);
	for (const annotation of ANNOTATIONS) {
		if (annotation in value && typeof value[annotation] !== 'string') {
			return `${annotation} at ${at} must be text.`;
		}
	}
	switch (value.type) {
		case 'object': {
			allowed.add('properties').add('required');
			if (!plainObject(value.properties)) {
				return `The object at ${at} must declare properties.`;
			}
			const names = Object.keys(value.properties);
			if (names.length > DOCUMENT_TEMPLATE_LIMITS.schemaProperties) {
				return `The object at ${at} declares more than ${DOCUMENT_TEMPLATE_LIMITS.schemaProperties} properties.`;
			}
			for (const name of names) {
				if (!PROPERTY.test(name)) {
					return `The property name "${name.slice(0, 64)}" at ${at} is not an identifier.`;
				}
				const problem = schemaProblem(
					value.properties[name],
					path === '' ? name : `${path}.${name}`,
					depth + 1,
					false,
				);
				if (problem) return problem;
			}
			if (
				value.required !== undefined &&
				(!Array.isArray(value.required) ||
					value.required.some(
						(entry) => typeof entry !== 'string' || !names.includes(entry),
					))
			) {
				return `required at ${at} must list declared properties.`;
			}
			break;
		}
		case 'array': {
			allowed.add('items');
			if (inArray) return `An array at ${at} may not hold arrays.`;
			if (!plainObject(value.items) || value.items.type === 'array') {
				return `The array at ${at} must declare items of an object or a scalar.`;
			}
			const problem = schemaProblem(value.items, `${path}[]`, depth + 1, true);
			if (problem) return problem;
			break;
		}
		case 'string': {
			allowed.add('maxLength').add('enum');
			if (
				value.maxLength !== undefined &&
				(!Number.isSafeInteger(value.maxLength) ||
					(value.maxLength as number) < 1 ||
					(value.maxLength as number) >
						DOCUMENT_TEMPLATE_LIMITS.stringCharacters)
			) {
				return `maxLength at ${at} must be a whole number from 1 to ${DOCUMENT_TEMPLATE_LIMITS.stringCharacters}.`;
			}
			if (
				value.enum !== undefined &&
				(!Array.isArray(value.enum) ||
					value.enum.length === 0 ||
					value.enum.some((entry) => typeof entry !== 'string'))
			) {
				return `enum at ${at} must list text values.`;
			}
			break;
		}
		case 'number':
		case 'integer':
		case 'boolean':
			break;
		default:
			return `The type at ${at} must be object, array, string, number, integer or boolean.`;
	}
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			return `The keyword "${key.slice(0, 64)}" at ${at} is outside the supported schema subset.`;
		}
	}
	return null;
}

/**
 * Checks an input against a schema already accepted by
 * `templateSchemaProblem`. Properties the schema does not declare are ignored:
 * no placeholder can reach them.
 */
export function validateTemplateInput(
	schema: TemplateObjectSchema,
	input: unknown,
): readonly TemplateInputIssue[] {
	const issues: TemplateInputIssue[] = [];
	const push = (issue: TemplateInputIssue) => {
		if (issues.length < DOCUMENT_TEMPLATE_LIMITS.inputIssues)
			issues.push(issue);
	};
	check(schema, input, '', push);
	return issues;
}

function label(path: string): string {
	return path === '' ? 'The input' : path;
}

function check(
	schema: TemplateInputSchema,
	value: unknown,
	path: string,
	push: (issue: TemplateInputIssue) => void,
): void {
	switch (schema.type) {
		case 'object': {
			if (!plainObject(value)) {
				push({
					path,
					code: 'TYPE',
					message: `${label(path)} must be an object.`,
				});
				return;
			}
			for (const name of schema.required ?? []) {
				if (!Object.hasOwn(value, name) || value[name] === null) {
					const child = path === '' ? name : `${path}.${name}`;
					push({
						path: child,
						code: 'REQUIRED',
						message: `${child} is required.`,
					});
				}
			}
			for (const [name, child] of Object.entries(schema.properties)) {
				if (!Object.hasOwn(value, name)) continue;
				const entry = value[name];
				if (entry === null || entry === undefined) continue;
				check(child, entry, path === '' ? name : `${path}.${name}`, push);
			}
			return;
		}
		case 'array': {
			if (!Array.isArray(value)) {
				push({ path, code: 'TYPE', message: `${label(path)} must be a list.` });
				return;
			}
			if (value.length > DOCUMENT_TEMPLATE_LIMITS.arrayItems) {
				push({
					path,
					code: 'TOO_MANY_ITEMS',
					message: `${label(path)} holds more than ${DOCUMENT_TEMPLATE_LIMITS.arrayItems} items.`,
				});
				return;
			}
			value.forEach((item, index) =>
				check(schema.items, item, `${path}[${index}]`, push),
			);
			return;
		}
		case 'string': {
			if (typeof value !== 'string') {
				push({ path, code: 'TYPE', message: `${label(path)} must be text.` });
				return;
			}
			const max = Math.min(
				schema.maxLength ?? DOCUMENT_TEMPLATE_LIMITS.stringCharacters,
				DOCUMENT_TEMPLATE_LIMITS.stringCharacters,
			);
			if (value.length > max) {
				push({
					path,
					code: 'MAX_LENGTH',
					message: `${label(path)} is longer than ${max} characters.`,
				});
			}
			if (schema.enum && !schema.enum.includes(value)) {
				push({
					path,
					code: 'ENUM',
					message: `${label(path)} must be one of ${schema.enum.join(', ')}.`,
				});
			}
			return;
		}
		case 'integer':
			if (!Number.isSafeInteger(value)) {
				push({
					path,
					code: 'TYPE',
					message: `${label(path)} must be a whole number.`,
				});
			}
			return;
		case 'number':
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				push({
					path,
					code: 'TYPE',
					message: `${label(path)} must be a number.`,
				});
			}
			return;
		case 'boolean':
			if (typeof value !== 'boolean') {
				push({
					path,
					code: 'TYPE',
					message: `${label(path)} must be true or false.`,
				});
			}
			return;
	}
}

/** A spec entity field, as `templates[].inputEntity` names one. */
export interface TemplateEntityField {
	readonly id: string;
	readonly type: string;
	readonly required?: boolean;
	readonly maxLength?: number;
	readonly values?: readonly string[];
	readonly description?: string;
}

/**
 * The input schema of a template that reads one record of an entity. A json
 * field has no printable shape and is left out.
 */
export function templateInputSchemaFromFields(
	fields: readonly TemplateEntityField[],
): TemplateObjectSchema {
	const properties: Record<string, TemplateInputSchema> = {};
	const required: string[] = [];
	for (const field of fields) {
		const annotation = field.description
			? { description: field.description }
			: {};
		let schema: TemplateInputSchema | null;
		switch (field.type) {
			case 'integer':
				schema = { type: 'integer', ...annotation };
				break;
			case 'decimal':
				schema = { type: 'number', ...annotation };
				break;
			case 'boolean':
				schema = { type: 'boolean', ...annotation };
				break;
			case 'enum':
				schema = {
					type: 'string',
					...(field.values ? { enum: field.values } : {}),
					...annotation,
				};
				break;
			case 'json':
				schema = null;
				break;
			default:
				schema = {
					type: 'string',
					...(field.maxLength ? { maxLength: field.maxLength } : {}),
					...annotation,
				};
		}
		if (!schema) continue;
		properties[field.id] = schema;
		if (field.required) required.push(field.id);
	}
	return {
		type: 'object',
		properties,
		...(required.length ? { required } : {}),
	};
}

/** JSON with object keys in code point order, so equal values digest equally. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return (
			'[' + value.map((entry) => canonicalJson(entry ?? null)).join(',') + ']'
		);
	}
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return (
			'{' +
			Object.keys(record)
				.filter((key) => record[key] !== undefined)
				.sort()
				.map((key) => JSON.stringify(key) + ':' + canonicalJson(record[key]))
				.join(',') +
			'}'
		);
	}
	return JSON.stringify(value) ?? 'null';
}
