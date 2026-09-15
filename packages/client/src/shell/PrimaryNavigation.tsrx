import { Icon } from '@flowdular/ui';
import type {
	NavigationContribution,
	NavigationGroup,
} from '../contributions.ts';
import type { ShellView } from '../state.ts';
import { t } from '../i18n/runtime.ts';
import {
	navigationGroupLabel,
	navigationSectionLabel,
	navigationSections,
	viewHref,
} from './navigation.ts';
import type { NavigateToView } from './types.ts';

export interface PrimaryNavigationProps {
	items: readonly NavigationContribution[];
	group: NavigationGroup | null;
	activeView: ShellView;
	workspaceSlug: string | null;
	onNavigate: NavigateToView;
}

/* The panel beside the rail: the items of one group, an Administration group
   as labelled sections, every other group as one list. */
export function PrimaryNavigation(props: PrimaryNavigationProps) @{
	const items = props.items.filter((item) => item.group === props.group);
	<nav class="primary-nav" aria-label={t('shell.nav.label')}>
		@if (props.group !== null) {
			<>
				<div class="nav-panel__title">{navigationGroupLabel(
					t,
					props.group,
				)}</div>
				<div class="nav-group__items">
					@for (const block of navigationSections(items); key block.section ??
						'rest') {
						<>
							@if (block.section !== null) {
								<span class="nav-section__label">{navigationSectionLabel(
									t,
									block.section,
								)}</span>
							}
							@for (const item of block.items; key item.id) {
								<a
									class={[
										'nav-item',
										props.activeView === item.viewId && 'nav-item--active',
									]}
									href={viewHref(item.viewId, props.workspaceSlug)}
									title={item.description}
									onClick={(event) => {
										event.preventDefault();
										props.onNavigate(item.viewId);
									}}
								>
									<Icon name={item.glyph} size={18} />
									<span class="nav-item__label">{item.label}</span>
								</a>
							}
						</>
					}
				</div>
			</>
		}
	</nav>
}
