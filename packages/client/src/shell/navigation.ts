import { applicationPath } from '../routing.ts';
import type {
	NavigationContribution,
	NavigationGroup,
	NavigationSection,
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

/* One glyph per group on the rail; the label under it is the short form. */
export const NAVIGATION_GROUP_ICONS: Readonly<Record<NavigationGroup, string>> =
	{
		Workspace: 'dashboard',
		Operations: 'catalog',
		Agents: 'bot',
		Automations: 'refresh',
		Administration: 'settings',
		Development: 'flask',
	};

export function navigationRailLabel(
	t: Translate,
	group: NavigationGroup,
): string {
	return t('shell.nav.rail.' + group.toLowerCase());
}

/** The groups the rail shows: those with at least one item, in the fixed order. */
export function railGroups(
	items: readonly NavigationContribution[],
): readonly NavigationGroup[] {
	return NAVIGATION_GROUPS.filter((group) =>
		items.some((item) => item.group === group),
	);
}

/**
 * The group the panel shows: the pinned one while it still has items, else
 * the group of the active view, else the first group on the rail.
 */
export function selectedNavigationGroup(
	pinned: NavigationGroup | null,
	active: NavigationGroup | null,
	present: readonly NavigationGroup[],
): NavigationGroup | null {
	if (pinned !== null && present.includes(pinned)) return pinned;
	if (active !== null && present.includes(active)) return active;
	return present[0] ?? null;
}

export const NAVIGATION_SECTIONS: readonly NavigationSection[] = [
	'people',
	'identity',
	'compliance',
	'integrations',
	'platform',
];

export function navigationSectionLabel(
	t: Translate,
	section: NavigationSection,
): string {
	return t('shell.nav.section.' + section);
}

/**
 * The items of one group in the order the sidebar shows them: sections in
 * NAVIGATION_SECTIONS order, each keeping the items' own order, then the
 * items without a section under no label. A group where nothing declares a
 * section answers one unlabelled block.
 */
export function navigationSections(
	items: readonly NavigationContribution[],
): readonly {
	readonly section: NavigationSection | null;
	readonly items: readonly NavigationContribution[];
}[] {
	const blocks: {
		readonly section: NavigationSection | null;
		readonly items: readonly NavigationContribution[];
	}[] = [];
	for (const section of NAVIGATION_SECTIONS) {
		const inSection = items.filter((item) => item.section === section);
		if (inSection.length > 0) blocks.push({ section, items: inSection });
	}
	const rest = items.filter((item) => item.section === undefined);
	if (rest.length > 0) blocks.push({ section: null, items: rest });
	return blocks;
}

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
