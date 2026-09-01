import { Avatar, Icon, Tag } from '@coreloom/ui';
import type { SandboxState } from './api.ts';

export interface WorkspaceMenuProps {
	readonly state: SandboxState;
	readonly open: boolean;
	readonly onToggle: () => void;
	readonly onChangeConnection: () => void;
	readonly onDisconnect: () => void;
}

/* The workspace this sandbox works against. A token is bound to one membership,
   so this is not a tenant switcher: changing workspace means changing the
   connection, and the menu says so. */
export function WorkspaceMenu(props: WorkspaceMenuProps) @{
	const principal = props.state.connection.authority?.principal;
	const workspace = principal?.tenantName ?? 'Not connected';

	<div class="workspace-menu">
		<button
			class="workspace-menu__button"
			type="button"
			aria-expanded={props.open}
			onClick={props.onToggle}
		>
			<Avatar name={workspace} square />
			<span class="workspace-menu__label">
				<b>{workspace}</b>
				<small>
					{principal?.email ?? props.state.configuration.platformUrl}
				</small>
			</span>
			<Icon name="chevrons-up-down" size={14} />
		</button>
		@if (props.open) {
			<div class="ui-menu workspace-menu__panel" role="menu">
				<div class="ui-menu__label">Connection</div>
				<div class="ui-menu__section">
					<span class="ui-cell">
						<b class="ui-mono">{props.state.configuration.platformUrl}</b>
						<small>
							{principal
								? 'Signed in as ' + principal.displayName + ' · ' +
									principal.role
								: 'No application is connected.'}
						</small>
					</span>
					<Tag
						tone={props.state.connection.connected ? 'success' : 'warning'}
						dot
					>
						{props.state.connection.connected ? 'connected' : 'offline'}
					</Tag>
				</div>
				<div class="ui-menu__sep"></div>
				<button
					class="ui-menu__item"
					type="button"
					role="menuitem"
					onClick={props.onChangeConnection}
				>
					<Icon name="plug" size={16} />
					Change workspace or token
				</button>
				<button
					class="ui-menu__item ui-menu__item--danger"
					type="button"
					role="menuitem"
					onClick={props.onDisconnect}
				>
					<Icon name="sign-out" size={16} />
					Disconnect this sandbox
				</button>
			</div>
		}
	</div>
}
