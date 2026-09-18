import { useEffect, useRef, useState } from 'octane';
import { fileRefusal, type FileRefusalReason } from './file-upload.ts';

export interface FileUploadProps {
	/** Required: the label's target and a stable form control id. */
	readonly id: string;
	readonly label: string;
	/** What the port accepts: content types, `type/*` families or `.suffix` entries. */
	readonly accept?: readonly string[] | undefined;
	/** Largest file the port accepts; null or absent while the screen is still asking. */
	readonly maxBytes?: number | null | undefined;
	/** The chosen file. The screen owns it, so a reset is one state change. */
	readonly value: File | null;
	readonly onChange: (file: File | null) => void;
	/** The words for a file the control refuses. The screen owns every one. */
	readonly refusal: (reason: FileRefusalReason, file: File) => string;
	/** The reading for the chosen file, e.g. 'contract.pdf, 2.1 MB'. */
	readonly chosen: (file: File) => string;
	/** The button that opens the file picker, e.g. "Choose a file". */
	readonly chooseLabel: string;
	readonly clearLabel: string;
	/** What may be uploaded, shown while nothing is chosen. */
	readonly hint?: string | undefined;
	/** The upload is running: the control is inert and reads `busyLabel`. */
	readonly busy?: boolean | undefined;
	readonly busyLabel?: string | undefined;
	/** A failure the screen owns; it replaces the control's own refusal. */
	readonly error?: string | undefined;
	/** Submitted field name; defaults to `id`. */
	readonly name?: string | undefined;
	readonly required?: boolean | undefined;
	readonly disabled?: boolean | undefined;
	readonly autoFocus?: boolean | undefined;
}

/**
 * The file control every upload screen uses. It owns the two refusals the
 * browser cannot state (an unaccepted content type, a file past the port's
 * ceiling) and nothing else: the screen owns the words, the chosen file and
 * the request.
 *
 * The five states: loading while `busy`, empty with no `value` (the `hint`
 * states what is accepted), in error through `error` or a refusal, populated
 * with a `value` the `chosen` reading names, and denied by not being rendered,
 * the same way `Select` and `DateField` are.
 */
export function FileUpload(props: FileUploadProps) @{
	const inputRef = useRef<HTMLInputElement | null>(null);
	const [refused, setRefused] = useState('');
	const accept = props.accept ?? [];
	/* The list identity changes with every limits response, so the effect below
   watches what the list says rather than which array said it. */
	const acceptKey = accept.join(',');
	const maxBytes = props.maxBytes ?? null;

	const clearInput = () => {
		const input = inputRef.current;
		if (input) input.value = '';
	};

	/* The limits arrive after the drawer opens, so a file chosen against no
   ceiling has to be re-read against the one that lands. Clearing here is the
   only place it happens: the screen never holds a file the control refused. */
	useEffect(() => {
		const file = props.value;
		if (file === null) {
			clearInput();
			return;
		}
		const reason = fileRefusal(file, accept, maxBytes);
		if (reason === null) return;
		setRefused(props.refusal(reason, file));
		clearInput();
		props.onChange(null);
	}, [props.value, maxBytes, acceptKey]);

	const choose = (event: Event) => {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0] ?? null;
		if (file === null) {
			setRefused('');
			props.onChange(null);
			return;
		}
		const reason = fileRefusal(file, accept, maxBytes);
		if (reason !== null) {
			setRefused(props.refusal(reason, file));
			input.value = '';
			props.onChange(null);
			return;
		}
		setRefused('');
		props.onChange(file);
	};

	const clear = () => {
		setRefused('');
		clearInput();
		props.onChange(null);
	};

	const message = props.error || refused;
	const reading =
		props.busy
			? props.busyLabel ?? ''
			: props.value
				? props.chosen(props.value)
				: props.hint ?? '';
	const invalid = message !== '';

	<div class="ui-field ui-fileupload">
		<label class="ui-label" for={props.id}>
			{props.label}
			@if (props.required) {
				<em aria-hidden="true">{' *'}</em>
			}
		</label>
		{/* The native control is kept for the keyboard, the form and the picker,
   and hidden from sight: the browser draws its own button and its own words
   for it, in the browser's language, which reads as a foreign control on a
   translated screen and is cut when the field is narrow. The label beside it
   is what a reader sees and clicks. */}
		<div class="ui-fileupload__control">
			<input
				class={[
					'ui-fileupload__input',
					invalid && 'ui-fileupload__input--error',
				]}
				type="file"
				id={props.id}
				name={props.name ?? props.id}
				accept={accept.length > 0 ? acceptKey : undefined}
				required={props.required ?? false}
				disabled={props.disabled === true || props.busy === true}
				autoFocus={props.autoFocus ?? false}
				aria-invalid={invalid}
				aria-describedby={invalid
					? props.id + '-error'
					: reading
						? props.id + '-help'
						: undefined}
				ref={inputRef}
				onChange={choose}
			/>
			<label
				class={[
					'ui-fileupload__choose',
					'ui-btn',
					'ui-btn--secondary',
					(props.disabled === true || props.busy === true) &&
						'ui-fileupload__choose--disabled',
				]}
				for={props.id}
			>{props.chooseLabel}</label>
			@if (props.value && props.busy !== true) {
				<span class="ui-fileupload__name">{props.value.name}</span>
			}
			@if (props.value && props.busy !== true) {
				<button
					class="ui-fileupload__clear"
					type="button"
					disabled={props.disabled ?? false}
					onClick={clear}
				>{props.clearLabel}</button>
			}
		</div>
		@if (invalid) {
			<span
				class="ui-help ui-help--error"
				id={props.id + '-error'}
				role="alert"
			>{message}</span>
		} @else if (reading) {
			<span class="ui-help" id={props.id + '-help'}>{reading}</span>
		}
	</div>
}
