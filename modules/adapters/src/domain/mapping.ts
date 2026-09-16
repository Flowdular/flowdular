import { jsonSize, readPath, validPath } from './paths.ts';
import {
	ADAPTER_TRANSFORMS,
	type AdapterDirection,
	type AdapterMappingRule,
} from './registry.ts';
import { ADAPTER_LIMITS } from './types.ts';

export class AdapterMappingError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'AdapterMappingError';
	}
}

export const MAPPING_FORMATS = [
	'trim',
	'lower',
	'upper',
	'integer',
	'decimal',
	'boolean',
	'iso-date',
] as const;

const DATE_LAYOUT = /^date:(?=.*YYYY)(?=.*MM)(?=.*DD)(YYYY|MM|DD|[./ -]){3,5}$/;

export function knownFormat(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		((MAPPING_FORMATS as readonly string[]).includes(value) ||
			(DATE_LAYOUT.test(value) && value.length <= 32))
	);
}

/** The fields a source mapping writes, or the columns a sink mapping reads. */
export type MappingTarget =
	| {
			readonly direction: 'source';
			readonly fields: readonly {
				readonly id: string;
				readonly required: boolean;
			}[];
	  }
	| { readonly direction: 'sink'; readonly columns: readonly string[] };

function invalid(message: string): AdapterMappingError {
	return new AdapterMappingError('MAPPING_INVALID', message);
}

function text(value: unknown, max: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/**
 * The rules as stored or registered, checked for shape alone: the transforms,
 * the paths, the values each transform needs and the bounds. Answers a copy
 * holding only the declared keys.
 */
export function readMapping(
	raw: unknown,
	direction: AdapterDirection,
): readonly AdapterMappingRule[] {
	if (
		!Array.isArray(raw) ||
		raw.length === 0 ||
		raw.length > ADAPTER_LIMITS.mappingRules
	) {
		throw invalid(`A mapping has 1 to ${ADAPTER_LIMITS.mappingRules} rules.`);
	}
	const size = jsonSize(raw);
	if (size === null || size > ADAPTER_LIMITS.mappingJson) {
		throw invalid('The mapping is larger than 32 KB.');
	}
	const targets = new Set<string>();
	return raw.map((entry, index): AdapterMappingRule => {
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
			throw invalid(`Rule ${index + 1} is not an object.`);
		}
		const rule = entry as Record<string, unknown>;
		const transform = rule['transform'];
		if (!(ADAPTER_TRANSFORMS as readonly unknown[]).includes(transform)) {
			throw invalid(`Rule ${index + 1} names an unknown transform.`);
		}
		const to = rule['to'];
		if (!validPath(to, false) || (direction === 'source' && to.includes('.'))) {
			throw invalid(`Rule ${index + 1} writes to an invalid field.`);
		}
		if (targets.has(to)) {
			throw invalid(`Two rules write ${to}.`);
		}
		targets.add(to);
		const from = rule['from'];
		const value = rule['value'];
		const table = rule['table'];
		if (transform !== 'constant' && !validPath(from, false)) {
			throw invalid(`Rule ${index + 1} reads from an invalid path.`);
		}
		if (transform === 'constant' && !text(value, ADAPTER_LIMITS.value)) {
			throw invalid(`The constant rule for ${to} carries no value.`);
		}
		if (transform === 'format' && !knownFormat(value)) {
			throw invalid(`The format rule for ${to} names an unknown format.`);
		}
		if (
			transform === 'lookup' &&
			value !== undefined &&
			value !== null &&
			!text(value, ADAPTER_LIMITS.lookupText)
		) {
			throw invalid(`The lookup rule for ${to} carries an invalid key.`);
		}
		let lookup: Record<string, string> | undefined;
		if (table !== undefined && table !== null) {
			if (
				transform !== 'lookup' ||
				typeof table !== 'object' ||
				Array.isArray(table)
			) {
				throw invalid(`Only a lookup rule carries a table.`);
			}
			const entries = Object.entries(table as Record<string, unknown>);
			if (entries.length > ADAPTER_LIMITS.lookupEntries) {
				throw invalid(
					`A lookup table holds at most ${ADAPTER_LIMITS.lookupEntries} values.`,
				);
			}
			for (const [key, mapped] of entries) {
				if (
					key.length > ADAPTER_LIMITS.lookupText ||
					!text(mapped, ADAPTER_LIMITS.lookupText)
				) {
					throw invalid(`The lookup table for ${to} holds an invalid value.`);
				}
			}
			lookup = Object.fromEntries(entries) as Record<string, string>;
		}
		return {
			...(transform === 'constant' ? {} : { from: from as string }),
			to,
			transform: transform as AdapterMappingRule['transform'],
			...(typeof value === 'string' ? { value } : {}),
			...(lookup ? { table: lookup } : {}),
		};
	});
}

/**
 * The rules against what they write or read: for a source every target is a
 * port field and every required field is written, for a sink every source is a
 * list column.
 */
export function assertMappingTarget(
	rules: readonly AdapterMappingRule[],
	target: MappingTarget,
): void {
	if (target.direction === 'source') {
		const fields = new Set(target.fields.map((field) => field.id));
		for (const rule of rules) {
			if (!fields.has(rule.to)) {
				throw invalid(`The port has no field ${rule.to}.`);
			}
		}
		const written = new Set(rules.map((rule) => rule.to));
		for (const field of target.fields) {
			if (field.required && !written.has(field.id)) {
				throw invalid(`No rule writes the required field ${field.id}.`);
			}
		}
		return;
	}
	const columns = new Set(target.columns);
	for (const rule of rules) {
		if (rule.transform !== 'constant' && !columns.has(rule.from ?? '')) {
			throw invalid(`The list has no column ${rule.from}.`);
		}
	}
}

const INTEGER = /^-?\d{1,15}$/;
const DECIMAL = /^-?\d{1,18}([.,]\d{1,12})?$/;
const BOOLEANS: Readonly<Record<string, string>> = {
	true: 'true',
	yes: 'true',
	'1': 'true',
	false: 'false',
	no: 'false',
	'0': 'false',
};

function isoDate(year: number, month: number, day: number): string | null {
	if (year < 1 || month < 1 || month > 12 || day < 1) return null;
	const probe = new Date(Date.UTC(year, month - 1, day));
	if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
		return null;
	}
	return (
		String(year).padStart(4, '0') +
		'-' +
		String(month).padStart(2, '0') +
		'-' +
		String(day).padStart(2, '0')
	);
}

function layoutDate(layout: string, value: string): string | null {
	const tokens = layout.match(/YYYY|MM|DD|[./ -]/g) ?? [];
	let position = 0;
	const parts: Record<string, number> = {};
	for (const token of tokens) {
		if (token === 'YYYY' || token === 'MM' || token === 'DD') {
			const width = token.length;
			const digits = value.slice(position, position + width);
			if (!/^\d+$/.test(digits) || digits.length !== width) return null;
			parts[token] = Number(digits);
			position += width;
		} else {
			if (value[position] !== token) return null;
			position += 1;
		}
	}
	if (position !== value.length) return null;
	return isoDate(parts['YYYY']!, parts['MM']!, parts['DD']!);
}

/** The formatted text, or null when the value does not parse. */
export function formatValue(format: string, value: string): string | null {
	const trimmed = value.trim();
	switch (format) {
		case 'trim':
			return trimmed;
		case 'lower':
			return trimmed.toLowerCase();
		case 'upper':
			return trimmed.toUpperCase();
		case 'integer':
			return INTEGER.test(trimmed) ? String(Number(trimmed)) : null;
		case 'decimal':
			return DECIMAL.test(trimmed) ? trimmed.replace(',', '.') : null;
		case 'boolean':
			return BOOLEANS[trimmed.toLowerCase()] ?? null;
		case 'iso-date': {
			const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.+\-Z]{1,24})?$/.exec(
				trimmed,
			);
			return match
				? isoDate(Number(match[1]), Number(match[2]), Number(match[3]))
				: null;
		}
		default:
			return format.startsWith('date:')
				? layoutDate(format.slice('date:'.length), trimmed)
				: null;
	}
}

export type MappedRecord =
	| { readonly ok: true; readonly values: Readonly<Record<string, string>> }
	| { readonly ok: false; readonly field: string; readonly code: string };

/**
 * One record through the rules, in order. A value the record does not carry,
 * or carries as null, leaves the target absent rather than empty.
 */
export function applyMapping(
	rules: readonly AdapterMappingRule[],
	record: unknown,
): MappedRecord {
	const values: Record<string, string> = {};
	for (const rule of rules) {
		if (rule.transform === 'constant') {
			values[rule.to] = rule.value ?? '';
			continue;
		}
		const raw = readPath(record, rule.from ?? '');
		if (raw === undefined || raw === null) continue;
		if (
			(typeof raw !== 'string' &&
				typeof raw !== 'number' &&
				typeof raw !== 'boolean') ||
			(typeof raw === 'number' && !Number.isFinite(raw))
		) {
			return { ok: false, field: rule.to, code: 'MAPPING_VALUE_INVALID' };
		}
		const source = String(raw);
		if (source.length > ADAPTER_LIMITS.value) {
			return { ok: false, field: rule.to, code: 'MAPPING_VALUE_INVALID' };
		}
		if (rule.transform === 'rename') {
			values[rule.to] = source;
			continue;
		}
		if (rule.transform === 'format') {
			const formatted = formatValue(rule.value ?? '', source);
			if (formatted === null) {
				return { ok: false, field: rule.to, code: 'MAPPING_FORMAT_INVALID' };
			}
			values[rule.to] = formatted;
			continue;
		}
		if (!rule.table || !Object.hasOwn(rule.table, source)) {
			return { ok: false, field: rule.to, code: 'MAPPING_LOOKUP_UNMATCHED' };
		}
		values[rule.to] = rule.table[source]!;
	}
	return { ok: true, values };
}
