import { useEffect, useMemo } from 'octane';
import { Avatar, Icon } from '@flowdular/ui';
import { useValue } from 'segment-state';
import { cell, createStore } from 'segment-state';
import type { AccountMenuContribution } from '../contributions.ts';
import { useTranslation } from '../i18n/runtime.ts';
import type { NavigateToView, ShellIdentity } from './types.ts';

export interface UserMenuProps {
	identity: ShellIdentity;
	/** Personal views contributed by modules, reached only from here. */
	items: readonly AccountMenuContribution[];
	activeView: string;
	onNavigate: NavigateToView;
	onSignOut: () => void;
}

export function UserMenu(props: UserMenuProps) @{
	const dropdown = useMemo(() => createStore({ open: cell(false) }), []);
	const [open, setOpen] = useValue(dropdown.state.open);
	const { t } = useTranslation();
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setOpen(false);
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [setOpen]);
	<div class="user-menu">
		<button
			class="user-menu__trigger"
			type="button"
			aria-haspopup="menu"
			aria-expanded={open}
			aria-label={t('shell.account.menu')}
			onClick={() => setOpen((current) => !current)}
		>
			<Avatar name={props.identity.displayName} />
		</button>
		@if (open) {
			<>
				<button
					class="menu-dismiss"
					type="button"
					aria-label={t('shell.account.close')}
					onClick={() => setOpen(false)}
				></button>
				<div
					class="ui-menu user-menu__panel"
					role="menu"
					aria-label={t('shell.account.label')}
				>
					<div class="ui-menu__section">
						<Avatar name={props.identity.displayName} large />
						<span class="ui-cell">
							<b>{props.identity.displayName}</b>
							<small>{props.identity.email}</small>
							<small>{props.identity.role}</small>
						</span>
					</div>
					@if (props.items.length > 0) {
						<>
							<div class="ui-menu__sep"></div>
							@for (const item of props.items; key item.id) {
								<button
									class={[
										'ui-menu__item',
										props.activeView === item.viewId && 'ui-menu__item--active',
									]}
									type="button"
									role="menuitem"
									onClick={() => {
										setOpen(false);
										props.onNavigate(item.viewId);
									}}
								>
									<Icon name={item.glyph} size={16} />
									<span class="ui-cell">
										<b>{item.label}</b>
										<small>{item.description}</small>
									</span>
								</button>
							}
						</>
					}
					<div class="ui-menu__sep"></div>
					<button
						class="ui-menu__item ui-menu__item--danger"
						type="button"
						role="menuitem"
						onClick={() => {
							setOpen(false);
							props.onSignOut();
						}}
					>
						<Icon name="sign-out" size={16} />
						{t('shell.account.signOut')}
					</button>
				</div>
			</>
		}
	</div>
}
