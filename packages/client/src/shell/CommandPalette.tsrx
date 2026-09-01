import { Icon } from '@coreloom/ui';
import type { NavigationContribution } from '../contributions.ts';
import type { NavigateToView } from './types.ts';

export interface CommandPaletteProps {
	items: readonly NavigationContribution[];
	query: string;
	onQuery: (query: string) => void;
	onNavigate: NavigateToView;
	onClose: () => void;
}

export function CommandPalette(props: CommandPaletteProps) @{
	const normalizedQuery = props.query.trim().toLocaleLowerCase('en-US');
	const matches = props.items.filter(
		(item) =>
			item.viewId !== 'overview' &&
				(normalizedQuery.length === 0 ||
					item.label.toLocaleLowerCase('en-US').includes(normalizedQuery) ||
					item.description.toLocaleLowerCase('en-US').includes(
						normalizedQuery,
					) ||
					item.group.toLocaleLowerCase('en-US').includes(normalizedQuery)),
	);
	<div class="command-layer" role="presentation" onClick={props.onClose}>
		<section
			class="command-dialog"
			role="dialog"
			aria-modal="true"
			aria-label="Command palette"
			onClick={(event) => event.stopPropagation()}
		>
			<label class="command-dialog__input">
				<Icon name="search" size={16} />
				<input
					autoFocus
					type="search"
					placeholder="Search views and records…"
					value={props.query}
					onInput={(event) => props.onQuery(event.currentTarget.value)}
				/>
				<span class="ui-kbd">ESC</span>
			</label>
			<div class="command-dialog__results">
				<div class="ui-menu__label">Navigate</div>
				@if (matches.length === 0) {
					<p class="ui-table__empty">
						{'No matches for "' + props.query + '".'}
					</p>
				}
				@for (const item of matches; key item.id) {
					<button
						class="command-item"
						type="button"
						onClick={() => props.onNavigate(item.viewId)}
					>
						<Icon name={item.glyph} size={16} />
						<span class="ui-cell">
							<b>{item.label}</b>
							<small>{item.group + ' · ' + item.description}</small>
						</span>
						<span class="ui-kbd">↵</span>
					</button>
				}
			</div>
			<footer class="command-dialog__foot">
				<span>↵ open</span>
				<span>ESC close</span>
			</footer>
		</section>
	</div>
}
