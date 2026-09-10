import { useEffect, useMemo, useRef, useState } from 'octane';
import {
	tokenizeTemplate,
	type VariableDefinition,
} from '@flowdular/contracts';
import { Icon } from '../icons/Icon.tsrx';
import {
	activeQuery,
	filterVariables,
	insertToken,
	previewValue,
} from './variable-field.ts';

export interface VariableFieldProps {
	readonly value: string;
	readonly onInput: (value: string) => void;
	/** Already scope-filtered by the caller to what this principal may use. */
	readonly variables: readonly VariableDefinition[];
	readonly placeholder?: string;
	/** Accessible name; the visible label is the wrapping FormField. */
	readonly label: string;
	readonly sampleValues?: Record<string, string>;
	readonly name?: string;
	readonly required?: boolean;
	readonly disabled?: boolean;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly error?: boolean;
	/** Accessible label and tooltip for the variable picker trigger. */
	readonly insertLabel: string;
	/** Accessible label for the variable list. */
	readonly variablesLabel: string;
	/** Visible message when the filtered variable list is empty. */
	readonly emptyLabel: string;
}

interface VariableFieldCoreProps extends VariableFieldProps {
	readonly multiline: boolean;
	readonly rows?: number;
}

export function VariableField(props: VariableFieldCoreProps) @{
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const highlightRef = useRef<HTMLDivElement | null>(null);
	const pendingCaret = useRef<number | null>(null);

	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [typeStart, setTypeStart] = useState<number | null>(null);
	const [activeIndex, setActiveIndex] = useState(0);

	const control = (): HTMLTextAreaElement | HTMLInputElement | null =>
		textareaRef.current ?? inputRef.current;

	const knownKeys = useMemo(
		() => new Set(props.variables.map((variable) => variable.key)),
		[props.variables],
	);

	const parts = useMemo(
		() => tokenizeTemplate(props.value).map(
			(segment, index) => ({
				id: index,
				isVariable: segment.kind === 'variable',
				isError: segment.kind === 'variable' && !knownKeys.has(segment.key),
				text: segment.text,
			}),
		),
		[props.value, knownKeys],
	);
	const trailingBlankLine = props.multiline && props.value.endsWith('\n');

	const filtered = useMemo(() => filterVariables(props.variables, query), [
		props.variables,
		query,
	]);
	const options = useMemo(
		() => filtered.map(
			(variable, index) => ({
				variable,
				index,
				preview: previewValue(variable, props.sampleValues),
			}),
		),
		[filtered, props.sampleValues],
	);

	const close = () => {
		setOpen(false);
		setTypeStart(null);
		setActiveIndex(0);
	};

	const syncScroll = () => {
		const el = control();
		const highlight = highlightRef.current;
		if (el && highlight) {
			highlight.scrollTop = el.scrollTop;
			highlight.scrollLeft = el.scrollLeft;
		}
	};

	const pick = (variable: VariableDefinition) => {
		const el = control();
		const selectionStart = el?.selectionStart ?? props.value.length;
		const selectionEnd = el?.selectionEnd ?? selectionStart;
		const from = typeStart ?? selectionStart;
		const inserted = insertToken(props.value, from, selectionEnd, variable.key);
		pendingCaret.current = inserted.caret;
		close();
		props.onInput(inserted.value);
	};

	const handleInput = (event: InputEvent & {
		currentTarget: HTMLTextAreaElement | HTMLInputElement;
	}) => {
		const next = event.currentTarget.value;
		const caret = event.currentTarget.selectionStart ?? next.length;
		props.onInput(next);
		const active = activeQuery(next, caret);
		if (active) {
			setTypeStart(active.start);
			setQuery(active.query);
			setActiveIndex(0);
			setOpen(true);
		} else if (typeStart !== null) {
			close();
		}
	};

	const handleKeyDown = (event: KeyboardEvent) => {
		if (!open) return;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			setActiveIndex((index) => Math.min(options.length - 1, index + 1));
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			setActiveIndex((index) => Math.max(0, index - 1));
		} else if (event.key === 'Enter') {
			const choice = options[activeIndex];
			if (choice) {
				event.preventDefault();
				pick(choice.variable);
			}
		} else if (event.key === 'Escape') {
			event.preventDefault();
			close();
		}
	};

	const toggle = () => {
		if (open) {
			close();
			return;
		}
		setTypeStart(null);
		setQuery('');
		setActiveIndex(0);
		setOpen(true);
		control()?.focus();
	};

	useEffect(() => {
		const el = control();
		if (!el) return;
		if (pendingCaret.current !== null) {
			el.focus();
			el.setSelectionRange(pendingCaret.current, pendingCaret.current);
			pendingCaret.current = null;
		}
		syncScroll();
	}, [props.value]);

	<div
		class="ui-varfield"
		data-multiline={props.multiline ? 'true' : 'false'}
		data-error={props.error ? 'true' : 'false'}
	>
		<div class="ui-varfield__control">
			<div class="ui-varfield__highlight" aria-hidden="true" ref={highlightRef}>
				@for (const part of parts; key part.id) {
					@if (part.isVariable) {
						<mark
							class={[
								'ui-varfield__pill',
								part.isError && 'ui-varfield__pill--error',
							]}
						>{part.text}</mark>
					} @else {
						<span>{part.text}</span>
					}
				}
				@if (trailingBlankLine) {
					<span>{'\n'}</span>
				}
			</div>
			@if (props.multiline) {
				<textarea
					ref={textareaRef}
					class="ui-varfield__input"
					name={props.name}
					value={props.value}
					placeholder={props.placeholder}
					aria-label={props.label}
					rows={props.rows ?? 6}
					required={props.required}
					disabled={props.disabled}
					minlength={props.minLength}
					maxlength={props.maxLength}
					spellcheck={false}
					onInput={handleInput}
					onKeyDown={handleKeyDown}
					onScroll={syncScroll}
					onBlur={close}
				></textarea>
			} @else {
				<input
					ref={inputRef}
					class="ui-varfield__input"
					type="text"
					name={props.name}
					value={props.value}
					placeholder={props.placeholder}
					aria-label={props.label}
					required={props.required}
					disabled={props.disabled}
					minlength={props.minLength}
					maxlength={props.maxLength}
					spellcheck={false}
					onInput={handleInput}
					onKeyDown={handleKeyDown}
					onScroll={syncScroll}
					onBlur={close}
				/>
			}
			<button
				type="button"
				class="ui-varfield__trigger"
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={props.insertLabel}
				title={props.insertLabel}
				disabled={props.disabled}
				onMouseDown={(event: MouseEvent) => event.preventDefault()}
				onClick={toggle}
			>
				<Icon name="braces" size={16} />
			</button>
			@if (open) {
				<div class="ui-varfield__menu">
					<div class="ui-menu" role="listbox" aria-label={props.variablesLabel}>
						@if (options.length === 0) {
							<p class="ui-varfield__empty">{props.emptyLabel}</p>
						} @else {
							@for (const option of options; key option.variable.key) {
								<button
									type="button"
									class={[
										'ui-menu__item',
										option.index === activeIndex && 'ui-menu__item--active',
									]}
									role="option"
									aria-selected={option.index === activeIndex}
									onMouseDown={(event: MouseEvent) => event.preventDefault()}
									onMouseEnter={() => setActiveIndex(option.index)}
									onClick={() => pick(option.variable)}
								>
									<span class="ui-cell">
										<b>{option.variable.label}</b>
										<small class="ui-mono">{option.variable.key}</small>
									</span>
									@if (option.preview) {
										<small class="ui-varfield__value">{option.preview}</small>
									}
								</button>
							}
						}
					</div>
				</div>
			}
		</div>
	</div>
}
