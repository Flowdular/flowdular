export interface SelectOption {
	readonly value: string;
	readonly label: string;
	readonly disabled?: boolean | undefined;
}

export interface SelectProps {
	/** Required: the label's target and the id that keeps the control's identity across renders. */
	readonly id: string;
	readonly label: string;
	readonly options: readonly SelectOption[];
	readonly value: string;
	readonly onChange: (value: string) => void;
	/** The empty first option, shown while `value` is ''. */
	readonly placeholder?: string | undefined;
	/** Submitted field name; defaults to `id`. */
	readonly name?: string | undefined;
	readonly required?: boolean | undefined;
	readonly disabled?: boolean | undefined;
	/** Marks the control invalid without occupying the error line. */
	readonly invalid?: boolean | undefined;
	readonly help?: string | undefined;
	readonly error?: string | undefined;
}

/**
 * The labelled native select. Screens use it instead of writing a bare
 * `select.ui-select`, so the label association, the invalid state and the
 * help or error line are the same on every form.
 */
export function Select(props: SelectProps) @{
	const invalid = props.invalid === true || (props.error ?? '') !== '';
	<div class="ui-field">
		<label class="ui-label" for={props.id}>
			{props.label}
			@if (props.required) {
				<em aria-hidden="true">{' *'}</em>
			}
		</label>
		<select
			class={['ui-select', invalid && 'ui-select--error']}
			id={props.id}
			name={props.name ?? props.id}
			value={props.value}
			required={props.required ?? false}
			disabled={props.disabled ?? false}
			aria-invalid={invalid}
			aria-describedby={props.error
				? props.id + '-error'
				: props.help
					? props.id + '-help'
					: undefined}
			onInput={(event) => props.onChange(event.currentTarget.value)}
		>
			@if (props.placeholder) {
				<option value="">{props.placeholder}</option>
			}
			@for (const option of props.options; key option.value) {
				<option
					value={option.value}
					disabled={option.disabled ?? false}
				>{option.label}</option>
			}
		</select>
		@if (props.error) {
			<span
				class="ui-help ui-help--error"
				id={props.id + '-error'}
				role="alert"
			>{props.error}</span>
		} @else if (props.help) {
			<span class="ui-help" id={props.id + '-help'}>{props.help}</span>
		}
	</div>
}
