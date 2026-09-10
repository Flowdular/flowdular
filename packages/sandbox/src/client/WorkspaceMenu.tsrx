import { Avatar, Icon, Tag } from '@flowdular/ui';
import type { SandboxState } from './api.ts';
import { setActiveLocale, SUPPORTED_LOCALES, useTranslation } from './i18n.ts';

export interface WorkspaceMenuProps {
	readonly state: SandboxState;
	readonly open: boolean;
	readonly onModels: () => void;
	readonly onToggle: () => void;
	readonly onChangeConnection: () => void;
	readonly onDisconnect: () => void;
}

/* The workspace this sandbox works against. A token is bound to one membership,
   so this is not a tenant switcher: changing workspace means changing the
   connection, and the menu says so. */
export function WorkspaceMenu(props: WorkspaceMenuProps) @{
	const { locale, t } = useTranslation();
	const principal = props.state.connection.authority?.principal;
	const workspace =
		principal?.tenantName ?? t('sandbox.workspace.notConnected');

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
				<div class="ui-menu__label">{t('sandbox.workspace.connection')}</div>
				<div class="ui-menu__section">
					<span class="ui-cell">
						<b class="ui-mono">{props.state.configuration.platformUrl}</b>
						<small>
							{principal
								? t('sandbox.workspace.signedIn', {
										name: principal.displayName,
										role: principal.role,
									})
								: t('sandbox.workspace.noConnection')}
						</small>
					</span>
					<Tag
						tone={props.state.connection.connected ? 'success' : 'warning'}
						dot
					>
						{props.state.connection.connected
							? t('sandbox.workspace.connected')
							: t('sandbox.workspace.offline')}
					</Tag>
				</div>
				<div class="ui-menu__sep"></div>
				<button
					class="ui-menu__item"
					type="button"
					role="menuitem"
					onClick={props.onModels}
				>{t('sandbox.models.title')}</button>
				<label class="ui-menu__item workspace-menu__language">
					<Icon name="globe" size={16} />
					<span>{t('sandbox.workspace.language')}</span>
					<select
						class="ui-select"
						value={locale}
						aria-label={t('sandbox.workspace.language')}
						onChange={(event) => setActiveLocale(event.currentTarget.value)}
					>
						@for (const option of SUPPORTED_LOCALES; key option) {
							<option value={option}>{t(
								'sandbox.workspace.language.' + option,
							)}</option>
						}
					</select>
				</label>
				<button
					class="ui-menu__item"
					type="button"
					role="menuitem"
					onClick={props.onChangeConnection}
				>
					<Icon name="plug" size={16} />
					{t('sandbox.workspace.change')}
				</button>
				<button
					class="ui-menu__item ui-menu__item--danger"
					type="button"
					role="menuitem"
					onClick={props.onDisconnect}
				>
					<Icon name="sign-out" size={16} />
					{t('sandbox.workspace.disconnect')}
				</button>
			</div>
		}
	</div>
}
