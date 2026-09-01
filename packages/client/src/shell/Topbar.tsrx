import { Icon } from '@coreloom/ui';
import type {
	AccountMenuContribution,
	WidgetContribution,
} from '../contributions.ts';
import { SlotOutlet } from './ContributionOutlets.tsrx';
import type { NavigateToView, ShellIdentity } from './types.ts';
import { UserMenu } from './UserMenu.tsrx';

export interface TopbarProps {
	activeGroup: string;
	activeLabel: string;
	identity: ShellIdentity;
	accountMenu: readonly AccountMenuContribution[];
	activeView: string;
	widgets: readonly WidgetContribution[];
	onOpenCommand: () => void;
	onNavigate: NavigateToView;
	onSignOut: () => void;
}

export function Topbar(props: TopbarProps) @{
	<header class="topbar">
		<div class="topbar__crumb">
			<span>{props.activeGroup}</span>
			<i aria-hidden="true">/</i>
			<b>{props.activeLabel}</b>
		</div>
		<button class="topbar__search" type="button" onClick={props.onOpenCommand}>
			<Icon name="search" size={16} />
			<span>Search workspace</span>
			<span class="ui-kbd">⌘K</span>
		</button>
		<SlotOutlet className="module-slot--topbar" widgets={props.widgets} />
		<UserMenu
			identity={props.identity}
			items={props.accountMenu}
			activeView={props.activeView}
			onNavigate={props.onNavigate}
			onSignOut={props.onSignOut}
		/>
	</header>
}
