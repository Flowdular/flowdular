import { describe, expect, expectTypeOf, it } from 'vitest';
import type { VariableDefinition } from '@coreloom/contracts';
import {
	variableChoiceLabel,
	variableSelectChoices,
	variableToken,
} from '../src/components/variable-select.ts';
import type { VariableFieldProps } from '../src/components/VariableField.tsrx';
import type { VariableSelectProps } from '../src/components/VariableSelect.tsrx';

const VARIABLES: readonly VariableDefinition[] = [
	{
		key: 'context.today',
		label: 'Today',
		kind: 'date',
		sample: '2026-01-01',
	},
	{
		key: 'party.name',
		label: 'Party name',
		kind: 'text',
		scope: 'parties.parties.read',
	},
];

describe('VariableSelect option model', () => {
	it('requires every user-visible field label from the translated caller', () => {
		expectTypeOf<
			Pick<
				VariableFieldProps,
				'label' | 'insertLabel' | 'variablesLabel' | 'emptyLabel'
			>
		>().toEqualTypeOf<{
			readonly label: string;
			readonly insertLabel: string;
			readonly variablesLabel: string;
			readonly emptyLabel: string;
		}>();
		expectTypeOf<
			Pick<
				VariableSelectProps,
				'label' | 'literalGroupLabel' | 'variablesGroupLabel'
			>
		>().toEqualTypeOf<{
			readonly label: string;
			readonly literalGroupLabel: string;
			readonly variablesGroupLabel: string;
		}>();
	});

	it('keeps literal choices and emits native option values for variables', () => {
		const choices = variableSelectChoices(
			[
				{ value: 'draft', label: 'Draft' },
				{ value: 'closed', label: 'Closed', disabled: true },
			],
			VARIABLES.slice(0, 1),
		);

		expect(
			choices.map(({ kind, value, disabled }) => ({
				kind,
				value,
				disabled,
			})),
		).toEqual([
			{ kind: 'literal', value: 'draft', disabled: false },
			{ kind: 'literal', value: 'closed', disabled: true },
			{
				kind: 'variable',
				value: '{{ context.today }}',
				disabled: false,
			},
		]);
	});

	it('uses current samples before definition samples in the native label', () => {
		const choice = variableSelectChoices([], VARIABLES.slice(0, 1), {
			'context.today': '2026-09-02',
		})[0];
		expect(choice?.kind).toBe('variable');
		if (!choice || choice.kind !== 'variable') return;
		expect(variableChoiceLabel(choice)).toBe(
			'Today ({{ context.today }} · 2026-09-02)',
		);
	});

	it('offers only definitions supplied by the already-filtered caller', () => {
		const choices = variableSelectChoices([], VARIABLES.slice(0, 1));
		expect(choices.map((choice) => choice.value)).toEqual([
			'{{ context.today }}',
		]);
		expect(choices.some((choice) => choice.value.includes('party.name'))).toBe(
			false,
		);
		expect(variableToken('context.user.displayName')).toBe(
			'{{ context.user.displayName }}',
		);
	});
});
