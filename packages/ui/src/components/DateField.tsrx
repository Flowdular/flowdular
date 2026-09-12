import { Icon } from '../icons/Icon.tsrx';
import {
	dateInputType,
	formatDateValue,
	type DateFieldKind,
} from './date-field.ts';

export interface DateFieldProps {
	/** Required: the label's target and a stable form control id. */
	readonly id: string;
	readonly label: string;
	/** ISO value: 'YYYY-MM-DD', or 'YYYY-MM-DDTHH:mm' when `kind` is 'datetime'. */
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly kind?: DateFieldKind | undefined;
	/** BCP 47 tag for the reading beside the field; screens pass `activeLocale()`. */
	readonly locale?: string | undefined;
	/** ISO bounds handed straight to the native input. */
	readonly min?: string | undefined;
	readonly max?: string | undefined;
	/** Submitted field name; defaults to `id`. */
	readonly name?: string | undefined;
	readonly required?: boolean | undefined;
	readonly disabled?: boolean | undefined;
	readonly invalid?: boolean | undefined;
	readonly help?: string | undefined;
	readonly error?: string | undefined;
	/** Id of a message owned by a group around the field, e.g. a `DateRangeField`. */
	readonly describedBy?: string | undefined;
}

/* A fieldset's own aria-describedby does not reach the controls inside it, so a
   group hands its message id to every field it holds. */
function describedBy(props: DateFieldProps): string | undefined {
	const own =
		props.error
			? props.id + '-error'
			: props.help
				? props.id + '-help'
				: '';
	return [own, props.describedBy ?? ''].filter(Boolean).join(' ') || undefined;
}

/**
 * The native date and datetime control. The input carries the ISO value the
 * platform stores and the form submits; the reader gets the same instant
 * beside it in their own locale, because a native date input shows whatever
 * format the browser chose.
 */
export function DateField(props: DateFieldProps) @{
	const invalid = props.invalid === true || (props.error ?? '') !== '';
	const reading = formatDateValue(props.value, props.kind, props.locale);
	<div class="ui-field">
		<label class="ui-label" for={props.id}>
			{props.label}
			@if (props.required) {
				<em aria-hidden="true">{' *'}</em>
			}
		</label>
		<div class="ui-datefield">
			<input
				class={['ui-input', invalid && 'ui-input--error']}
				type={dateInputType(props.kind)}
				id={props.id}
				name={props.name ?? props.id}
				value={props.value}
				min={props.min ?? undefined}
				max={props.max ?? undefined}
				required={props.required ?? false}
				disabled={props.disabled ?? false}
				aria-invalid={invalid}
				aria-describedby={describedBy(props)}
				onInput={(event) => props.onChange(event.currentTarget.value)}
			/>
			@if (reading) {
				<span class="ui-datefield__reading">
					<Icon name="calendar" size={14} />
					{reading}
				</span>
			}
		</div>
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
