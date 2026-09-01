import { useEffect, useMemo } from 'octane';
import { Alert, Button, EmptyState, Icon, PageHeader } from '@coreloom/ui';
import { cell, createStore, useValue } from 'segment-state';
import {
	ApiError,
	loadDefaultLocale,
	renameWorkspace,
	updateDefaultLocale,
	type LocaleSetting,
} from './api.ts';
import { PreferencesCard } from './PreferencesCard.tsrx';
import { WorkspaceCard } from './WorkspaceCard.tsrx';

export interface SettingsViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

/* Fired after a change the shell shows (the workspace name); the
   authentication root reloads the session so the principal stays current. */
export const SESSION_REFRESH_EVENT = 'coreloom:session-refresh';

type SettingsStatus = 'loading' | 'idle' | 'denied' | 'error';

interface RowResult {
	readonly ok: boolean;
	readonly message: string;
}

interface WorkspaceIdentity {
	readonly name: string;
	readonly slug: string;
}

function createSettingsState() {
	const store = createStore({
		workspace: cell<WorkspaceIdentity | null>(null),
		locale: cell<LocaleSetting | null>(null),
		status: cell<SettingsStatus>('loading'),
		error: '',
		busyKey: cell<string | null>(null),
		workspaceResult: cell<RowResult | null>(null),
		localeResult: cell<RowResult | null>(null),
	});
	return { store, state: store.state };
}

async function loadWorkspace(): Promise<WorkspaceIdentity | null> {
	const response = await fetch('/api/auth/session', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	if (!response.ok) return null;
	const body = await response.json() as {
		principal: {
			tenantId: string;
			tenants: { tenantId: string; name: string; slug: string }[];
		};
	};
	const tenant = body.principal.tenants.find(
		(entry) => entry.tenantId === body.principal.tenantId,
	);
	return tenant ? { name: tenant.name, slug: tenant.slug } : null;
}

function message(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

/* Workspace-only settings: identity and defaults of this organization. A
   module's declared settings are edited in its drawer under
   Administration > Modules, served by system.core. */
export function SettingsView(props: SettingsViewProps) @{
	const client = useMemo(() => createSettingsState(), []);
	const [workspace] = useValue(client.state.workspace);
	const [locale] = useValue(client.state.locale);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [busyKey, setBusyKey] = useValue(client.state.busyKey);
	const [workspaceResult] = useValue(client.state.workspaceResult);
	const [localeResult] = useValue(client.state.localeResult);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const [loadedLocale, identity] = await Promise.all([
				loadDefaultLocale(),
				loadWorkspace(),
			]);
			client.store.act((transaction) => {
				transaction.set(client.state.locale, loadedLocale);
				transaction.set(client.state.workspace, identity);
				transaction.set(client.state.status, 'idle');
			}, 'settings/loaded');
		} catch (loadError) {
			setError(message(loadError, 'Could not load settings.'));
			setStatus(
				loadError instanceof ApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const saveLocale = async (value: string) => {
		setBusyKey('locale');
		try {
			const updated = await updateDefaultLocale(value, props.csrfToken);
			client.store.act((transaction) => {
				transaction.set(client.state.locale, updated);
				transaction.set(client.state.localeResult, {
					ok: true,
					message: 'Saved.',
				});
				transaction.set(client.state.busyKey, null);
			}, 'settings/locale-saved');
		} catch (saveError) {
			client.store.act((transaction) => {
				transaction.set(client.state.localeResult, {
					ok: false,
					message: message(saveError, 'Could not save the default locale.'),
				});
				transaction.set(client.state.busyKey, null);
			}, 'settings/locale-save-failed');
		}
	};

	const rename = async (name: string) => {
		setBusyKey('workspace');
		try {
			const tenant = await renameWorkspace(name, props.csrfToken);
			client.store.act((transaction) => {
				transaction.set(client.state.workspace, {
					name: tenant.name,
					slug: workspace?.slug ?? '',
				});
				transaction.set(client.state.workspaceResult, {
					ok: true,
					message: 'Saved.',
				});
				transaction.set(client.state.busyKey, null);
			}, 'settings/workspace-renamed');
			window.dispatchEvent(new Event(SESSION_REFRESH_EVENT));
		} catch (renameError) {
			client.store.act((transaction) => {
				transaction.set(client.state.workspaceResult, {
					ok: false,
					message: message(renameError, 'Could not rename the workspace.'),
				});
				transaction.set(client.state.busyKey, null);
			}, 'settings/workspace-rename-failed');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow="Administration"
			title="Workspace settings"
			description="Identity and defaults of this organization."
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				Refresh
			</Button>
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title="Access denied">
					Reading settings needs the system.settings.read scope.
				</EmptyState>
			</section>
		} @else if (status === 'loading' && workspace === null) {
			<section class="ui-card">
				<p class="ui-table__empty">Loading settings…</p>
			</section>
		} @else {
			<>
				@if (status === 'error') {
					<Alert>{error}</Alert>
				}
				@if (!props.canManage) {
					<Alert tone="info">
						You can review settings. Changing them needs the
						system.settings.manage scope.
					</Alert>
				}
				@if (workspace) {
					<WorkspaceCard
						name={workspace.name}
						slug={workspace.slug}
						canManage={props.canManage}
						busy={busyKey === 'workspace'}
						result={workspaceResult}
						onRename={(name) => void rename(name)}
					/>
				}
				@if (locale) {
					<PreferencesCard
						locale={locale}
						canManage={props.canManage}
						busy={busyKey === 'locale'}
						result={localeResult}
						onSave={(value) => void saveLocale(value)}
					/>
				}
			</>
		}
	</div>
}
