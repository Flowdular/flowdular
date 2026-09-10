import { Icon } from '@flowdular/ui';
import type { NavigationContribution } from '../contributions.ts';
import { activeLocale, t } from '../i18n/runtime.ts';
import { navigationGroupLabel } from './navigation.ts';
import type { NavigateToView } from './types.ts';

export interface CommandPaletteProps {
	items: readonly NavigationContribution[];
	query: string;
	onQuery: (query: string) => void;
	onNavigate: NavigateToView;
	onClose: () => void;
}

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
	<div class="command-layer" role="presentation" onClick={props.onClose}>
		<section
			class="command-dialog"
			role="dialog"
			aria-modal="true"
			aria-label={t('shell.command.label')}
			onClick={(event) => event.stopPropagation()}
		>
			<label class="command-dialog__input">
				<Icon name="search" size={16} />
				<input
					autoFocus
					type="search"
					placeholder={t('shell.command.placeholder')}
					value={props.query}
					onInput={(event) => props.onQuery(event.currentTarget.value)}
				/>
				<span class="ui-kbd">ESC</span>
			</label>
			<div class="command-dialog__results">
				<div class="ui-menu__label">{t('shell.command.section')}</div>
				@if (matches.length === 0) {
					<p class="ui-table__empty">{t('shell.command.empty', {
						query: props.query,
					})}</p>
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
							<small>
								{navigationGroupLabel(t, item.group) + ' · ' + item.description}
							</small>
						</span>
						<span class="ui-kbd">↵</span>
					</button>
				}
			</div>
			<footer class="command-dialog__foot">
				<span>{t('shell.command.open')}</span>
				<span>{t('shell.command.close')}</span>
			</footer>
		</section>
	</div>
}
