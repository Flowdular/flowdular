import { useEffect, useRef, useState } from 'octane';
import { Icon } from '@flowdular/ui';
import type {
	CommandSearchContribution,
	CommandSearchHit,
	NavigationContribution,
} from '../contributions.ts';
import { activeLocale, t } from '../i18n/runtime.ts';
import {
	commandSearchOutcome,
	commandSearchReady,
	groupCommandSearchHits,
	runCommandSearch,
	COMMAND_SEARCH_DEBOUNCE_MS,
} from './command-search.ts';
import { navigationGroupLabel } from './navigation.ts';
import {
	nextPaletteIndex,
	paletteOptionId,
	trappedFocusIndex,
} from './palette-keys.ts';
import type { NavigateToView } from './types.ts';

export interface CommandPaletteProps {
	items: readonly NavigationContribution[];
	/** Contributions the member's scopes allow; empty means no record section. */
	searches: readonly CommandSearchContribution[];
	query: string;
	onQuery: (query: string) => void;
	onNavigate: NavigateToView;
	onOpenHit: (hit: CommandSearchHit) => void;
	onClose: () => void;
}

type RecordStatus = 'idle' | 'loading' | 'ready' | 'partial' | 'error';

type PaletteOption =
	| { readonly kind: 'view'; readonly item: NavigationContribution }
	| { readonly kind: 'hit'; readonly hit: CommandSearchHit };

/** Keys the list handles itself; anything else keeps typing in the input. */
const SELECTION_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End'];

const OPTIONS_ID = 'command-options';

export function CommandPalette(props: CommandPaletteProps) @{
	const locale = activeLocale();
	const normalizedQuery = props.query.trim().toLocaleLowerCase(locale);
	const matches = props.items.filter(
		(item) =>
			item.viewId !== 'overview' &&
				(normalizedQuery.length === 0 ||
					item.label.toLocaleLowerCase(locale).includes(normalizedQuery) ||
					item.description.toLocaleLowerCase(locale).includes(
						normalizedQuery,
					) ||
					navigationGroupLabel(t, item.group).toLocaleLowerCase(
						locale,
					).includes(normalizedQuery)),
	);
	const [hits, setHits] = useState<readonly CommandSearchHit[]>([]);
	const [recordStatus, setRecordStatus] = useState<RecordStatus>('idle');
	const [active, setActive] = useState(0);
	const dialog = useRef<HTMLElement | null>(null);
	const results = useRef<HTMLDivElement | null>(null);
	const groups = groupCommandSearchHits(hits);
	/* Navigation entries first, then the record hits in the order they are
   listed: one sequence, so an index is all the selection has to carry. */
	const options: PaletteOption[] = [];
	for (const item of matches) options.push({ kind: 'view', item });
	const hitGroups = groups.map(
		(group) => ({
			provider: group.provider,
			label: group.label,
			hits: group.hits.map((hit) => {
				options.push({ kind: 'hit', hit });
				return { hit, index: options.length - 1 };
			}),
		}),
	);
	const activeIndex =
		options.length === 0
			? 0
			: Math.min(Math.max(active, 0), options.length - 1);

	const activate = (option: PaletteOption | undefined) => {
		if (!option) return;
		if (option.kind === 'view') props.onNavigate(option.item.viewId);
		else props.onOpenHit(option.hit);
	};

	/* The palette is modal: Tab cycles inside it instead of walking the
   workspace behind the overlay. The options are reached with the arrow
   keys and carry tabindex -1, so the only stop left is the input. */
	const trapFocus = (event: KeyboardEvent) => {
		const element = dialog.current;
		if (!element) return;
		const focusable = [
			...element.querySelectorAll<HTMLElement>(
				'input, button:not([tabindex="-1"])',
			),
		];
		if (focusable.length === 0) return;
		event.preventDefault();
		const current = focusable.indexOf(document.activeElement as HTMLElement);
		focusable[trappedFocusIndex(
			current,
			focusable.length,
			event.shiftKey,
		)]?.focus();
	};

	const keyDown = (event: KeyboardEvent) => {
		if (event.key === 'Tab') {
			trapFocus(event);
			return;
		}
		if (SELECTION_KEYS.includes(event.key)) {
			event.preventDefault();
			setActive(nextPaletteIndex(activeIndex, options.length, event.key));
			return;
		}
		if (event.key === 'Enter' && options[activeIndex]) {
			event.preventDefault();
			activate(options[activeIndex]);
		}
	};

	/* Record hits are debounced and abortable, and they are resolved outside the
   navigation list above: whatever a contribution does, typing and choosing a
   navigation entry keep working at full speed. */
	useEffect(() => {
		const query = props.query.trim();
		if (props.searches.length === 0 || !commandSearchReady(query)) {
			setHits([]);
			setRecordStatus('idle');
			return;
		}
		const controller = new AbortController();
		setRecordStatus('loading');
		const timer = setTimeout(() => {
			void runCommandSearch(props.searches, query, controller.signal).then(
				(answer) => {
					if (controller.signal.aborted) return;
					setHits(answer.hits);
					setRecordStatus(
						commandSearchOutcome(props.searches.length, answer.failed.length),
					);
				},
				() => {
					if (controller.signal.aborted) return;
					setHits([]);
					setRecordStatus('error');
				},
			);
		}, COMMAND_SEARCH_DEBOUNCE_MS);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [props.query, props.searches]);

	/* A new query is a new list, so the selection starts at the top of it. */
	useEffect(() => setActive(0), [props.query, hits]);

	useEffect(() => {
		const list = results.current;
		const option = list?.querySelector('[aria-selected="true"]');
		if (!list || !option) return;
		const bounds = list.getBoundingClientRect();
		const selected = option.getBoundingClientRect();
		if (selected.top < bounds.top) list.scrollTop -= bounds.top - selected.top;
		else if (selected.bottom > bounds.bottom) list.scrollTop +=
			selected.bottom - bounds.bottom;
	}, [activeIndex]);

	/* Closing puts the member back where they opened it from, which is the
   topbar button or whatever had focus when the shortcut was pressed. */
	useEffect(() => {
		const opener = document.activeElement;
		return () => {
			if (opener instanceof HTMLElement && document.contains(opener)) {
				opener.focus();
			}
		};
	}, []);

	<div class="command-layer" role="presentation" onClick={props.onClose}>
		<section
			class="command-dialog"
			role="dialog"
			aria-modal="true"
			aria-label={t('shell.command.label')}
			ref={dialog}
			onClick={(event) => event.stopPropagation()}
			onKeyDown={keyDown}
		>
			<label class="command-dialog__input">
				<Icon name="search" size={16} />
				<input
					autoFocus
					type="search"
					role="combobox"
					aria-expanded={options.length > 0}
					aria-controls={OPTIONS_ID}
					aria-autocomplete="list"
					autocomplete="off"
					aria-activedescendant={options.length > 0
						? paletteOptionId(activeIndex)
						: undefined}
					placeholder={t('shell.command.placeholder')}
					value={props.query}
					onInput={(event) => props.onQuery(event.currentTarget.value)}
				/>
				<span class="ui-kbd">ESC</span>
			</label>
			<div
				class="command-dialog__results"
				id={OPTIONS_ID}
				role="listbox"
				aria-label={t('shell.command.label')}
				ref={results}
			>
				<div class="ui-menu__label">{t('shell.command.section')}</div>
				@if (matches.length === 0) {
					<p class="ui-table__empty" role="status">{t('shell.command.empty', {
						query: props.query,
					})}</p>
				}
				@for (const [index, item] of matches.entries(); key item.id) {
					<button
						class={[
							'command-item',
							index === activeIndex && 'command-item--active',
						]}
						type="button"
						role="option"
						id={paletteOptionId(index)}
						aria-selected={index === activeIndex}
						tabIndex={-1}
						onClick={() => props.onNavigate(item.viewId)}
					>
						<Icon name={item.glyph} size={16} />
						<span class="ui-cell">
							<b>{item.label}</b>
							<small>
								{navigationGroupLabel(t, item.group) + ' · ' + item.description}
							</small>
						</span>
						<span class="ui-kbd">↵</span>
					</button>
				}
				@if (recordStatus === 'loading') {
					<>
						<div class="ui-menu__label">{t('shell.command.records')}</div>
						<p class="ui-table__empty" role="status">{t(
							'shell.command.searching',
						)}</p>
					</>
				}
				@if (recordStatus === 'error') {
					<>
						<div class="ui-menu__label">{t('shell.command.records')}</div>
						<p class="ui-table__empty" role="status">{t(
							'shell.command.recordsError',
						)}</p>
					</>
				}
				@if (recordStatus === 'partial') {
					<>
						<div class="ui-menu__label">{t('shell.command.records')}</div>
						<p class="ui-table__empty" role="status">{t(
							'shell.command.recordsPartial',
						)}</p>
					</>
				}
				@if (recordStatus === 'ready' && groups.length === 0) {
					<>
						<div class="ui-menu__label">{t('shell.command.records')}</div>
						<p class="ui-table__empty" role="status">{t(
							'shell.command.recordsEmpty',
							{ query: props.query },
						)}</p>
					</>
				}
				@for (const group of hitGroups; key group.provider) {
					<>
						<div class="ui-menu__label">{group.label}</div>
						@for (const entry of group.hits; key entry.hit.id) {
							<button
								class={[
									'command-item',
									entry.index === activeIndex && 'command-item--active',
								]}
								type="button"
								role="option"
								id={paletteOptionId(entry.index)}
								aria-selected={entry.index === activeIndex}
								tabIndex={-1}
								onClick={() => props.onOpenHit(entry.hit)}
							>
								<Icon name="file-text" size={16} />
								<span class="ui-cell">
									<b>{entry.hit.title}</b>
									<small>{entry.hit.snippet}</small>
								</span>
								<span class="ui-kbd">↵</span>
							</button>
						}
					</>
				}
			</div>
			<footer class="command-dialog__foot">
				<span>{t('shell.command.open')}</span>
				<span>{t('shell.command.close')}</span>
			</footer>
		</section>
	</div>
}
