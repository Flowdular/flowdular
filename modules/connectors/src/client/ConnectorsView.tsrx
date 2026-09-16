import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	CellMuted,
	CellTag,
	CellText,
	CellTime,
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
	ToastHost,
	toasts,
	type TableAction,
	type TableColumn,
	type TableSort,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
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
} from './presentation.ts';
import {
	beginLoad,
	createConnectorsClientState,
	FIRST_PAGE,
	isLatestLoad,
	pageCursor,
	searchPending,
	sortRequest,
	walkTo,
	type PageWalk,
} from './state.ts';

export interface ConnectorsViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

const PAGE_SIZES = [10, 25, 50, 100];
const NAME_ORDER: TableSort = { key: 'name', desc: false };
const SEARCH_DEBOUNCE_MS = 300;

/* What one listing asks the server for. It is read from the store when the
   load starts, never from the render that scheduled it, so a debounce that
   fires after a filter change asks for the filter the controls show. */
interface InstanceListing {
	readonly status: ConnectorInstanceStatus | '';
	readonly definition: string;
	readonly q: string;
	readonly sorting: readonly TableSort[];
	readonly pageSize: number;
}

/* The connector and its status stay on screen; the definition, the consents
   and the last call hide next, the address and the authentication first. */
function columns(): readonly TableColumn<ConnectorInstance>[] {
	return [
		{
			key: 'name',
			header: t('connectors.column.name'),
			width: 'auto',
			value: (instance) => instance.name,
			cell: (instance) => <CellText value={instance.name} strong />,
		},
		{
			key: 'definition',
			header: t('connectors.column.definition'),
			width: '160px',
			priority: 2,
			cell: (instance) => <CellText value={instance.definitionKey} mono />,
		},
		{
			key: 'baseUrl',
			header: t('connectors.column.baseUrl'),
			width: '220px',
			priority: 3,
			cell: (instance) => <CellText value={instance.baseUrl} mono />,
		},
		{
			key: 'authKind',
			header: t('connectors.column.authKind'),
			width: '140px',
			priority: 3,
			cell: (instance) =>
				<CellText value={t('connectors.authKind.' + instance.authKind)} />,
		},
		{
			key: 'status',
			header: t('connectors.column.status'),
			width: '120px',
			cell: (instance) =>
				<CellTag
					tone={instanceStatusTone(instance.status)}
					dot
					label={instanceStatusLabel(instance.status)}
				/>,
		},
		{
			key: 'allowWorkflows',
			header: t('connectors.column.allowWorkflows'),
			width: '120px',
			priority: 2,
			cell: (instance) =>
				<CellTag
					tone={instance.allowWorkflows ? 'info' : 'neutral'}
					label={consentLabel(instance.allowWorkflows)}
				/>,
		},
		{
			key: 'allowAgents',
			header: t('connectors.column.allowAgents'),
			width: '120px',
			priority: 2,
			cell: (instance) =>
				<CellTag
					tone={instance.allowAgents ? 'info' : 'neutral'}
					label={consentLabel(instance.allowAgents)}
				/>,
		},
		{
			key: 'lastCallAt',
			header: t('connectors.column.lastCall'),
			width: '170px',
			priority: 2,
			cell: (instance) => instance.lastCallAt === null ||
			instance.lastCallAt === 0
				? <CellMuted>{t('connectors.common.never')}</CellMuted>
				: <CellTime value={instance.lastCallAt} />,
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
	const [appliedQuery] = useValue(client.state.appliedQuery);
	const [statusFilter, setStatusFilter] = useValue(client.state.statusFilter);
	const [definitionFilter, setDefinitionFilter] = useValue(
		client.state.definitionFilter,
	);
	const [sorting, setSorting] = useValue(client.state.sorting);
	const [pageSize, setPageSize] = useValue(client.state.pageSize);
	const [walk] = useValue(client.state.walk);
	const [nextCursor] = useValue(client.state.nextCursor);
	const [pinned, setPinned] = useValue(client.state.pinned);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [editorOpen, setEditorOpen] = useValue(client.state.editorOpen);
	const [selectedId, setSelectedId] = useValue(client.state.selectedId);
	const [formSession, setFormSession] = useValue(client.state.formSession);
	const [test, setTest] = useValue(client.state.test);
	const [confirm, setConfirm] = useValue(client.state.confirm);
	/* The row on screen wins; the record an action just returned stands in for
   an instance the page on screen does not hold. */
	const selected =
		instances.find((instance) => instance.id === selectedId) ??
			(pinned !== null && pinned.id === selectedId ? pinned : null);
	const formState = connectorFormState({
		status,
		selectedId,
		instance: selected,
	});
	const filtered =
		appliedQuery !== '' || statusFilter !== '' || definitionFilter !== '';
	const listing = (): InstanceListing => ({
		status: client.store.get(client.state.statusFilter),
		definition: client.store.get(client.state.definitionFilter),
		q: client.store.get(client.state.appliedQuery),
		sorting: client.store.get(client.state.sorting),
		pageSize: client.store.get(client.state.pageSize),
	});

	const load = async (
		target: PageWalk,
		request: InstanceListing = listing(),
	) => {
		const ticket = beginLoad(client.store, client.state.loads);
		setStatus('loading');
		setError('');
		try {
			const [page, kinds] = await Promise.all([
				loadConnectorInstances({
					status: request.status,
					definition: request.definition,
					q: request.q,
					...sortRequest(request.sorting, NAME_ORDER),
					cursor: pageCursor(target),
					limit: request.pageSize,
				}),
				loadConnectorDefinitions(),
			]);
			if (!isLatestLoad(client.store, client.state.loads, ticket)) return;
			client.store.act((transaction) => {
				transaction.set(client.state.instances, page.items);
				transaction.set(client.state.definitions, kinds);
				transaction.set(client.state.nextCursor, page.page.nextCursor);
				transaction.set(client.state.walk, target);
				transaction.set(client.state.appliedQuery, request.q);
				transaction.set(client.state.status, 'idle');
			}, 'connectors/loaded');
		} catch (loadError) {
			if (!isLatestLoad(client.store, client.state.loads, ticket)) return;
			setError(connectorsErrorMessage(loadError, 'connectors.error.load'));
			setStatus(
				loadError instanceof ConnectorsApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	const refresh = () => load(client.store.get(client.state.walk));
	/* A changed filter, sort or page size is a new listing from its first page. */
	const restart = (change: Partial<InstanceListing>) => load(FIRST_PAGE, {
		...listing(),
		...change,
	});
	const turnTo = (index: number) => {
		const current = client.store.get(client.state.walk);
		const next = walkTo(
			current,
			index,
			client.store.get(client.state.nextCursor),
		);
		if (next !== current) void load(next);
	};

	useEffect(() => {
		void refresh();
	}, []);

	/* The term is the server's filter, so typing it starts a new listing. One
   listing per pause in the typing, none while the rows already answer it. */
	useEffect(() => {
		if (!searchPending(query, appliedQuery)) return;
		const timer = setTimeout(
			() => void restart({ q: client.store.get(client.state.query).trim() }),
			SEARCH_DEBOUNCE_MS,
		);
		return () => clearTimeout(timer);
	}, [query]);

	const openInstance = (id: string) => {
		client.store.act((transaction) => {
			transaction.set(client.state.selectedId, id);
			transaction.set(client.state.pinned, null);
			transaction.set(client.state.formSession, formSession + 1);
			transaction.set(client.state.test, null);
			transaction.set(client.state.error, '');
			transaction.set(client.state.editorOpen, true);
		}, 'connectors/open');
	};

	const closeEditor = () => {
		client.store.act((transaction) => {
			transaction.set(client.state.editorOpen, false);
			transaction.set(client.state.pinned, null);
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
				setPinned(
					await updateConnectorInstance(selected.id, value, props.csrfToken),
				);
				await refresh();
				setEditorOpen(false);
				toasts.success(t('connectors.notice.saved'));
			} else {
				const created = await createConnectorInstance(value, props.csrfToken);
				await refresh();
				client.store.act((transaction) => {
					transaction.set(client.state.selectedId, created.id);
					transaction.set(client.state.pinned, created);
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
		run: () => Promise<ConnectorInstance | void>,
		done: string,
		reportTo: 'drawer' | 'screen',
	) => {
		setStatus('submitting');
		setError('');
		try {
			const changed = await run();
			if (changed) setPinned(changed);
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
							transaction.set(client.state.pinned, null);
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
						count={t('connectors.instances.count', {
							count: instances.length,
						})}
						search={<SearchField
							value={query}
							placeholder={t('connectors.search.placeholder')}
							label={t('connectors.search.label')}
							onInput={setQuery}
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
									const next = value as ConnectorInstanceStatus | '';
									setStatusFilter(next);
									void restart({ status: next });
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
									void restart({ definition: value });
								}}
							/>
						</Filters>}
						caption={t('connectors.instances.caption')}
						columns={columns()}
						rows={instances}
						rowKey={(instance) => instance.id}
						mode="server"
						sorting
						sortingState={sorting}
						onSortingChange={(sorts) => {
							const next =
								sorts.length === 0 ? [NAME_ORDER] : sorts;
							setSorting(next);
							void restart({ sorting: next });
						}}
						pagination={{
							pageIndex: walk.pageIndex,
							pageSize,
							onPageChange: turnTo,
							hasMore: nextCursor !== null,
						}}
						after={<Pagination
							pageIndex={walk.pageIndex}
							pageSize={pageSize}
							hasMore={nextCursor !== null}
							pageSizes={PAGE_SIZES}
							onPageChange={turnTo}
							onPageSizeChange={(size) => {
								setPageSize(size);
								void restart({ pageSize: size });
							}}
							label={t('connectors.pagination.label')}
							previousLabel={t('connectors.pagination.previous')}
							nextLabel={t('connectors.pagination.next')}
							pageSizeLabel={t('connectors.pagination.size')}
							summary={(page) => t('connectors.pagination.page', {
								page: page.pageIndex + 1,
								from: page.from,
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
