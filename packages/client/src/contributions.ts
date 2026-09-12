import type { OctaneNode } from 'octane';
import type { LocaleBundles, Translate } from './i18n/translations.ts';

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
	| 'Automations'
	| 'Administration'
	| 'Development';

export interface ModuleClientContext {
	readonly csrfToken: string;
	readonly scopes: readonly string[];
	readonly locale: string;
	/** Takes a fully qualified key, `<module>.<screen>.<element>`. */
	readonly t: Translate;
}

export interface ModuleClientInitializationContext {
	readonly accountId: string;
	readonly tenantId: string;
	readonly signal: AbortSignal;
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

/** One record a contributed search answered with. */
export interface CommandSearchHit {
	/** Stable inside one result set, so a list can key on it. */
	readonly id: string;
	/** Groups the hit in the palette; the shell never interprets it. */
	readonly provider: string;
	readonly providerLabel: string;
	readonly title: string;
	readonly snippet: string;
	/** The view the hit opens, as a `views` contribution declares its id. */
	readonly viewId: string;
	/** Workspace-relative path starting with "/", such as `/users?member=a1`. */
	readonly route: string;
}

export interface CommandSearchRequest {
	readonly query: string;
	/** Aborted when the member types on, so a stale answer is never shown. */
	readonly signal: AbortSignal;
}

/**
 * Record hits for the command palette. The shell knows nothing about who
 * answers or how: it asks every contribution whose scope the member holds and
 * lists what comes back below the navigation entries. A contribution that
 * fails contributes nothing and never blocks navigation.
 */
export interface CommandSearchContribution {
	readonly id: string;
	readonly scope: string;
	readonly order: number;
	search(request: CommandSearchRequest): Promise<readonly CommandSearchHit[]>;
	/**
	 * The member opened a hit this contribution answered with. Called once, on
	 * that contribution alone, while the shell is already navigating: the result
	 * is never awaited and a throw or a rejection is isolated, so bookkeeping of
	 * any kind cannot delay or stop the record from opening.
	 */
	onOpen?(hit: CommandSearchHit): void | Promise<void>;
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
	/** Every locale file the module ships, statically imported by its entry. */
	readonly translations?: LocaleBundles;
	/** Runs before the signed-in workspace is shown for this account and tenant. */
	readonly initialize?: (
		context: ModuleClientInitializationContext,
	) => void | Promise<void>;
	readonly navigation?: readonly NavigationContribution[];
	readonly accountMenu?: readonly AccountMenuContribution[];
	readonly views?: readonly ClientViewContribution[];
	readonly widgets?: readonly WidgetContribution[];
	/** Record hits the command palette lists below the navigation entries. */
	readonly commandSearch?: CommandSearchContribution;
}

export interface ClientContributionRegistry {
	readonly navigation: readonly NavigationContribution[];
	readonly accountMenu: readonly AccountMenuContribution[];
	readonly views: readonly ClientViewContribution[];
	readonly widgets: readonly WidgetContribution[];
	readonly commandSearch: readonly CommandSearchContribution[];
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
	const commandSearch = modules.flatMap((module) =>
		module.commandSearch ? [module.commandSearch] : [],
	);

	assertUnique(
		commandSearch.map((entry) => entry.id),
		'command search id',
	);
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
		commandSearch: [...commandSearch].sort(
			(left, right) =>
				left.order - right.order || left.id.localeCompare(right.id),
		),
	};
}
