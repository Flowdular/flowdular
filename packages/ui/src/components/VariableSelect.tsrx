import type { VariableDefinition } from '@coreloom/contracts';
import {
	variableChoiceLabel,
	variableSelectChoices,
	type VariableSelectLiteralOption,
} from './variable-select.ts';

export interface VariableSelectProps {
	readonly value: string;
	readonly onInput: (value: string) => void;
	readonly options: readonly VariableSelectLiteralOption[];
	/** Already scope-filtered by the caller to what this principal may use. */
	readonly variables: readonly VariableDefinition[];
	readonly sampleValues?: Record<string, string>;
	readonly placeholder?: string;
	/** Accessible name; the visible label is the wrapping FormField. */
	readonly label: string;
	readonly name?: string;
	readonly required?: boolean;
	readonly disabled?: boolean;
	readonly error?: boolean;
	readonly literalGroupLabel: string;
	readonly variablesGroupLabel: string;
}

export function VariableSelect(props: VariableSelectProps) @{
	const choices = variableSelectChoices(
		props.options,
		props.variables,
		props.sampleValues,
	);
	const literals = choices.filter((choice) => choice.kind === 'literal');
	const variables = choices.filter((choice) => choice.kind === 'variable');

	const handleInput = (event: InputEvent & {
		currentTarget: HTMLSelectElement;
	}) => props.onInput(event.currentTarget.value);

	<select
		class={['ui-select', props.error && 'ui-select--error']}
		name={props.name}
		value={props.value}
		aria-label={props.label}
		aria-invalid={props.error ? 'true' : undefined}
		required={props.required}
		disabled={props.disabled}
		onInput={handleInput}
	>
		@if (props.placeholder) {
			<option value="" disabled={props.required}>{props.placeholder}</option>
		}
		@if (literals.length > 0) {
			<optgroup label={props.literalGroupLabel}>
				@for (const choice of literals; key choice.id) {
					<option
						value={choice.value}
						disabled={choice.disabled}
					>{choice.label}</option>
				}
			</optgroup>
		}
		@if (variables.length > 0) {
			<optgroup label={props.variablesGroupLabel}>
				@for (const choice of variables; key choice.id) {
					<option value={choice.value}>{variableChoiceLabel(choice)}</option>
				}
			</optgroup>
		}
	</select>
}

export type { VariableSelectLiteralOption } from './variable-select.ts';
