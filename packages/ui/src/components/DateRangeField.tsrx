import { DateField } from './DateField.tsrx';
import { dateRangeReversed, type DateFieldKind } from './date-field.ts';

export interface DateRange {
	readonly from: string;
	readonly to: string;
}

export interface DateRangeFieldProps {
	/** Required: the two fields render as `<id>-from` and `<id>-to`. */
	readonly id: string;
	/** The group label, rendered as the fieldset legend. */
	readonly legend: string;
	readonly fromLabel: string;
	readonly toLabel: string;
	readonly value: DateRange;
	readonly onChange: (value: DateRange) => void;
	readonly kind?: DateFieldKind | undefined;
	readonly locale?: string | undefined;
	/** ISO bounds for the whole range. */
	readonly min?: string | undefined;
	readonly max?: string | undefined;
	readonly required?: boolean | undefined;
	readonly disabled?: boolean | undefined;
	/** Shown when the end precedes the start. */
	readonly reversedMessage: string;
	readonly help?: string | undefined;
	/** A failure the screen owns; it replaces `reversedMessage`. */
	readonly error?: string | undefined;
}

/**
 * Two `DateField`s that answer one question. The end can never be set before
 * the start in the picker, because each side bounds the other; a range that
 * arrives reversed from the screen's own state is reported instead of being
 * silently swapped.
 */
export function DateRangeField(props: DateRangeFieldProps) @{
	const reversed = dateRangeReversed(props.value.from, props.value.to);
	const message = props.error || (reversed ? props.reversedMessage : '');
	const messageId = props.id + '-error';
	const helpId = props.id + '-help';
	/* The group owns one answer, so both sides describe themselves with the
   group's line; a fieldset's own description never reaches its controls. */
	const describedBy =
		message
			? messageId
			: props.help
				? helpId
				: undefined;
	<fieldset class="ui-daterange" aria-describedby={describedBy}>
		<legend class="ui-label">{props.legend}</legend>
		<div class="ui-daterange__row">
			<DateField
				id={props.id + '-from'}
				label={props.fromLabel}
				value={props.value.from}
				kind={props.kind}
				locale={props.locale}
				min={props.min}
				max={props.value.to || props.max}
				required={props.required}
				disabled={props.disabled}
				invalid={reversed}
				describedBy={describedBy}
				onChange={(from) => props.onChange({ from, to: props.value.to })}
			/>
			<DateField
				id={props.id + '-to'}
				label={props.toLabel}
				value={props.value.to}
				kind={props.kind}
				locale={props.locale}
				min={props.value.from || props.min}
				max={props.max}
				required={props.required}
				disabled={props.disabled}
				invalid={reversed}
				describedBy={describedBy}
				onChange={(to) => props.onChange({ from: props.value.from, to })}
			/>
		</div>
		@if (message) {
			<span
				class="ui-help ui-help--error"
				id={messageId}
				role="alert"
			>{message}</span>
		} @else if (props.help) {
			<span class="ui-help" id={helpId}>{props.help}</span>
		}
	</fieldset>
}
