import { useEffect, useMemo, useState } from 'octane';
import {
	Alert,
	Button,
	ConfirmDialog,
	Drawer,
	EmptyState,
	Filters,
	Icon,
	PageHeader,
	Pagination,
	SearchField,
	Select,
	TableCard,
	Tag,
	ToastHost,
	toasts,
	type TableAction,
	type TableColumn,
} from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client';
import { useValue } from 'segment-state';
import {
	CONNECTOR_INSTANCE_STATUSES,
	type ConnectorInstance,
	type ConnectorInstanceStatus,
} from '../domain/types.ts';
import {
	ConnectorsApiError,
	connectorsErrorMessage,
	createConnectorInstance,
	deleteConnectorInstance,
	disableConnectorInstance,
	enableConnectorInstance,
	loadConnectorDefinitions,
	loadConnectorInstances,
	runConnectorTestCall,
	setConnectorConsent,
	updateConnectorInstance,
	type ConnectorFormValue,
} from './api.ts';
import {
	consentChange,
	consentGranted,
	connectorFormState,
	type ConnectorCallerKind,
} from './consent.ts';
import { ConnectorForm } from './ConnectorForm.tsrx';
import {
	consentLabel,
	instanceStatusLabel,
	instanceStatusTone,
	timestampLabel,
} from './presentation.ts';
import { createConnectorsClientState } from './state.ts';

export interface ConnectorsViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

const PAGE_SIZES = [10, 25, 50, 100];

function columns(): readonly TableColumn<ConnectorInstance>[] {
	return [
		{
			key: 'name',
			header: t('connectors.column.name'),
			width: '18%',
			value: (instance) => instance.name,
			cell: (instance) => <b>{instance.name}</b>,
		},
		{
			key: 'definition',
			header: t('connectors.column.definition'),
			width: '12%',
			value: (instance) => instance.definitionKey,
			cell: (instance) => <span class="ui-mono">{instance.definitionKey}</span>,
		},
		{
			key: 'baseUrl',
			header: t('connectors.column.baseUrl'),
			width: '20%',
			value: (instance) => instance.baseUrl,
			cell: (instance) => <span class="ui-mono">{instance.baseUrl}</span>,
		},
		{
			key: 'authKind',
			header: t('connectors.column.authKind'),
			width: '12%',
			value: (instance) => instance.authKind,
			cell: (instance) =>
				<span>{t('connectors.authKind.' + instance.authKind)}</span>,
		},
		{
			key: 'status',
			header: t('connectors.column.status'),
			width: '10%',
			value: (instance) => instance.status,
			cell: (instance) =>
				<Tag
					tone={instanceStatusTone(instance.status)}
					dot
				>{instanceStatusLabel(instance.status)}</Tag>,
		},
		{
			key: 'allowWorkflows',
			header: t('connectors.column.allowWorkflows'),
			width: '9%',
			value: (instance) => (instance.allowWorkflows ? 1 : 0),
			cell: (instance) =>
				<Tag tone={instance.allowWorkflows ? 'info' : 'neutral'}>{consentLabel(
					instance.allowWorkflows,
				)}</Tag>,
		},
		{
			key: 'allowAgents',
			header: t('connectors.column.allowAgents'),
			width: '9%',
			value: (instance) => (instance.allowAgents ? 1 : 0),
			cell: (instance) =>
				<Tag tone={instance.allowAgents ? 'info' : 'neutral'}>{consentLabel(
					instance.allowAgents,
				)}</Tag>,
		},
		{
			key: 'lastCallAt',
			header: t('connectors.column.lastCall'),
			width: '10%',
			value: (instance) => instance.lastCallAt ?? 0,
			cell: (instance) => timestampLabel(instance.lastCallAt),
		},
	];
}

export function ConnectorsView(props: ConnectorsViewProps) @{
	const client = useMemo(() => createConnectorsClientState(), []);
	const [instances] = useValue(client.state.instances);
	const [definitions] = useValue(client.state.definitions);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [statusFilter, setStatusFilter] = useValue(client.state.statusFilter);
	const [definitionFilter, setDefinitionFilter] = useValue(
		client.state.definitionFilter,
	);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [editorOpen, setEditorOpen] = useValue(client.state.editorOpen);
	const [selectedId, setSelectedId] = useValue(client.state.selectedId);
	const [formSession, setFormSession] = useValue(client.state.formSession);
	const [test, setTest] = useValue(client.state.test);
	const [confirm, setConfirm] = useValue(client.state.confirm);
	const [pageIndex, setPageIndex] = useState(0);
	const [pageSize, setPageSize] = useState(25);
	const selected =
		instances.find((instance) => instance.id === selectedId) ?? null;
	const formState = connectorFormState({
		status,
		selectedId,
		instance: selected,
	});
	const locale = activeLocale();
	const term = query.trim().toLocaleLowerCase(locale);
	const visible = instances.filter(
		(instance) =>
			(statusFilter === '' || instance.status === statusFilter) &&
				(definitionFilter === '' ||
					instance.definitionKey === definitionFilter) &&
				(term === '' ||
					instance.name.toLocaleLowerCase(locale).includes(term) ||
					instance.baseUrl.toLocaleLowerCase(locale).includes(term)),
	);
	const filtered =
		term !== '' || statusFilter !== '' || definitionFilter !== '';

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const [loaded, kinds] = await Promise.all([
				loadConnectorInstances(),
				loadConnectorDefinitions(),
			]);
			client.store.act((transaction) => {
				transaction.set(client.state.instances, loaded);
				transaction.set(client.state.definitions, kinds);
				transaction.set(client.state.status, 'idle');
			}, 'connectors/loaded');
		} catch (loadError) {
			setError(connectorsErrorMessage(loadError, 'connectors.error.load'));
			setStatus(
				loadError instanceof ConnectorsApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const openInstance = (id: string) => {
		client.store.act((transaction) => {
			transaction.set(client.state.selectedId, id);
			transaction.set(client.state.formSession, formSession + 1);
			transaction.set(client.state.test, null);
			transaction.set(client.state.error, '');
			transaction.set(client.state.editorOpen, true);
		}, 'connectors/open');
	};

	const closeEditor = () => {
		client.store.act((transaction) => {
			transaction.set(client.state.editorOpen, false);
			transaction.set(client.state.test, null);
			transaction.set(client.state.confirm, null);
			transaction.set(client.state.error, '');
		}, 'connectors/close');
	};

	const submit = async (value: ConnectorFormValue) => {
		setStatus('submitting');
		setError('');
		try {
			if (selected) {
				await updateConnectorInstance(selected.id, value, props.csrfToken);
				await refresh();
				setEditorOpen(false);
				toasts.success(t('connectors.notice.saved'));
			} else {
				const created = await createConnectorInstance(value, props.csrfToken);
				await refresh();
				client.store.act((transaction) => {
					transaction.set(client.state.selectedId, created.id);
					transaction.set(client.state.formSession, formSession + 1);
				}, 'connectors/created');
				toasts.success(t('connectors.notice.created'));
			}
			setStatus('idle');
		} catch (submitError) {
			setError(connectorsErrorMessage(submitError, 'connectors.error.save'));
			setStatus('idle');
		}
	};

	/* A failure is reported where the reader started the action: beside the
   controls in the drawer, or under the header when the row raised it. */
	const act = async (
		run: () => Promise<unknown>,
		done: string,
		reportTo: 'drawer' | 'screen',
	) => {
		setStatus('submitting');
		setError('');
		try {
			await run();
			await refresh();
			setStatus('idle');
			toasts.success(done);
		} catch (actionError) {
			const message = connectorsErrorMessage(
				actionError,
				'connectors.error.action',
			);
			if (reportTo === 'drawer') setError(message);
			else {
				client.store.act((transaction) => {
					transaction.set(client.state.error, message);
					transaction.set(client.state.editorOpen, false);
				}, 'connectors/action-failed');
			}
			setStatus('idle');
		}
	};

	const runTestCall = async (operation: string, path: string) => {
		if (!selected) return;
		setStatus('submitting');
		setError('');
		try {
			const report = await runConnectorTestCall(
				selected.id,
				operation,
				{ path },
				props.csrfToken,
			);
			await refresh();
			client.store.act((transaction) => {
				transaction.set(client.state.test, report);
				transaction.set(client.state.status, 'idle');
			}, 'connectors/tested');
		} catch (testError) {
			setError(connectorsErrorMessage(testError, 'connectors.error.action'));
			setStatus('idle');
		}
	};

	/* Consent is granted per instance and per caller kind, so a change moves the
   kind the owner confirmed and sends the other exactly as it stands. */
	const changeConsent = async (kind: ConnectorCallerKind) => {
		if (!selected) return;
		setConfirm(null);
		await act(
			() => setConnectorConsent(
				selected.id,
				consentChange(selected, kind, !consentGranted(selected, kind)),
				props.csrfToken,
			),
			t('connectors.notice.consent'),
			'drawer',
		);
	};

	const disable = async () => {
		if (!selected) return;
		setConfirm(null);
		await act(
			() => disableConnectorInstance(selected.id, props.csrfToken),
			t('connectors.notice.disabled'),
			'drawer',
		);
	};

	const remove = async () => {
		if (!selected) return;
		const id = selected.id;
		setConfirm(null);
		closeEditor();
		await act(
			() => deleteConnectorInstance(id, props.csrfToken),
			t('connectors.notice.deleted'),
			'screen',
		);
		setSelectedId('');
	};

	const rowActions = (instance: ConnectorInstance): readonly TableAction[] => [
		{
			id: 'open',
			label: t('connectors.action.open'),
			icon: 'braces',
			onSelect: () => openInstance(instance.id),
		},
		...(props.canManage
			? [
					instance.status === 'active'
						? {
								id: 'disable',
								label: t('connectors.action.disable'),
								icon: 'x',
								onSelect: () => void act(
									() => disableConnectorInstance(instance.id, props.csrfToken),
									t('connectors.notice.disabled'),
									'screen',
								),
							}
						: {
								id: 'enable',
								label: t('connectors.action.enable'),
								icon: 'play',
								onSelect: () => void act(
									() => enableConnectorInstance(instance.id, props.csrfToken),
									t('connectors.notice.enabled'),
									'screen',
								),
							},
				]
			: []),
	];

	<div class="ui-view">
		<PageHeader
			eyebrow={t('connectors.common.administration')}
			title={t('connectors.instances.title')}
			description={t('connectors.instances.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => void refresh()}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('connectors.common.refreshing')
					: t('connectors.common.refresh')}
			</Button>
			@if (props.canManage) {
				<Button
					size="sm"
					variant="primary"
					disabled={status === 'denied'}
					onClick={() => {
						client.store.act((transaction) => {
							transaction.set(client.state.selectedId, '');
							transaction.set(client.state.formSession, formSession + 1);
							transaction.set(client.state.test, null);
							transaction.set(client.state.error, '');
							transaction.set(client.state.editorOpen, true);
						}, 'connectors/new');
					}}
				>
					<Icon name="plus" size={14} />
					{t('connectors.action.new')}
				</Button>
			}
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState
					icon="shield"
					title={t('connectors.common.accessDenied')}
				>{t('connectors.instances.denied')}</EmptyState>
			</section>
		} @else {
			<>
				@if (error && !editorOpen) {
					<Alert>{error}</Alert>
				}
				@if (status === 'error') {
					<section class="ui-card">
						<EmptyState
							icon="alert"
							title={t('connectors.instances.errorTitle')}
						>{t('connectors.instances.errorHint')}</EmptyState>
					</section>
				} @else {
					<TableCard
						title={t('connectors.instances.tableTitle')}
						count={t('connectors.instances.count', { count: visible.length })}
						search={<SearchField
							value={query}
							placeholder={t('connectors.search.placeholder')}
							label={t('connectors.search.label')}
							onInput={(value) => {
								setQuery(value);
								setPageIndex(0);
							}}
						/>}
						filters={<Filters
							open={filtersOpen}
							onToggle={() => setFiltersOpen(!filtersOpen)}
							activeCount={(statusFilter === '' ? 0 : 1) +
								(definitionFilter === '' ? 0 : 1)}
							label={t('connectors.common.filters')}
						>
							<Select
								id="connectors-filter-status"
								label={t('connectors.filter.status')}
								value={statusFilter}
								options={[
									{ value: '', label: t('connectors.filter.allStatuses') },
									...CONNECTOR_INSTANCE_STATUSES.map(
										(entry) => ({
											value: entry,
											label: instanceStatusLabel(entry),
										}),
									),
								]}
								onChange={(value) => {
									setStatusFilter(value as ConnectorInstanceStatus | '');
									setPageIndex(0);
								}}
							/>
							<Select
								id="connectors-filter-definition"
								label={t('connectors.filter.definition')}
								value={definitionFilter}
								options={[
									{ value: '', label: t('connectors.filter.allDefinitions') },
									...definitions.map(
										(entry) => ({
											value: entry.key,
											label: entry.label,
										}),
									),
								]}
								onChange={(value) => {
									setDefinitionFilter(value);
									setPageIndex(0);
								}}
							/>
						</Filters>}
						caption={t('connectors.instances.caption')}
						columns={columns()}
						rows={visible}
						rowKey={(instance) => instance.id}
						sorting
						onSortingChange={() => setPageIndex(0)}
						pagination={{ pageIndex, pageSize, onPageChange: setPageIndex }}
						after={<Pagination
							pageIndex={pageIndex}
							pageSize={pageSize}
							totalRows={visible.length}
							pageSizes={PAGE_SIZES}
							onPageChange={setPageIndex}
							onPageSizeChange={(size) => {
								setPageSize(size);
								setPageIndex(0);
							}}
							label={t('connectors.pagination.label')}
							previousLabel={t('connectors.pagination.previous')}
							nextLabel={t('connectors.pagination.next')}
							pageSizeLabel={t('connectors.pagination.size')}
							summary={(range) => t('connectors.pagination.summary', {
								page: range.pageIndex + 1,
								pages: range.pageCount,
								from: range.from,
								to: range.to,
								total: range.totalRows,
							})}
						/>}
						status={status === 'loading' && instances.length === 0
							? 'loading'
							: 'idle'}
						loadingLabel={t('connectors.instances.loading')}
						filtered={filtered}
						empty={{
							icon: 'plug',
							title: t('connectors.instances.emptyTitle'),
							hint: t('connectors.instances.emptyHint'),
						}}
						emptyFiltered={{
							icon: 'search',
							title: t('connectors.instances.emptyFilteredTitle'),
							hint: t('connectors.instances.emptyFilteredHint'),
						}}
						onSelect={(instance) => openInstance(instance.id)}
						selectedKey={selected?.id}
						actions={rowActions}
						actionsLabel={t('connectors.common.actions')}
						actionsWidth="240px"
						noteIcon="shield"
						note={t('connectors.instances.note')}
					/>
				}
			</>
		}
		<Drawer
			open={editorOpen}
			title={selected?.name ?? t('connectors.drawer.newTitle')}
			subtitle={selected
				? t('connectors.drawer.subtitle')
				: t('connectors.drawer.newSubtitle')}
			width="lg"
			onClose={closeEditor}
		>
			<ConnectorForm
				key={'connector-form-' + formSession}
				instance={selected}
				definitions={definitions}
				canManage={props.canManage}
				busy={status === 'submitting'}
				error={editorOpen ? error : ''}
				test={test}
				onCancel={closeEditor}
				onEnable={() => {
					if (selected) {
						void act(
							() => enableConnectorInstance(selected.id, props.csrfToken),
							t('connectors.notice.enabled'),
							'drawer',
						);
					}
				}}
				onDisable={() => setConfirm('disable')}
				onDelete={() => setConfirm('delete')}
				state={formState}
				onConsent={(kind) => setConfirm(
					kind === 'workflows' ? 'consent-workflows' : 'consent-agents',
				)}
				onTestCall={(operation, path) => void runTestCall(operation, path)}
				onSubmit={(value) => void submit(value)}
			/>
		</Drawer>
		<ConfirmDialog
			open={confirm === 'consent-workflows'}
			title={t('connectors.consent.workflowsTitle')}
			confirmLabel={t('connectors.action.consent')}
			tone="primary"
			busy={status === 'submitting'}
			onConfirm={() => void changeConsent('workflows')}
			onCancel={() => setConfirm(null)}
		>{t('connectors.consent.description', {
			name: selected?.name ?? '',
			caller: t('connectors.consent.workflows'),
			value: selected && selected.allowWorkflows
				? t('connectors.consent.off')
				: t('connectors.consent.on'),
		})}</ConfirmDialog>
		<ConfirmDialog
			open={confirm === 'consent-agents'}
			title={t('connectors.consent.agentsTitle')}
			confirmLabel={t('connectors.action.consent')}
			tone="primary"
			busy={status === 'submitting'}
			onConfirm={() => void changeConsent('agents')}
			onCancel={() => setConfirm(null)}
		>{t('connectors.consent.description', {
			name: selected?.name ?? '',
			caller: t('connectors.consent.agents'),
			value: selected && selected.allowAgents
				? t('connectors.consent.off')
				: t('connectors.consent.on'),
		})}</ConfirmDialog>
		<ConfirmDialog
			open={confirm === 'disable'}
			title={t('connectors.disable.title')}
			confirmLabel={t('connectors.action.disable')}
			tone="primary"
			busy={status === 'submitting'}
			onConfirm={() => void disable()}
			onCancel={() => setConfirm(null)}
		>{t('connectors.disable.description', {
			name: selected?.name ?? '',
		})}</ConfirmDialog>
		<ConfirmDialog
			open={confirm === 'delete'}
			title={t('connectors.delete.title')}
			confirmLabel={t('connectors.action.delete')}
			busy={status === 'submitting'}
			onConfirm={() => void remove()}
			onCancel={() => setConfirm(null)}
		>{t('connectors.delete.description', {
			name: selected?.name ?? '',
		})}</ConfirmDialog>
		<ToastHost
			label={t('connectors.common.messages')}
			closeLabel={t('connectors.common.close')}
		/>
	</div>
}
