import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	ConfirmDialog,
	Drawer,
	EmptyState,
	Icon,
	PageHeader,
	ScopeSummary,
	SearchField,
	TableCard,
	Tabs,
	Tag,
} from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client';
import { useValue } from 'segment-state';
import {
	ApiError,
	loadModuleCatalog,
	setModuleActivation,
	type ModuleCatalogEntry,
} from './api.ts';
import { FlagsPanel } from './FlagsPanel.tsrx';
import {
	activationLabel,
	activationTone,
	moduleColumns,
	surfaces,
} from './module-columns.tsrx';
import { ModuleSettingsSection } from './ModuleSettingsSection.tsrx';
import { activationRefusal, createModulesClientState } from './state.ts';

const TABS_ID = 'system-modules';

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
	const [tab, setTab] = useValue(client.state.tab);
	const [pending, setPending] = useValue(client.state.pending);
	const [busyModuleId, setBusyModuleId] = useValue(client.state.busyModuleId);
	const [activationError, setActivationError] = useValue(
		client.state.activationError,
	);
	const selected =
		modules.find((module) => module.id === selectedModuleId) ?? null;
	const term = query.trim().toLocaleLowerCase(activeLocale());
	const visible =
		term === ''
			? modules
			: modules.filter(
					(module) =>
						module.id.includes(term) ||
							module.name.toLocaleLowerCase(activeLocale()).includes(term),
				);
	const enabled = modules.filter((module) => module.enabled);
	const active = enabled.filter((module) => module.active);
	const pendingModule =
		modules.find((module) => module.id === pending?.moduleId) ?? null;

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
					: t('system.error.catalog'),
			);
			setStatus(denied ? 'denied' : 'error');
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	/* The server is the authority on dependencies: a refusal it answers is
   shown with the modules it named, and the catalog is read again so the
   table never shows a state the workspace no longer has. */
	const confirmActivation = async () => {
		if (!pending) return;
		setBusyModuleId(pending.moduleId);
		setActivationError('');
		try {
			await setModuleActivation(
				pending.moduleId,
				pending.active,
				props.csrfToken,
			);
			setPending(null);
			await refresh();
		} catch (changeError) {
			setPending(null);
			setActivationError(
				changeError instanceof Error
					? changeError.message
					: t('system.error.activation'),
			);
		} finally {
			setBusyModuleId(null);
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('system.page.eyebrow')}
			title={t('system.page.title')}
			description={t('system.page.description')}
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				{t('system.action.refresh')}
			</Button>
		</PageHeader>
		<Tabs
			id={TABS_ID}
			items={[
				{ id: 'catalog', label: t('system.tab.catalog') },
				{ id: 'flags', label: t('system.tab.flags') },
			]}
			active={tab}
			label={t('system.tab.label')}
			onChange={(next) => setTab(next === 'flags' ? 'flags' : 'catalog')}
		/>
		<div
			id={TABS_ID + '-panel-' + tab}
			role="tabpanel"
			aria-labelledby={TABS_ID + '-tab-' + tab}
		>
			@if (tab === 'flags') {
				<FlagsPanel
					csrfToken={props.csrfToken}
					canManage={props.canManageSettings}
				/>
			} @else if (status === 'denied') {
				<section class="ui-card">
					<EmptyState icon="shield" title={t('system.denied.title')}>{t(
						'system.denied.hint',
					)}</EmptyState>
				</section>
			} @else {
				<>
					@if (status === 'error') {
						<Alert>{error}</Alert>
					}
					@if (activationError !== '') {
						<Alert>{activationError}</Alert>
					}
					<TableCard
						title={t('system.table.title')}
						count={t('system.table.count', {
							active: active.length,
							enabled: enabled.length,
							total: modules.length,
						})}
						search={<SearchField
							value={query}
							placeholder={t('system.search.placeholder')}
							label={t('system.search.label')}
							onInput={setQuery}
						/>}
						caption={t('system.table.caption')}
						columns={moduleColumns()}
						rows={visible}
						rowKey={(module) => module.id}
						status={status === 'loading' && modules.length === 0
							? 'loading'
							: 'idle'}
						loadingLabel={t('system.table.loading')}
						filtered={term !== ''}
						empty={{
							icon: 'modules',
							title: t('system.table.emptyTitle'),
							hint: t('system.table.emptyHint'),
						}}
						emptyFiltered={{
							icon: 'modules',
							title: t('system.table.emptyFilteredTitle'),
							hint: t('system.table.emptyFilteredHint'),
						}}
						onSelect={(module) => setSelectedModuleId(module.id)}
						actionsLabel={t('system.table.actions')}
						actions={(module) => [
							{
								id: 'open',
								label: t('system.action.open'),
								icon: 'external',
								onSelect: () => setSelectedModuleId(module.id),
							},
							{
								id: 'activation',
								label: module.enabled && module.active
									? t('system.action.deactivate')
									: t('system.action.activate'),
								icon: module.enabled && module.active ? 'x' : 'play',
								tone: module.enabled && module.active ? 'danger' : 'default',
								disabled: busyModuleId !== null ||
									activationRefusal(module, props.canManageSettings, t) !==
										null,
								reason: activationRefusal(module, props.canManageSettings, t) ??
									undefined,
								onSelect: () => setPending({
									moduleId: module.id,
									active: !module.active,
								}),
							},
						]}
						noteIcon="code"
						note={<>
							{t('system.table.cliNote')}
							{' '}
							<code class="ui-mono">{commands.enable ?? ''}</code>
							{' · '}
							<code class="ui-mono">{commands.disable ?? ''}</code>
							{' · '}
							<code class="ui-mono">{commands.grantScopes ?? ''}</code>
						</>}
					/>
				</>
			}
		</div>
		<ConfirmDialog
			open={pending !== null}
			title={pending?.active
				? t('system.activation.confirmActivateTitle', {
						module: pendingModule?.name ?? pending.moduleId,
					})
				: t('system.activation.confirmDeactivateTitle', {
						module: pendingModule?.name ?? pending?.moduleId ?? '',
					})}
			confirmLabel={pending?.active
				? t('system.action.activate')
				: t('system.action.deactivate')}
			cancelLabel={t('system.action.cancel')}
			tone={pending?.active ? 'primary' : 'danger'}
			busy={busyModuleId !== null}
			onConfirm={() => void confirmActivation()}
			onCancel={() => setPending(null)}
		>
			{pending?.active
				? t('system.activation.confirmActivate')
				: t('system.activation.confirmDeactivate')}
		</ConfirmDialog>
		<Drawer
			open={tab === 'catalog' && selected !== null}
			title={selected?.name ?? t('system.drawer.module')}
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
					<b>{t('system.detail.overview')}</b>
					@if (props.module.description) {
						<small>{props.module.description}</small>
					}
				</div>
				<div class="ui-form__row ui-form__row--4">
					<span class="ui-cell">
						<small>{t('system.table.version')}</small>
						<b class="ui-mono">
							{props.module.version || t('system.value.na')}
						</b>
					</span>
					<span class="ui-cell">
						<small>{t('system.detail.specVersion')}</small>
						<b class="ui-mono">
							{props.module.specVersion ?? t('system.value.none')}
						</b>
					</span>
					<span class="ui-cell">
						<small>{t('system.table.platform')}</small>
						<b>{surfaces(props.module)}</b>
					</span>
					<span class="ui-cell">
						<small>{t('system.table.status')}</small>
						<Tag tone={activationTone(props.module)} dot>{activationLabel(
							props.module,
						)}</Tag>
					</span>
				</div>
				<span class="ui-cell">
					<small>{t('system.detail.capabilities')}</small>
					<span class="ui-mono">
						{props.module.capabilities.join(', ') || t('system.value.none')}
					</span>
				</span>
				<span class="ui-cell">
					<small>{t('system.detail.directory')}</small>
					<span class="ui-mono">{props.module.directory}</span>
				</span>
				<span class="ui-cell">
					<small>{t('system.table.dependents')}</small>
					<span class="ui-mono">
						{props.module.dependents.join(', ') || t('system.value.none')}
					</span>
				</span>
			</div>
			<div class="ui-form__section">
				<div class="ui-form__section-head">
					<b>{t('system.detail.permissions')}</b>
					<small>{t('system.detail.permissionCount', {
						count: props.module.permissions.length,
					})}</small>
				</div>
				@if (props.module.permissions.length === 0) {
					<span class="ui-help">{t('system.detail.noPermissions')}</span>
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
