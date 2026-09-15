import { Icon } from '@flowdular/ui';
import type {
	NavigationContribution,
	NavigationGroup,
} from '../contributions.ts';
import type { ShellView } from '../state.ts';
import { t } from '../i18n/runtime.ts';
import { SidebarBrand } from './BrandMark.tsrx';
import { NavigationRail } from './NavigationRail.tsrx';
import { OrganizationSwitcher } from './OrganizationSwitcher.tsrx';
import { PrimaryNavigation } from './PrimaryNavigation.tsrx';
import type { NavigateToView, ShellIdentity } from './types.ts';

export interface SidebarProps {
	open: boolean;
	collapsed: boolean;
	identity: ShellIdentity;
	items: readonly NavigationContribution[];
	groups: readonly NavigationGroup[];
	selectedGroup: NavigationGroup | null;
	activeGroup: NavigationGroup | null;
	activeView: ShellView;
	workspaceSlug: string | null;
	tenantBusy: boolean;
	tenantError: string;
	onClose: () => void;
	onToggleCollapsed: () => void;
	onNavigate: NavigateToView;
	onSelectGroup: (group: NavigationGroup) => void;
	onSelectTenant: (tenantId: string) => void;
}

/* Two rails: the groups, then the items of the selected group. Collapsed
   hides the second rail and leaves the groups; a rail click brings it back. */
export function Sidebar(props: SidebarProps) @{
	<aside class={['sidebar', props.open && 'sidebar--open']}>
		<div class="nav-rail__column">
			<div class="sidebar__brand">
				<SidebarBrand />
			</div>
			<NavigationRail
				groups={props.groups}
				selected={props.selectedGroup}
				active={props.activeGroup}
				onSelect={props.onSelectGroup}
			/>
			<button
				class="sidebar__collapse ui-btn ui-btn--ghost ui-btn--icon"
				type="button"
				aria-label={t(
					props.collapsed ? 'shell.nav.expand' : 'shell.nav.collapse',
				)}
				title={t(props.collapsed ? 'shell.nav.expand' : 'shell.nav.collapse')}
				onClick={props.onToggleCollapsed}
			>
				<Icon name="panel-left" size={16} />
			</button>
		</div>
		<div class="nav-panel" aria-hidden={props.collapsed}>
			<div class="nav-panel__head">
				<OrganizationSwitcher
					identity={props.identity}
					busy={props.tenantBusy}
					error={props.tenantError}
					onSelect={props.onSelectTenant}
				/>
				<button
					class="sidebar__close"
					type="button"
					aria-label={t('shell.nav.close')}
					onClick={props.onClose}
				>
					<Icon name="x" size={16} />
				</button>
			</div>
			<PrimaryNavigation
				items={props.items}
				group={props.selectedGroup}
				activeView={props.activeView}
				workspaceSlug={props.workspaceSlug}
				onNavigate={props.onNavigate}
			/>
			<div class="sidebar__foot">
				<span>
					<i class="ui-dot" aria-hidden="true"></i>
					<span class="sidebar__foot-label">{t('shell.sidebar.status')}</span>
				</span>
				<span class="ui-mono">0.1.0</span>
			</div>
		</div>
	</aside>
}
