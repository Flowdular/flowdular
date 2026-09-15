import { Icon } from '@flowdular/ui';
import type { NavigationGroup } from '../contributions.ts';
import { t } from '../i18n/runtime.ts';
import {
	navigationGroupLabel,
	navigationRailLabel,
	NAVIGATION_GROUP_ICONS,
} from './navigation.ts';

export interface NavigationRailProps {
	groups: readonly NavigationGroup[];
	selected: NavigationGroup | null;
	active: NavigationGroup | null;
	onSelect: (group: NavigationGroup) => void;
}

/* The first rail: one button per group. The selected one owns the panel, the
   active one holds the open view; they differ while a person browses. */
export function NavigationRail(props: NavigationRailProps) @{
	<nav class="nav-rail" aria-label={t('shell.nav.groups')}>
		@for (const group of props.groups; key group) {
			<button
				class={[
					'nav-rail__group',
					props.selected === group && 'nav-rail__group--selected',
					props.active === group && 'nav-rail__group--active',
				]}
				type="button"
				aria-pressed={props.selected === group}
				title={navigationGroupLabel(t, group)}
				onClick={() => props.onSelect(group)}
			>
				<Icon name={NAVIGATION_GROUP_ICONS[group]} size={20} />
				<span class="nav-rail__label">{navigationRailLabel(t, group)}</span>
			</button>
		}
	</nav>
}
