import { describe, expect, it } from 'vitest';
import {
	extractVariables,
	isVariableKey,
	resolveTemplate,
	tokenizeTemplate,
	validateTemplate,
	variableDefinitions,
	variablesForScopes,
	type VariableDefinition,
} from '../src/variables.ts';

const AVAILABLE: readonly VariableDefinition[] = [
	{ key: 'context.today', label: 'Today', kind: 'date' },
	{ key: 'context.user.displayName', label: 'User', kind: 'text' },
	{
		key: 'party.name',
		label: 'Party name',
		kind: 'text',
		scope: 'parties.party.read',
	},
];

describe('isVariableKey', () => {
	it('accepts lowercase and camelCase dotted segments', () => {
		expect(isVariableKey('today')).toBe(true);
		expect(isVariableKey('context.today')).toBe(true);
		expect(isVariableKey('context.user.displayName')).toBe(true);
		expect(isVariableKey('party.name')).toBe(true);
	});

	it('rejects malformed keys', () => {
		expect(isVariableKey('')).toBe(false);
		expect(isVariableKey('1context')).toBe(false);
		expect(isVariableKey('Context.today')).toBe(false);
		expect(isVariableKey('context.')).toBe(false);
		expect(isVariableKey('context..today')).toBe(false);
		expect(isVariableKey('context.9x')).toBe(false);
		expect(isVariableKey('context-today')).toBe(false);
	});
});

describe('extractVariables', () => {
	it('returns trimmed, deduped tokens in first-seen order', () => {
		expect(
			extractVariables('{{ a }} then {{b}} then {{  a  }} and {{ c.d }}'),
		).toEqual(['a', 'b', 'c.d']);
	});

	it('ignores empty tokens', () => {
		expect(extractVariables('before {{}} {{   }} after')).toEqual([]);
	});

	it('does not treat an escaped opener as a token', () => {
		expect(extractVariables('literal \\{{ a }} and real {{ b }}')).toEqual([
			'b',
		]);
	});

	it('reads the innermost token of nested-looking braces', () => {
		expect(extractVariables('{{ {{ a }} }}')).toEqual(['a']);
	});
});

describe('tokenizeTemplate', () => {
	it('reconstructs the exact input from segment text', () => {
		const input = 'Hi {{ name }}, escaped \\{{ x }} and {{ empty}}? end';
		const joined = tokenizeTemplate(input)
			.map((segment) => segment.text)
			.join('');
		expect(joined).toBe(input);
	});

	it('marks only real tokens as variable segments', () => {
		const segments = tokenizeTemplate('a \\{{ x }} {{ y }} b');
		const variables = segments.filter((segment) => segment.kind === 'variable');
		expect(variables).toEqual([
			{ kind: 'variable', key: 'y', text: '{{ y }}' },
		]);
	});
});

describe('validateTemplate', () => {
	it('flags tokens not present in the available set', () => {
		const report = validateTemplate(
			'{{ context.today }} {{ missing.one }}',
			AVAILABLE,
		);
		expect(report.unknown).toEqual(['missing.one']);
		expect(report.forbidden).toEqual([]);
	});

	it('flags scoped tokens the caller may not read', () => {
		const report = validateTemplate(
			'{{ party.name }} {{ context.today }}',
			AVAILABLE,
			['catalog.item.read'],
		);
		expect(report.unknown).toEqual([]);
		expect(report.forbidden).toEqual(['party.name']);
	});

	it('allows a scoped token when the scope is granted', () => {
		const report = validateTemplate('{{ party.name }}', AVAILABLE, [
			'parties.party.read',
		]);
		expect(report.forbidden).toEqual([]);
	});

	it('does not flag scoped tokens when no allowedScopes are given', () => {
		const report = validateTemplate('{{ party.name }}', AVAILABLE);
		expect(report.forbidden).toEqual([]);
		expect(report.unknown).toEqual([]);
	});
});

describe('variable sources', () => {
	it('flattens registered sources and filters scoped variables', () => {
		const available = variableDefinitions([
			{ id: 'context', variables: AVAILABLE.slice(0, 2) },
			{ id: 'party', variables: AVAILABLE.slice(2) },
		]);
		expect(variablesForScopes(available, [])).toEqual(AVAILABLE.slice(0, 2));
		expect(variablesForScopes(available, ['parties.party.read'])).toEqual(
			AVAILABLE,
		);
	});
});

describe('resolveTemplate', () => {
	const values = {
		name: 'Ada',
		'context.today': '2026-09-01',
	};

	it('substitutes known keys and trims surrounding spaces', () => {
		expect(resolveTemplate('Hi {{ name }} on {{context.today}}.', values)).toBe(
			'Hi Ada on 2026-09-01.',
		);
	});

	it('keeps unresolved tokens verbatim by default', () => {
		expect(resolveTemplate('Hi {{ name }} and {{ missing }}', values)).toBe(
			'Hi Ada and {{ missing }}',
		);
	});

	it('blanks unresolved tokens when asked', () => {
		expect(
			resolveTemplate('Hi {{ name }} and {{ missing }}', values, {
				onMissing: 'blank',
			}),
		).toBe('Hi Ada and ');
	});

	it('emits a literal opener for an escaped token', () => {
		expect(resolveTemplate('use \\{{ name }} verbatim', values)).toBe(
			'use {{ name }} verbatim',
		);
	});

	it('does not re-scan a substituted value that looks like a token', () => {
		expect(resolveTemplate('{{ a }}', { a: '{{ b }}', b: 'deep' })).toBe(
			'{{ b }}',
		);
	});

	it('never resolves inherited or prototype keys', () => {
		expect(resolveTemplate('{{ toString }}', values)).toBe('{{ toString }}');
		expect(
			resolveTemplate('{{ __proto__ }}', values, { onMissing: 'blank' }),
		).toBe('');
	});
});
