import { Seo } from '@octanejs/seo';
import { useEffect, useMemo } from 'octane';
import { cell, createStore, useValue } from 'segment-state';
import {
	createClientContributionRegistry,
	type CommandSearchHit,
	type NavigationGroup,
} from './contributions.ts';
import { applicationPath } from './routing.ts';
import { commandSearchHitOpened } from './shell/command-search.ts';
import { onOpenCommandPalette } from './shell/command.ts';
import { CommandPalette } from './shell/CommandPalette.tsrx';
import { widgetsForSlot } from './shell/ContributionOutlets.tsrx';
import { registerModuleTranslations, useTranslation } from './i18n/runtime.ts';
import { MobileHeader } from './shell/MobileHeader.tsrx';
import {
	coreNavigation,
	navigationForIdentity,
	navigationGroupLabel,
	viewHref,
	workspaceHitRoute,
} from './shell/navigation.ts';
import { Sidebar } from './shell/Sidebar.tsrx';
import { Topbar } from './shell/Topbar.tsrx';
import type { ApplicationShellProps } from './shell/types.ts';
import { WorkspaceContent } from './shell/WorkspaceContent.tsrx';
import {
	createShellState,
	shellLocationFromUrl,
	toggleNavigationGroup,
	type ShellView,
} from './state.ts';
import '@flowdular/ui';
import './shell/shell.css';

export type { ApplicationShellProps } from './shell/types.ts';

const SIDEBAR_STORAGE_KEY = 'flowdular.sidebar';

export function ApplicationShell(props: ApplicationShellProps) @{
	/* Register synchronously on every render. `useMemo` state may survive a Vite
   replacement of the i18n runtime, so registration cannot live inside that
   cache without exposing raw module keys after HMR. Rebuilding with the same
   locale is side-effect free for subscribers. */
	registerModuleTranslations(props.contributions ?? []);
	const { t } = useTranslation();
	const registry = useMemo(
		() => createClientContributionRegistry(props.contributions ?? []),
		[props.contributions],
	);
	const shell = useMemo(() => createShellState(props.initialView), [
		props.initialView,
	]);
	const initialization = useMemo(
		() => createStore({
			tenantId: cell<string | null>(
				(props.contributions ?? []).some(
					(contribution) => contribution.initialize !== undefined,
				)
					? null
					: props.identity.tenantId,
			),
		}),
		[],
	);
	const [initializedTenant, setInitializedTenant] = useValue(
		initialization.state.tenantId,
	);
	const [activeView, setActiveView] = useValue(shell.state.activeView);
	const [commandOpen, setCommandOpen] = useValue(shell.state.commandOpen);
	const [navigationOpen, setNavigationOpen] = useValue(
		shell.state.navigationOpen,
	);
	const [sidebarCollapsed, setSidebarCollapsed] = useValue(
		shell.state.sidebarCollapsed,
	);
	const [collapsedNavigationGroups, setCollapsedNavigationGroups] = useValue(
		shell.state.collapsedNavigationGroups,
	);
	const [query, setQuery] = useValue(shell.state.query);
	const [tenantBusy, setTenantBusy] = useValue(shell.state.tenantBusy);
	const [tenantError, setTenantError] = useValue(shell.state.tenantError);
	const workspaceInitialized = initializedTenant === props.identity.tenantId;
	const grantedScopes = new Set(props.identity.scopes);
	const visibleNavigation = navigationForIdentity(
		[...coreNavigation(t), ...registry.navigation],
		props.identity,
	);
	const visibleAccountMenu = registry.accountMenu.filter(
		(item) => grantedScopes.has(item.scope),
	);
	const reachableViews = new Set([
		...visibleNavigation.map((item) => item.viewId),
		...visibleAccountMenu.map((item) => item.viewId),
	]);
	const knownWorkspaceSlugs = props.identity.tenants.map(
		(tenant) => tenant.slug,
	);
	const activeWorkspaceSlug =
		props.identity.tenants.find(
			(tenant) => tenant.tenantId === props.identity.tenantId,
		)?.slug ?? null;
	const effectiveView = reachableViews.has(activeView)
		? activeView
		: 'overview';
	const activeDefinition =
		visibleNavigation.find((item) => item.viewId === effectiveView) ??
			visibleNavigation[0];
	const activeAccountItem =
		visibleAccountMenu.find((item) => item.viewId === effectiveView) ?? null;
	const activeGroup = navigationGroupLabel(
		t,
		activeAccountItem ? 'Account' : activeDefinition?.group ?? 'Workspace',
	);
	const activeLabel =
		activeAccountItem?.label ?? activeDefinition?.label ??
			t('shell.workspace.title');
	const activeDescription =
		activeAccountItem?.description ?? activeDefinition?.description ??
			t('shell.workspace.description');
	const activeExtensionView = registry.views.find(
		(view) => view.id === effectiveView,
	);
	const visibleWidgets = registry.widgets.filter(
		(widget) => grantedScopes.has(widget.scope),
	);
	/* Memoized because the palette debounces on this list's identity: a fresh
   array every render would restart the wait on every keystroke. */
	const visibleSearches = useMemo(
		() => registry.commandSearch.filter(
			(entry) => props.identity.scopes.includes(entry.scope),
		),
		[registry, props.identity.scopes.join(' ')],
	);
	const topbarWidgets = widgetsForSlot(visibleWidgets, 'topbar.actions');
	const activeTenantName =
		props.identity.tenants.find(
			(tenant) => tenant.tenantId === props.identity.tenantId,
		)?.name ??
			t('shell.workspace.fallbackName');

	const navigate = (viewId: ShellView) => {
		history.pushState(null, '', viewHref(viewId, activeWorkspaceSlug));
		setActiveView(viewId);
		setNavigationOpen(false);
		setCommandOpen(false);
	};

	/* A hit's route is workspace-relative and comes from a module, so anything
   that is not a plain in-workspace path falls back to the hit's view rather
   than being pushed at the browser. */
	const openHit = (hit: CommandSearchHit) => {
		commandSearchHitOpened(hit);
		const base =
			activeWorkspaceSlug
				? applicationPath() + '/' + activeWorkspaceSlug
				: applicationPath();
		const route = workspaceHitRoute(hit.route);
		const relative =
			route === null ? viewHref(hit.viewId, activeWorkspaceSlug) : base + route;
		history.pushState(null, '', relative);
		setActiveView(hit.viewId);
		setNavigationOpen(false);
		setCommandOpen(false);
	};

	const switchTenant = (tenantId: string) => {
		setTenantBusy(true);
		setTenantError('');
		void Promise.resolve(props.onSwitchTenant(tenantId)).catch(
			(error) => setTenantError(
				error instanceof Error
					? error.message
					: t('shell.workspace.switchFailed'),
			),
		).finally(() => setTenantBusy(false));
	};

	const toggleGroup = (group: NavigationGroup) => {
		setCollapsedNavigationGroups(
			(current) => toggleNavigationGroup(current, group),
		);
	};

	const toggleSidebar = () => {
		setSidebarCollapsed((current) => {
			const next = !current;
			try {
				localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? 'rail' : 'full');
			} catch {
				// Storage can be unavailable; the preference is a convenience only.
			}
			return next;
		});
	};

	useEffect(() => {
		const controller = new AbortController();
		const initializers = (props.contributions ?? []).flatMap(
			(contribution) => contribution.initialize
				? [contribution.initialize]
				: [],
		);
		setInitializedTenant(
			initializers.length === 0 ? props.identity.tenantId : null,
		);
		if (initializers.length > 0) {
			void Promise.allSettled(
				initializers.map(
					(initialize) => initialize({
						accountId: props.identity.accountId,
						tenantId: props.identity.tenantId,
						signal: controller.signal,
					}),
				),
			).then(() => {
				if (!controller.signal.aborted) {
					setInitializedTenant(props.identity.tenantId);
				}
			});
		}
		return () => controller.abort();
	}, [props.identity.accountId, props.identity.tenantId]);

	useEffect(() => {
		try {
			if (localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'rail') {
				setSidebarCollapsed(true);
			}
		} catch {
			// Ignore unavailable storage.
		}
	}, [setSidebarCollapsed]);

	/* Keep the address bar canonical (/{workspaceSlug}/{view}) and honor
   bookmarks that point at another workspace the account can access. */
	useEffect(() => {
		const location = shellLocationFromUrl(
			window.location.href,
			knownWorkspaceSlugs,
		);
		if (
			location.workspaceSlug !== null &&
				location.workspaceSlug !== activeWorkspaceSlug
		) {
			const target = props.identity.tenants.find(
				(tenant) => tenant.slug === location.workspaceSlug,
			);
			if (target && !tenantBusy) {
				setActiveView(location.view);
				switchTenant(target.tenantId);
				return;
			}
		}
		const canonical = viewHref(effectiveView, activeWorkspaceSlug);
		if (window.location.pathname !== canonical) {
			history.replaceState(
				null,
				'',
				canonical + window.location.search + window.location.hash,
			);
		}
	}, [activeWorkspaceSlug, effectiveView]);

	/* A module widget opens the palette through this, so the shell keeps owning
   the palette state and no contribution has to reach into it. */
	useEffect(
		() => onOpenCommandPalette((seed) => {
			if (seed !== '') setQuery(seed);
			setCommandOpen(true);
		}),
		[setCommandOpen, setQuery],
	);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
				event.preventDefault();
				setCommandOpen((current) => !current);
			}
			if (event.key === 'Escape') setCommandOpen(false);
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [setCommandOpen]);

	useEffect(() => {
		const onPopState = () => {
			const location = shellLocationFromUrl(
				window.location.href,
				knownWorkspaceSlugs,
			);
			if (
				location.workspaceSlug !== null &&
					location.workspaceSlug !== activeWorkspaceSlug
			) {
				const target = props.identity.tenants.find(
					(tenant) => tenant.slug === location.workspaceSlug,
				);
				if (target) switchTenant(target.tenantId);
			}
			setActiveView(location.view);
		};
		window.addEventListener('popstate', onPopState);
		return () => window.removeEventListener('popstate', onPopState);
	}, [setActiveView, activeWorkspaceSlug, knownWorkspaceSlugs.join(' ')]);

	useEffect(() => {
		const onInternalNavigation = (event: MouseEvent) => {
			if (
				event.defaultPrevented || event.button !== 0 || event.metaKey ||
					event.ctrlKey ||
					event.shiftKey ||
					event.altKey ||
					!(event.target instanceof Element)
			) return;
			const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
			if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
			const url = new URL(anchor.href, window.location.href);
			if (url.origin !== window.location.origin) return;
			const location = shellLocationFromUrl(url.href, knownWorkspaceSlugs);
			if (
				location.workspaceSlug !== null &&
					location.workspaceSlug !== activeWorkspaceSlug
			) {
				const target = props.identity.tenants.find(
					(tenant) => tenant.slug === location.workspaceSlug,
				);
				if (!target) return;
				event.preventDefault();
				history.pushState(null, '', url.pathname + url.search + url.hash);
				setActiveView(location.view);
				setNavigationOpen(false);
				switchTenant(target.tenantId);
				return;
			}
			if (!reachableViews.has(location.view)) return;
			event.preventDefault();
			navigate(location.view);
		};
		document.addEventListener('click', onInternalNavigation);
		return () => document.removeEventListener('click', onInternalNavigation);
	}, [setActiveView, setNavigationOpen, visibleNavigation, activeWorkspaceSlug]);

	@if (!workspaceInitialized) {
		<div class="app-shell" role="status" aria-busy="true">
			<section class="ui-card">
				<p class="ui-table__empty">{t('shell.workspace.initializing')}</p>
			</section>
		</div>
	} @else {
		<div class={['app-shell', sidebarCollapsed && 'app-shell--rail']}>
			<Seo title={activeLabel} description={activeDescription} />
			<MobileHeader onToggle={() => setNavigationOpen((open) => !open)} />
			<Sidebar
				open={navigationOpen}
				collapsed={sidebarCollapsed}
				identity={props.identity}
				items={visibleNavigation}
				activeView={effectiveView}
				workspaceSlug={activeWorkspaceSlug}
				collapsedGroups={collapsedNavigationGroups}
				tenantBusy={tenantBusy}
				tenantError={tenantError}
				onClose={() => setNavigationOpen(false)}
				onToggleCollapsed={toggleSidebar}
				onNavigate={navigate}
				onToggleGroup={toggleGroup}
				onSelectTenant={switchTenant}
			/>
			<main class="workspace">
				{/* Module screens load their records once, on mount. Keying the
    workspace by tenant remounts them after a switch, so a screen can
    never keep the previous organization's data on screen. */}
				<Topbar
					key={props.identity.tenantId}
					activeGroup={activeGroup}
					activeLabel={activeLabel}
					identity={props.identity}
					accountMenu={visibleAccountMenu}
					activeView={effectiveView}
					widgets={topbarWidgets}
					onOpenCommand={() => setCommandOpen(true)}
					onNavigate={navigate}
					onSignOut={() => void props.onSignOut()}
				/>
				<WorkspaceContent
					key={props.identity.tenantId}
					activeView={effectiveView}
					extensionView={activeExtensionView}
					widgets={visibleWidgets}
					tenantName={activeTenantName}
					displayName={props.identity.displayName}
				/>
			</main>
			@if (navigationOpen) {
				<button
					class="scrim"
					type="button"
					aria-label={t('shell.nav.close')}
					onClick={() => setNavigationOpen(false)}
				></button>
			}
			@if (commandOpen) {
				<CommandPalette
					items={visibleNavigation}
					searches={visibleSearches}
					query={query}
					onQuery={setQuery}
					onNavigate={navigate}
					onOpenHit={openHit}
					onClose={() => setCommandOpen(false)}
				/>
			}
		</div>
	}
}
