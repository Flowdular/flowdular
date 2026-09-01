import type {
	NavigationContribution,
	NavigationGroup,
} from '../contributions.ts';
import type { ShellView } from '../state.ts';

export const CORE_NAVIGATION: readonly NavigationContribution[] = [
	{
		id: 'system.navigation.overview',
		viewId: 'overview',
		group: 'Workspace',
		label: 'Dashboard',
		glyph: 'dashboard',
		description: 'Business overview',
		scope: 'system.workspace.access',
		order: 10,
	},
];

export const NAVIGATION_GROUPS: readonly NavigationGroup[] = [
	'Workspace',
	'Operations',
	'Agents',
	'Administration',
	'Development',
];

export interface NavigationIdentity {
	readonly role: string;
	readonly scopes: readonly string[];
}

export function navigationForIdentity(
	items: readonly NavigationContribution[],
	identity: NavigationIdentity,
): readonly NavigationContribution[] {
	const grantedScopes = new Set(identity.scopes);
	return items.filter(
		(item) =>
			grantedScopes.has(item.scope) &&
			(item.group !== 'Development' || identity.role === 'owner'),
	);
}

export function viewHref(
	viewId: ShellView,
	workspaceSlug?: string | null,
): string {
	const base = workspaceSlug ? '/' + workspaceSlug : '';
	if (viewId === 'overview') return base === '' ? '/' : base;
	return base + '/' + viewId;
}
