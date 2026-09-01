import type { ModuleClientContribution } from '../contributions.ts';
import type { ShellView } from '../state.ts';

export interface ShellTenant {
	readonly tenantId: string;
	readonly name: string;
	readonly slug: string;
	readonly role: string;
}

export interface ShellIdentity {
	readonly email: string;
	readonly displayName: string;
	readonly role: string;
	readonly scopes: readonly string[];
	readonly tenantId: string;
	readonly tenants: readonly ShellTenant[];
}

export interface ApplicationShellProps {
	initialView?: ShellView;
	contributions?: readonly ModuleClientContribution[];
	identity: ShellIdentity;
	onSignOut: () => void | Promise<void>;
	onSwitchTenant: (tenantId: string) => void | Promise<void>;
}

export type NavigateToView = (viewId: ShellView) => void;
