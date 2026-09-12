import { applicationPath } from '../routing.ts';
import type {
	NavigationContribution,
	NavigationGroup,
} from '../contributions.ts';
import type { Translate } from '../i18n/translations.ts';
import type { ShellView } from '../state.ts';

export function coreNavigation(
	t: Translate,
): readonly NavigationContribution[] {
	return [
		{
			id: 'system.navigation.overview',
			viewId: 'overview',
			group: 'Workspace',
			label: t('shell.nav.dashboard.label'),
			glyph: 'dashboard',
			description: t('shell.nav.dashboard.description'),
			scope: 'system.workspace.access',
			order: 10,
		},
	];
}

export const NAVIGATION_GROUPS: readonly NavigationGroup[] = [
	'Workspace',
	'Operations',
	'Agents',
	'Automations',
	'Administration',
	'Development',
];

/* The group name is an identifier in the contribution and a label on screen;
   only the label is translated. */
export function navigationGroupLabel(
	t: Translate,
	group: NavigationGroup | 'Account',
): string {
	return t('shell.nav.group.' + group.toLowerCase());
}

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

/**
 * A hit's route, or null when it is not a plain path inside this workspace.
 * The route comes from a module, and the shell pushes it at the browser: a
 * protocol-relative `//host` leaves the application, and a backslash does the
 * same once the URL parser normalizes it to a slash.
 */
export function workspaceHitRoute(route: string): string | null {
	if (typeof route !== 'string') return null;
	if (!route.startsWith('/') || route.startsWith('//')) return null;
	return route.includes('\\') ? null : route;
}

export function viewHref(
	viewId: ShellView,
	workspaceSlug?: string | null,
): string {
	const base = workspaceSlug
		? applicationPath() + '/' + workspaceSlug
		: applicationPath();
	if (viewId === 'overview') return base;
	return base + '/' + viewId;
}
