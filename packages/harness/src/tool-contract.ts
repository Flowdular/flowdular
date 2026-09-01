import { AgentHarnessError } from './errors.ts';

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const MIN_TOOL_TIMEOUT_MS = 250;
export const MAX_TOOL_TIMEOUT_MS = 600_000;
/* Tool output is re-fed to the model as context. 32 KB keeps one result from
   consuming the whole window or the run's token budget. */
export const MAX_TOOL_OUTPUT_CHARACTERS = 32 * 1_024;

type Schema = Readonly<Record<string, unknown>>;

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

function fail(path: string, reason: string): never {
	throw new AgentHarnessError(
		'TOOL_INPUT_INVALID',
		`Tool input ${path || 'value'} ${reason}.`,
	);
}

/* A deliberately small JSON Schema subset: type, enum, required, properties,
   additionalProperties: false, items. Tools that need more validate inside
   execute; this check exists so a model cannot hand a tool an unexpected
   shape without the run recording why it was refused. */
export function validateToolInput(
	schema: Schema | undefined,
	value: unknown,
	path = '',
): void {
	if (!schema) return;
	const expected = schema.type;
	if (typeof expected === 'string' && !matchesType(value, expected)) {
		fail(path, `must be of type ${expected}`);
	}
	if (
		Array.isArray(expected) &&
		!expected.some(
			(candidate) =>
				typeof candidate === 'string' && matchesType(value, candidate),
		)
	) {
		fail(path, `must be one of ${expected.join(', ')}`);
	}
	if (
		Array.isArray(schema.enum) &&
		!schema.enum.some((candidate) => candidate === value)
	) {
		fail(path, 'is not an allowed value');
	}
	if (typeOf(value) === 'object') {
		const record = value as Record<string, unknown>;
		const properties =
			schema.properties && typeof schema.properties === 'object'
				? (schema.properties as Record<string, Schema>)
				: {};
		for (const key of Array.isArray(schema.required) ? schema.required : []) {
			if (typeof key === 'string' && !(key in record)) {
				fail(`${path}${path ? '.' : ''}${key}`, 'is required');
			}
		}
		for (const [key, item] of Object.entries(record)) {
			const child = `${path}${path ? '.' : ''}${key}`;
			const property = properties[key];
			if (property) {
				validateToolInput(property, item, child);
			} else if (schema.additionalProperties === false) {
				fail(child, 'is not an accepted property');
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
			validateToolInput(schema.items as Schema, item, `${path}[${index}]`),
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
