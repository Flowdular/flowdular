import type { VariableDefinition } from '@flowdular/contracts';
import { previewValue } from './variable-field.ts';

export interface VariableSelectLiteralOption {
	readonly value: string;
	readonly label: string;
	readonly disabled?: boolean;
}

export type VariableSelectChoice =
	| {
			readonly id: string;
			readonly kind: 'literal';
			readonly value: string;
			readonly label: string;
			readonly disabled: boolean;
	  }
	| {
			readonly id: string;
			readonly kind: 'variable';
			readonly value: string;
			readonly label: string;
			readonly key: string;
			readonly preview: string;
			readonly disabled: false;
	  };

export function variableToken(key: string): string {
	return `{{ ${key} }}`;
}

/* Builds the native option model from literals and definitions the caller has
   already filtered by scope. It does not discover or resolve any value. */
export function variableSelectChoices(
	options: readonly VariableSelectLiteralOption[],
	variables: readonly VariableDefinition[],
	sampleValues?: Record<string, string>,
): readonly VariableSelectChoice[] {
	return [
		...options.map((option, index) => ({
			id: `literal:${index}:${option.value}`,
			kind: 'literal' as const,
			value: option.value,
			label: option.label,
			disabled: option.disabled ?? false,
		})),
		...variables.map((variable, index) => {
			const preview = previewValue(variable, sampleValues);
			return {
				id: `variable:${index}:${variable.key}`,
				kind: 'variable' as const,
				value: variableToken(variable.key),
				label: variable.label,
				key: variable.key,
				preview,
				disabled: false as const,
			};
		}),
	];
}

export function variableChoiceLabel(
	choice: Extract<VariableSelectChoice, { readonly kind: 'variable' }>,
): string {
	const token = variableToken(choice.key);
	return choice.preview.length > 0
		? `${choice.label} (${token} · ${choice.preview})`
		: `${choice.label} (${token})`;
}
