import { AgentHarnessError } from './errors.ts';

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const MIN_TOOL_TIMEOUT_MS = 250;
export const MAX_TOOL_TIMEOUT_MS = 600_000;
/* Tool output is re-fed to the model as context. 32 KB keeps one result from
   consuming the whole window or the run's token budget. */
export const MAX_TOOL_OUTPUT_CHARACTERS = 32 * 1_024;

export type JsonSchema = Readonly<Record<string, unknown>>;

function typeOf(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
	const actual = typeOf(value);
	if (expected === 'integer') {
		return actual === 'number' && Number.isInteger(value);
	}
	if (expected === 'number') return actual === 'number';
	return actual === expected;
}

function fail(
	path: string,
	reason: string,
	code: string,
	label: string,
): never {
	throw new AgentHarnessError(code, `${label} ${path || 'value'} ${reason}.`);
}

/* A deliberately small JSON Schema subset: type, enum, required, properties,
   additionalProperties: false, items. Tools that need more validate inside
   execute; this check exists so a model cannot hand a tool an unexpected
   shape without the run recording why it was refused. */
export function validateToolInput(
	schema: JsonSchema | undefined,
	value: unknown,
	path = '',
): void {
	validateJsonValue(value, 'TOOL_INPUT_INVALID', 'Tool input');
	validateJsonSchemaValue(schema, value, {
		path,
		code: 'TOOL_INPUT_INVALID',
		label: 'Tool input',
	});
}

export function validateToolOutput(
	schema: JsonSchema | undefined,
	value: unknown,
): void {
	validateJsonValue(value, 'TOOL_OUTPUT_INVALID', 'Tool output');
	validateJsonSchemaValue(schema, value, {
		code: 'TOOL_OUTPUT_INVALID',
		label: 'Tool output',
	});
}

export function validateStructuredOutput(
	schema: JsonSchema,
	value: unknown,
): void {
	validateJsonValue(value, 'STRUCTURED_OUTPUT_INVALID', 'Structured output');
	validateJsonSchemaValue(schema, value, {
		code: 'STRUCTURED_OUTPUT_INVALID',
		label: 'Structured output',
	});
}

/* JSON schemas cannot make undefined, non-finite numbers, class instances, or
   cycles serializable. Durable outputs need that stronger wire guarantee. */
export function validateJsonValue(
	value: unknown,
	code = 'JSON_VALUE_INVALID',
	label = 'Value',
): void {
	const seen = new WeakSet<object>();
	const visit = (item: unknown, path: string): void => {
		if (
			item === null ||
			typeof item === 'string' ||
			typeof item === 'boolean'
		) {
			return;
		}
		if (typeof item === 'number') {
			if (Number.isFinite(item)) return;
			fail(path, 'must be a finite number', code, label);
		}
		if (typeof item !== 'object') {
			fail(path, 'must be JSON serializable', code, label);
		}
		if (seen.has(item)) fail(path, 'must not contain cycles', code, label);
		seen.add(item);
		if (Array.isArray(item)) {
			item.forEach((child, index) => visit(child, `${path}[${index}]`));
		} else {
			const prototype = Object.getPrototypeOf(item);
			if (prototype !== Object.prototype && prototype !== null) {
				fail(path, 'must contain only plain objects', code, label);
			}
			for (const [key, child] of Object.entries(item)) {
				visit(child, `${path}${path ? '.' : ''}${key}`);
			}
		}
		seen.delete(item);
	};
	visit(value, '');
}

function validateJsonSchemaValue(
	schema: JsonSchema | undefined,
	value: unknown,
	options: {
		readonly path?: string;
		readonly code: string;
		readonly label: string;
	},
): void {
	if (!schema) return;
	const path = options.path ?? '';
	const expected = schema.type;
	if (typeof expected === 'string' && !matchesType(value, expected)) {
		fail(path, `must be of type ${expected}`, options.code, options.label);
	}
	if (
		Array.isArray(expected) &&
		!expected.some(
			(candidate) =>
				typeof candidate === 'string' && matchesType(value, candidate),
		)
	) {
		fail(
			path,
			`must be one of ${expected.join(', ')}`,
			options.code,
			options.label,
		);
	}
	if (
		Array.isArray(schema.enum) &&
		!schema.enum.some((candidate) => candidate === value)
	) {
		fail(path, 'is not an allowed value', options.code, options.label);
	}
	if (typeOf(value) === 'object') {
		const record = value as Record<string, unknown>;
		const properties =
			schema.properties && typeof schema.properties === 'object'
				? (schema.properties as Record<string, JsonSchema>)
				: {};
		for (const key of Array.isArray(schema.required) ? schema.required : []) {
			if (typeof key === 'string' && !(key in record)) {
				fail(
					`${path}${path ? '.' : ''}${key}`,
					'is required',
					options.code,
					options.label,
				);
			}
		}
		for (const [key, item] of Object.entries(record)) {
			const child = `${path}${path ? '.' : ''}${key}`;
			const property = properties[key];
			if (property) {
				validateJsonSchemaValue(property, item, {
					...options,
					path: child,
				});
			} else if (schema.additionalProperties === false) {
				fail(child, 'is not an accepted property', options.code, options.label);
			}
		}
	}
	if (
		Array.isArray(value) &&
		schema.items &&
		typeof schema.items === 'object' &&
		!Array.isArray(schema.items)
	) {
		value.forEach((item, index) =>
			validateJsonSchemaValue(schema.items as JsonSchema, item, {
				...options,
				path: `${path}[${index}]`,
			}),
		);
	}
}

export interface BoundedToolOutput {
	readonly value: unknown;
	readonly characters: number;
	readonly truncated: boolean;
}

function serialize(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === undefined) return 'null';
	try {
		return JSON.stringify(value) ?? 'null';
	} catch {
		return String(value);
	}
}

/* Within the cap the output passes through unchanged so structured results
   stay structured. Over it the model receives a marked prefix instead. */
export function boundToolOutput(
	value: unknown,
	maximum = MAX_TOOL_OUTPUT_CHARACTERS,
): BoundedToolOutput {
	const serialized = serialize(value);
	if (serialized.length <= maximum) {
		return { value, characters: serialized.length, truncated: false };
	}
	const omitted = serialized.length - maximum;
	return {
		value: `${serialized.slice(0, maximum)}\n[tool output truncated: ${omitted} characters omitted]`,
		characters: serialized.length,
		truncated: true,
	};
}

export function toolTimeoutMs(value: number | undefined): number {
	if (value === undefined) return DEFAULT_TOOL_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(value) ||
		value < MIN_TOOL_TIMEOUT_MS ||
		value > MAX_TOOL_TIMEOUT_MS
	) {
		throw new AgentHarnessError(
			'INVALID_TOOL_TIMEOUT',
			`tool.timeoutMs must be between ${MIN_TOOL_TIMEOUT_MS} and ${MAX_TOOL_TIMEOUT_MS}.`,
		);
	}
	return value;
}
