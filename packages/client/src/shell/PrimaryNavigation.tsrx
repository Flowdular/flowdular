import { Icon } from '@flowdular/ui';
import type {
	NavigationContribution,
	NavigationGroup,
	NavigationSection,
} from '../contributions.ts';
import type { ShellView } from '../state.ts';
import { t } from '../i18n/runtime.ts';
import {
	navigationGroupLabel,
	navigationSectionLabel,
	navigationSections,
	NAVIGATION_GROUPS,
	NAVIGATION_SECTION_ICONS,
	viewHref,
} from './navigation.ts';
import type { NavigateToView } from './types.ts';

export interface PrimaryNavigationProps {
	items: readonly NavigationContribution[];
	activeView: ShellView;
	workspaceSlug: string | null;
	collapsedGroups: readonly string[];
	/** The section of the active view; its entry is highlighted and its items nest on a phone. */
	activeSection: NavigationSection | null;
	onNavigate: NavigateToView;
	onToggleGroup: (group: NavigationGroup) => void;
}

export function PrimaryNavigation(props: PrimaryNavigationProps) @{
	<nav class="primary-nav" aria-label={t('shell.nav.label')}>
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
						<span>{navigationGroupLabel(t, group)}</span>
						<span class="nav-group__chevron">
							<Icon name="chevron-down" size={12} strokeWidth={2} />
						</span>
					</button>
					<div
						class="nav-group__content"
						aria-hidden={props.collapsedGroups.includes(group)}
					>
						<div class="nav-group__items">
							@for (const block of navigationSections(
								props.items.filter((item) => item.group === group),
							); key block.section ?? 'rest') {
								@if (block.section !== null) {
									<>
										<a
											class={[
												'nav-item',
												props.activeSection === block.section &&
													'nav-item--active',
											]}
											href={viewHref(
												block.items[0]!.viewId,
												props.workspaceSlug,
											)}
											onClick={(event) => {
												event.preventDefault();
												props.onNavigate(block.items[0]!.viewId);
											}}
										>
											<Icon
												name={NAVIGATION_SECTION_ICONS[block.section]}
												size={18}
											/>
											<span class="nav-item__label">{navigationSectionLabel(
												t,
												block.section,
											)}</span>
										</a>
										@if (props.activeSection === block.section) {
											<div class="nav-nested">
												@for (const item of block.items; key item.id) {
													<a
														class={[
															'nav-item nav-item--nested',
															props.activeView === item.viewId &&
																'nav-item--active',
														]}
														href={viewHref(item.viewId, props.workspaceSlug)}
														title={item.description}
														onClick={(event) => {
															event.preventDefault();
															props.onNavigate(item.viewId);
														}}
													>
														<span class="nav-item__label">{item.label}</span>
													</a>
												}
											</div>
										}
									</>
								} @else {
									<>
										@for (const item of block.items; key item.id) {
											<a
												class={[
													'nav-item',
													props.activeView === item.viewId &&
														'nav-item--active',
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
							}
						</div>
					</div>
				</section>
			}
		}
	</nav>
}
