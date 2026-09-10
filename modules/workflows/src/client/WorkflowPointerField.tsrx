import { t } from '@flowdular/client';
import { Icon } from '@flowdular/ui';
import { useEffect, useMemo, useRef, useState } from 'octane';
import {
	filterPointers,
	type PointerCatalog,
	type PointerSuggestion,
} from './pointer-model.ts';

/** Module-local pointer combobox, a candidate for promotion to the shared UI kit. */
export function WorkflowPointerField(props: {
	readonly name: string;
	readonly label: string;
	readonly value: string;
	readonly catalog: PointerCatalog;
	readonly onInput: (value: string) => void;
}) @{
	const input = useRef<HTMLInputElement | null>(null);
	const menu = useRef<HTMLDivElement | null>(null);
	const [open, setOpen] = useState(false);
	const [browse, setBrowse] = useState(false);
	const [active, setActive] = useState(0);
	const id = useMemo(() => 'workflow-pointer-' + props.name, [props.name]);
	const matches = filterPointers(
		props.catalog.entries,
		browse ? '' : props.value,
	);
	const options = matches.slice(0, 50).map(
		(entry, index) => ({ ...entry, index }),
	);
	const pick = (entry: PointerSuggestion) => {
		props.onInput(entry.pointer);
		setOpen(false);
		input.current?.focus();
	};
	useEffect(() => {
		const list = menu.current;
		const option = list?.querySelector('[aria-selected="true"]');
		if (!list || !option) return;
		const bounds = list.getBoundingClientRect();
		const selected = option.getBoundingClientRect();
		if (selected.top < bounds.top) list.scrollTop -= bounds.top - selected.top;
		else if (selected.bottom > bounds.bottom) list.scrollTop +=
			selected.bottom - bounds.bottom;
	}, [active]);
	const keyDown = (event: KeyboardEvent) => {
		if (event.key === 'Escape' && open) {
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
		} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			setOpen(true);
			setActive(
				open
					? Math.max(
							0,
							Math.min(
								options.length - 1,
								active + (event.key === 'ArrowDown' ? 1 : -1),
							),
						)
					: 0,
			);
		} else if (event.key === 'Enter' && open) {
			event.preventDefault();
			const entry = options[active];
			if (entry) pick(entry);
		}
	};

	<div class="workflow-pointer">
		<label class="ui-label" for={id}>{props.label}</label>
		<div class="workflow-pointer__control">
			<input
				ref={input}
				id={id}
				name={props.name}
				class="ui-input ui-mono"
				value={props.value}
				maxlength={1024}
				role="combobox"
				aria-autocomplete="list"
				aria-expanded={open}
				aria-controls={id + '-list'}
				aria-activedescendant={open && options[active]
					? id + '-option-' + active
					: undefined}
				aria-describedby={id + '-help'}
				autocomplete="off"
				spellcheck={false}
				onInput={(event) => {
					props.onInput(event.currentTarget.value);
					setBrowse(false);
					setActive(0);
					setOpen(true);
				}}
				onKeyDown={keyDown}
				onBlur={() => setOpen(false)}
			/>
			<button
				class="ui-btn ui-btn--sm"
				type="button"
				aria-label={t('workflows.pointer.browse')}
				title={t('workflows.pointer.browse')}
				aria-expanded={open}
				aria-controls={id + '-list'}
				onMouseDown={(event: MouseEvent) => event.preventDefault()}
				onClick={() => {
					setBrowse(true);
					setActive(0);
					setOpen(!open);
					input.current?.focus();
				}}
			>
				<Icon name="braces" size={16} />
			</button>
		</div>
		@if (open) {
			<div class="workflow-pointer__picker">
				<div
					class="workflow-pointer__list"
					ref={menu}
					id={id + '-list'}
					role="listbox"
					aria-label={t('workflows.pointer.browse')}
				>
					@for (const entry of options; key entry.pointer) {
						<button
							type="button"
							class="workflow-pointer__option"
							id={id + '-option-' + entry.index}
							role="option"
							aria-selected={entry.index === active}
							tabindex={-1}
							onMouseDown={(event: MouseEvent) => event.preventDefault()}
							onMouseEnter={() => setActive(entry.index)}
							onClick={() => pick(entry)}
						>
							<span class="workflow-pointer__title">
								<b>
									{entry.pointer === ''
										? t('workflows.mapping.whole')
										: entry.label || entry.pointer}
								</b>
								<small>{t('workflows.pointer.type.' + entry.type)}</small>
							</span>
							@if (entry.pointer) {
								<code class="ui-mono">{entry.pointer}</code>
							}
							@if (entry.description) {
								<small>{entry.description}</small>
							}
							@if (entry.arrayExample) {
								<small>{t('workflows.pointer.arrayExample')}</small>
							}
							@if (entry.required && entry.pointer) {
								<small>{t('workflows.input.required')}</small>
							}
						</button>
					}
				</div>
				@if (!options.length) {
					<p class="ui-help">{t('workflows.pointer.empty')}</p>
				}
				@if (props.catalog.incomplete) {
					<p class="ui-help">{t('workflows.pointer.incomplete')}</p>
				}
				@if (props.catalog.truncated || matches.length > 50) {
					<p class="ui-help">{t('workflows.pointer.limited')}</p>
				}
			</div>
		}
		<small class="ui-help" id={id + '-help'}>{t(
			'workflows.mapping.pointerHelp',
		)}</small>
	</div>
}
