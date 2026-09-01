import type { OctaneNode } from 'octane';

export const WORKSPACE_SLOTS = [
	'dashboard.metrics',
	'dashboard.main',
	'dashboard.aside',
	'topbar.actions',
] as const;

export type WorkspaceSlot = (typeof WORKSPACE_SLOTS)[number];
export type NavigationGroup =
	| 'Workspace'
	| 'Operations'
	| 'Agents'
	| 'Administration'
	| 'Development';

export interface ModuleClientContext {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
}

export interface ClientViewContribution {
	readonly id: string;
	readonly render: () => OctaneNode;
}

export interface NavigationContribution {
	readonly id: string;
	readonly viewId: string;
	readonly group: NavigationGroup;
	readonly label: string;
	readonly glyph: string;
	readonly description: string;
	readonly scope: string;
	readonly order: number;
}

/* A view reached from the account menu behind the avatar, not from the
   sidebar. Personal settings belong to the person, not to the workspace
   navigation. */
export interface AccountMenuContribution {
	readonly id: string;
	readonly viewId: string;
	readonly label: string;
	readonly description: string;
	readonly glyph: string;
	readonly scope: string;
	readonly order: number;
}

export interface WidgetContribution {
	readonly id: string;
	readonly slot: WorkspaceSlot;
	readonly scope: string;
	readonly order: number;
	readonly render: () => OctaneNode;
}

export interface ModuleClientContribution {
	readonly moduleId: string;
	readonly navigation?: readonly NavigationContribution[];
	readonly accountMenu?: readonly AccountMenuContribution[];
	readonly views?: readonly ClientViewContribution[];
	readonly widgets?: readonly WidgetContribution[];
}

export interface ClientContributionRegistry {
	readonly navigation: readonly NavigationContribution[];
	readonly accountMenu: readonly AccountMenuContribution[];
	readonly views: readonly ClientViewContribution[];
	readonly widgets: readonly WidgetContribution[];
}

function assertUnique(values: readonly string[], kind: string): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) {
			throw new Error(`Duplicate client contribution ${kind}: ${value}`);
		}
		seen.add(value);
	}
}

export function createClientContributionRegistry(
	modules: readonly ModuleClientContribution[],
): ClientContributionRegistry {
	assertUnique(
		modules.map((module) => module.moduleId),
		'module id',
	);

	const navigation = modules.flatMap((module) => module.navigation ?? []);
	const accountMenu = modules.flatMap((module) => module.accountMenu ?? []);
	const views = modules.flatMap((module) => module.views ?? []);
	const widgets = modules.flatMap((module) => module.widgets ?? []);

	assertUnique(
		navigation.map((item) => item.id),
		'navigation id',
	);
	assertUnique(
		accountMenu.map((item) => item.id),
		'account menu id',
	);
	assertUnique(
		views.map((view) => view.id),
		'view id',
	);
	assertUnique(
		widgets.map((widget) => widget.id),
		'widget id',
	);

	const viewIds = new Set(views.map((view) => view.id));
	for (const item of navigation) {
		if (!viewIds.has(item.viewId)) {
			throw new Error(
				`Navigation contribution ${item.id} targets unknown view ${item.viewId}`,
			);
		}
	}
	for (const item of accountMenu) {
		if (!viewIds.has(item.viewId)) {
			throw new Error(
				`Account menu contribution ${item.id} targets unknown view ${item.viewId}`,
			);
		}
	}

	const slots = new Set<string>(WORKSPACE_SLOTS);
	for (const widget of widgets) {
		if (!slots.has(widget.slot)) {
			throw new Error(
				`Widget contribution ${widget.id} targets unknown slot ${widget.slot}`,
			);
		}
	}

	return {
		navigation: [...navigation].sort(
			(left, right) =>
				left.order - right.order || left.id.localeCompare(right.id),
		),
		accountMenu: [...accountMenu].sort(
			(left, right) =>
				left.order - right.order || left.id.localeCompare(right.id),
		),
		views: [...views].sort((left, right) => left.id.localeCompare(right.id)),
		widgets: [...widgets].sort(
			(left, right) =>
				left.order - right.order || left.id.localeCompare(right.id),
		),
	};
}
