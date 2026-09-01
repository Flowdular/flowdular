import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	Drawer,
	EmptyState,
	Icon,
	PageHeader,
	ScopeSummary,
	SearchField,
	Tag,
} from '@coreloom/ui';
import { useValue } from 'segment-state';
import { ApiError, loadModuleCatalog, type ModuleCatalogEntry } from './api.ts';
import { ModuleSettingsSection } from './ModuleSettingsSection.tsrx';
import { ModuleTable, surfaces } from './ModuleTable.tsrx';
import { createModulesClientState } from './state.ts';

export interface ModulesViewProps {
	readonly csrfToken: string;
	readonly canManageSettings: boolean;
}

export function ModulesView(props: ModulesViewProps) @{
	const client = useMemo(() => createModulesClientState(), []);
	const [modules] = useValue(client.state.modules);
	const [commands] = useValue(client.state.commands);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [selectedModuleId, setSelectedModuleId] = useValue(
		client.state.selectedModuleId,
	);
	const selected =
		modules.find((module) => module.id === selectedModuleId) ?? null;
	const term = query.trim().toLocaleLowerCase('en-US');
	const visible =
		term === ''
			? modules
			: modules.filter(
					(module) =>
						module.id.includes(term) ||
							module.name.toLocaleLowerCase('en-US').includes(term),
				);
	const enabled = modules.filter((module) => module.enabled);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const catalog = await loadModuleCatalog();
			client.store.act((transaction) => {
				transaction.set(client.state.modules, catalog.modules);
				transaction.set(client.state.commands, catalog.commands);
				transaction.set(client.state.status, 'idle');
			}, 'system/modules-loaded');
		} catch (loadError) {
			const denied = loadError instanceof ApiError && loadError.status === 403;
			setError(
				loadError instanceof Error
					? loadError.message
					: 'Could not load the module catalog.',
			);
			setStatus(denied ? 'denied' : 'error');
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	<div class="ui-view">
		<PageHeader
			eyebrow="Administration"
			title="Modules"
			description="Every module in this workspace, with the surfaces it adds to the platform."
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				Refresh
			</Button>
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title="Access denied">
					Reading the module catalog needs the system.modules.read scope.
				</EmptyState>
			</section>
		} @else {
			<>
				@if (status === 'error') {
					<Alert>{error}</Alert>
				}
				<section class="ui-card">
					<div class="ui-card__head">
						<span class="ui-card__title">
							Module catalog
							<small>
								{enabled.length + ' enabled · ' + modules.length +
									' in workspace'}
							</small>
						</span>
						<SearchField
							value={query}
							placeholder="Filter by id or name"
							label="Filter modules"
							onInput={setQuery}
						/>
					</div>
					@if (status === 'loading' && modules.length === 0) {
						<p class="ui-table__empty">Loading modules…</p>
					} @else if (visible.length === 0) {
						<EmptyState
							icon="modules"
							title={term === '' ? 'No modules found' : 'No matching modules'}
						>
							{term === ''
								? 'The workspace has no module manifests under modules/.'
								: 'No module matches the current filter.'}
						</EmptyState>
					} @else {
						<ModuleTable modules={visible} onSelect={setSelectedModuleId} />
					}
					<p class="ui-note">
						<Icon name="code" size={14} />
						<span>
							The enabled set is changed from the CLI, never from this screen:
							{' '}
							<code class="ui-mono">{commands.enable ?? ''}</code>
							{' · '}
							<code class="ui-mono">{commands.disable ?? ''}</code>
							{' · '}
							<code class="ui-mono">{commands.grantScopes ?? ''}</code>
						</span>
					</p>
				</section>
			</>
		}
		<Drawer
			open={selected !== null}
			title={selected?.name ?? 'Module'}
			subtitle={selected?.id ?? ''}
			width="lg"
			onClose={() => setSelectedModuleId(null)}
		>
			@if (selected) {
				<ModuleDetail
					module={selected}
					csrfToken={props.csrfToken}
					canManageSettings={props.canManageSettings}
				/>
			}
		</Drawer>
	</div>
}

function ModuleDetail(props: {
	readonly module: ModuleCatalogEntry;
	readonly csrfToken: string;
	readonly canManageSettings: boolean;
}) @{
	<div class="ui-drawer__body">
		<div class="ui-form">
			<div class="ui-form__section">
				<div class="ui-form__section-head">
					<b>Overview</b>
					@if (props.module.description) {
						<small>{props.module.description}</small>
					}
				</div>
				<div class="ui-form__row ui-form__row--4">
					<span class="ui-cell">
						<small>Version</small>
						<b class="ui-mono">{props.module.version || 'n/a'}</b>
					</span>
					<span class="ui-cell">
						<small>Spec version</small>
						<b class="ui-mono">{props.module.specVersion ?? 'none'}</b>
					</span>
					<span class="ui-cell">
						<small>Platform</small>
						<b>{surfaces(props.module)}</b>
					</span>
					<span class="ui-cell">
						<small>Status</small>
						<Tag tone={props.module.enabled ? 'success' : 'neutral'} dot>
							{props.module.enabled ? 'Enabled' : 'Available'}
						</Tag>
					</span>
				</div>
				<span class="ui-cell">
					<small>Capabilities</small>
					<span class="ui-mono">
						{props.module.capabilities.join(', ') || 'none'}
					</span>
				</span>
				<span class="ui-cell">
					<small>Directory</small>
					<span class="ui-mono">{props.module.directory}</span>
				</span>
			</div>
			<div class="ui-form__section">
				<div class="ui-form__section-head">
					<b>Permissions</b>
					<small>
						{props.module.permissions.length + ' scopes the module declares.'}
					</small>
				</div>
				@if (props.module.permissions.length === 0) {
					<span class="ui-help">This module declares no permissions.</span>
				} @else {
					<ScopeSummary
						scopes={props.module.permissions.map((permission) => permission.id)}
					/>
				}
			</div>
			<ModuleSettingsSection
				moduleId={props.module.id}
				csrfToken={props.csrfToken}
				canManage={props.canManageSettings}
			/>
		</div>
	</div>
}
