import { applicationPath } from './routing.ts';
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
	const pathname = new URL(value, 'https://flowdular.local').pathname;
	const segments = pathname.split('/').filter(Boolean);
	return (
		(segments[0] === applicationPath().slice(1) || segments[0] === 'app'
			? segments[2]
			: segments[0]) ?? 'overview'
	);
}

/* Canonical workspace URLs live below /app. Slug-first and view-only links are
   still read so bookmarks from before that prefix keep working. */
export function shellLocationFromUrl(
	value: string,
	knownWorkspaceSlugs: readonly string[],
): ShellLocation {
	const pathname = new URL(value, 'https://flowdular.local').pathname;
	const segments = pathname.split('/').filter(Boolean);
	if (segments[0] === applicationPath().slice(1) || segments[0] === 'app') {
		const workspace = segments[1];
		if (workspace !== undefined && knownWorkspaceSlugs.includes(workspace)) {
			return { workspaceSlug: workspace, view: segments[2] ?? 'overview' };
		}
		return { workspaceSlug: null, view: segments[1] ?? 'overview' };
	}
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
