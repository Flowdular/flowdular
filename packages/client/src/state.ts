import { cell, createStore } from 'segment-state';

export type ShellView = string;

export interface ShellLocation {
	readonly workspaceSlug: string | null;
	readonly view: ShellView;
}

export function toggleNavigationGroup(
	groups: readonly string[],
	group: string,
): readonly string[] {
	return groups.includes(group)
		? groups.filter((candidate) => candidate !== group)
		: [...groups, group];
}

export function shellViewFromUrl(value: string): ShellView {
	const pathname = new URL(value, 'https://octane-erp.local').pathname;
	return pathname.split('/').filter(Boolean)[0] ?? 'overview';
}

/* Canonical workspace URLs are slug-first: /{workspaceSlug}/{viewId}. A first
   segment that is not a known workspace slug is treated as a view id, so
   legacy links like /parties keep working and get canonicalized by the shell. */
export function shellLocationFromUrl(
	value: string,
	knownWorkspaceSlugs: readonly string[],
): ShellLocation {
	const pathname = new URL(value, 'https://octane-erp.local').pathname;
	const segments = pathname.split('/').filter(Boolean);
	const first = segments[0];
	if (first !== undefined && knownWorkspaceSlugs.includes(first)) {
		return { workspaceSlug: first, view: segments[1] ?? 'overview' };
	}
	return { workspaceSlug: null, view: first ?? 'overview' };
}

export function createShellState(initialView: ShellView = 'overview') {
	const store = createStore({
		activeView: cell<ShellView>(initialView),
		commandOpen: false,
		navigationOpen: false,
		sidebarCollapsed: false,
		collapsedNavigationGroups: cell<readonly string[]>([]),
		query: '',
		tenantBusy: false,
		tenantError: '',
	});

	return { store, state: store.state };
}

export type ShellState = ReturnType<typeof createShellState>;
