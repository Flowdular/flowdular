import { useEffect, useMemo } from 'octane';
import { Avatar, Icon } from '@flowdular/ui';
import { useValue } from 'segment-state';
import { cell, createStore } from 'segment-state';
import { t } from '../i18n/runtime.ts';
import type { ShellIdentity } from './types.ts';

export interface OrganizationSwitcherProps {
	identity: ShellIdentity;
	busy: boolean;
	error: string;
	onSelect: (tenantId: string) => void;
}

export function OrganizationSwitcher(props: OrganizationSwitcherProps) @{
	const dropdown = useMemo(() => createStore({ open: cell(false) }), []);
	const [open, setOpen] = useValue(dropdown.state.open);
	const activeTenant = props.identity.tenants.find(
		(tenant) => tenant.tenantId === props.identity.tenantId,
	);
	const activeTenantName =
		activeTenant?.name ?? t('shell.workspace.fallbackName');
	const activeTenantRole = activeTenant?.role ?? props.identity.role;
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setOpen(false);
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [setOpen]);
	<div class="org-switcher">
		<button
			class="org-switcher__control"
			type="button"
			aria-haspopup="listbox"
			aria-expanded={open}
			disabled={props.busy}
			onClick={() => setOpen((current) => !current)}
		>
			<Avatar name={activeTenantName} square />
			<span class="org-switcher__copy">
				<b>{activeTenantName}</b>
				<small>{t(
					props.identity.tenants.length === 1
						? 'shell.org.summary.one'
						: 'shell.org.summary.other',
					{ role: activeTenantRole, count: props.identity.tenants.length },
				)}</small>
			</span>
			<Icon name="chevrons-up-down" size={16} />
		</button>
		@if (open) {
			<>
				<button
					class="menu-dismiss"
					type="button"
					aria-label={t('shell.org.close')}
					onClick={() => setOpen(false)}
				></button>
				<div
					class="ui-menu org-switcher__menu"
					role="listbox"
					aria-label={t('shell.org.available')}
				>
					<div class="ui-menu__label">{t('shell.org.switch')}</div>
					@for (const tenant of props.identity.tenants; key tenant.tenantId) {
						<button
							class={[
								'ui-menu__item',
								tenant.tenantId === props.identity.tenantId &&
									'ui-menu__item--active',
							]}
							type="button"
							role="option"
							aria-selected={tenant.tenantId === props.identity.tenantId}
							onClick={() => {
								setOpen(false);
								if (tenant.tenantId !== props.identity.tenantId) {
									props.onSelect(tenant.tenantId);
								}
							}}
						>
							<Avatar name={tenant.name} square />
							<span class="ui-cell">
								<b>{tenant.name}</b>
								<small>{tenant.role}</small>
							</span>
							@if (tenant.tenantId === props.identity.tenantId) {
								<Icon name="check" size={16} />
							}
						</button>
					}
				</div>
			</>
		}
		@if (props.error) {
			<small class="org-switcher__error" role="alert">{props.error}</small>
		}
	</div>
}
