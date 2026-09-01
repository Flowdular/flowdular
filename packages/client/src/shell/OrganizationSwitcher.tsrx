import { useEffect, useMemo } from 'octane';
import { Avatar, Icon } from '@coreloom/ui';
import { useValue } from 'segment-state';
import { cell, createStore } from 'segment-state';
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
	const activeTenantName = activeTenant?.name ?? 'Active organization';
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
				<small>
					{activeTenantRole + ' · ' + props.identity.tenants.length +
						(props.identity.tenants.length === 1
							? ' workspace'
							: ' workspaces')}
				</small>
			</span>
			<Icon name="chevrons-up-down" size={16} />
		</button>
		@if (open) {
			<>
				<button
					class="menu-dismiss"
					type="button"
					aria-label="Close workspace selector"
					onClick={() => setOpen(false)}
				></button>
				<div
					class="ui-menu org-switcher__menu"
					role="listbox"
					aria-label="Available workspaces"
				>
					<div class="ui-menu__label">Switch workspace</div>
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
