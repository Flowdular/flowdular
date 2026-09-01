import { Icon } from '@coreloom/ui';
import type {
	NavigationContribution,
	NavigationGroup,
} from '../contributions.ts';
import type { ShellView } from '../state.ts';
import { SidebarBrand } from './BrandMark.tsrx';
import { OrganizationSwitcher } from './OrganizationSwitcher.tsrx';
import { PrimaryNavigation } from './PrimaryNavigation.tsrx';
import type { NavigateToView, ShellIdentity } from './types.ts';

export interface SidebarProps {
	open: boolean;
	collapsed: boolean;
	identity: ShellIdentity;
	items: readonly NavigationContribution[];
	activeView: ShellView;
	workspaceSlug: string | null;
	collapsedGroups: readonly string[];
	tenantBusy: boolean;
	tenantError: string;
	onClose: () => void;
	onToggleCollapsed: () => void;
	onNavigate: NavigateToView;
	onToggleGroup: (group: NavigationGroup) => void;
	onSelectTenant: (tenantId: string) => void;
}

export function Sidebar(props: SidebarProps) @{
	<aside class={['sidebar', props.open && 'sidebar--open']}>
		<div class="sidebar__brand">
			<SidebarBrand />
			<button
				class="sidebar__collapse ui-btn ui-btn--ghost ui-btn--icon"
				type="button"
				aria-label={props.collapsed
					? 'Expand navigation'
					: 'Collapse navigation'}
				title={props.collapsed ? 'Expand navigation' : 'Collapse navigation'}
				onClick={props.onToggleCollapsed}
			>
				<Icon name="panel-left" size={16} />
			</button>
			<button
				class="sidebar__close"
				type="button"
				aria-label="Close navigation"
				onClick={props.onClose}
			>
				<Icon name="x" size={16} />
			</button>
		</div>
		<OrganizationSwitcher
			identity={props.identity}
			busy={props.tenantBusy}
			error={props.tenantError}
			onSelect={props.onSelectTenant}
		/>
		<PrimaryNavigation
			items={props.items}
			activeView={props.activeView}
			workspaceSlug={props.workspaceSlug}
			collapsedGroups={props.collapsedGroups}
			onNavigate={props.onNavigate}
			onToggleGroup={props.onToggleGroup}
		/>
		<div class="sidebar__foot">
			<span>
				<i class="ui-dot" aria-hidden="true"></i>
				<span class="sidebar__foot-label">Platform online</span>
			</span>
			<span class="ui-mono">0.1.0</span>
		</div>
	</aside>
}
