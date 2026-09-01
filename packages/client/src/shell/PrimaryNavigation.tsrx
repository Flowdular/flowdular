import { Icon } from '@coreloom/ui';
import type {
	NavigationContribution,
	NavigationGroup,
} from '../contributions.ts';
import type { ShellView } from '../state.ts';
import { NAVIGATION_GROUPS, viewHref } from './navigation.ts';
import type { NavigateToView } from './types.ts';

export interface PrimaryNavigationProps {
	items: readonly NavigationContribution[];
	activeView: ShellView;
	workspaceSlug: string | null;
	collapsedGroups: readonly string[];
	onNavigate: NavigateToView;
	onToggleGroup: (group: NavigationGroup) => void;
}

export function PrimaryNavigation(props: PrimaryNavigationProps) @{
	<nav class="primary-nav" aria-label="Platform navigation">
		@for (const group of NAVIGATION_GROUPS; key group) {
			@if (props.items.some((item) => item.group === group)) {
				<section
					class={[
						'nav-group',
						props.collapsedGroups.includes(group) && 'nav-group--collapsed',
					]}
				>
					<button
						class="nav-group__toggle"
						type="button"
						aria-expanded={!props.collapsedGroups.includes(group)}
						onClick={() => props.onToggleGroup(group)}
					>
						<span>{group}</span>
						<span class="nav-group__chevron">
							<Icon name="chevron-down" size={12} strokeWidth={2} />
						</span>
					</button>
					<div
						class="nav-group__content"
						aria-hidden={props.collapsedGroups.includes(group)}
					>
						<div class="nav-group__items">
							@for (const item of props.items.filter(
								(item) => item.group === group,
							); key item.id) {
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
						</div>
					</div>
				</section>
			}
		}
	</nav>
}
