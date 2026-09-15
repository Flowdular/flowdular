import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	ConfirmDialog,
	Drawer,
	EmptyState,
	Filters,
	Icon,
	Kpi,
	PageHeader,
	Pagination,
	SearchField,
	Select,
	TableCard,
	Tag,
	ToastHost,
	toasts,
	type TableColumn,
	type TableSort,
} from '@flowdular/sdk/ui';
import { activeLocale, t } from '@flowdular/sdk/client';
import { useValue } from 'segment-state';
import type {
	CatalogBulkOutcome,
	CatalogItem,
	CatalogItemKind,
} from '../domain/types.ts';
import { CATALOG_ITEMS_EXPORT_LIST_ID } from '../domain/lists.ts';
import {
	ApiError,
	archiveCatalogItem,
	archiveCatalogItems,
	createCatalogItem,
	deleteCatalogItem,
	loadCatalogItemHistory,
	loadCatalogItems,
	restoreCatalogItem,
	restoreCatalogItems,
	startListExport,
	updateCatalogItem,
} from './api.ts';
import {
	bulkOutcomeCounts,
	bulkTargets,
	catalogSort,
	createCatalogClientState,
	DEFAULT_CATALOG_SORTING,
	DEFAULT_STATUS_FILTER,
	loadedListing,
	pageCursor,
	replaceItem,
	resetPageCursors,
	searchPending,
	type CatalogKindFilter,
	type CatalogStatusFilter,
	type Listing,
} from './state.ts';
import { CatalogItemForm } from './CatalogItemForm.tsrx';
import { CatalogHistoryDrawer } from './CatalogHistoryDrawer.tsrx';

export interface CatalogViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
	/** Whether the principal may start an export job; exports.core owns it. */
	readonly canExport: boolean;
}

const PAGE_SIZES = [25, 50, 100, 200];
const SEARCH_DEBOUNCE_MS = 300;
/** The widget reads one page at the ceiling and says "more" past it. */
const WIDGET_PAGE = 200;

function formValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value : '';
}

function message(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

function price(minor: number, currency: string): string {
	try {
		return new Intl.NumberFormat(activeLocale(), {
			style: 'currency',
			currency,
		}).format(minor / 100);
	} catch {
		return t('catalog.price.fallback', { amount: minor, currency });
	}
}

function updatedAt(value: number): string {
	return new Intl.DateTimeFormat(activeLocale(), {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date(value));
}

function columns(): readonly TableColumn<CatalogItem>[] {
	return [
		{
			key: 'name',
			header: t('catalog.table.column.name'),
			width: '28%',
			value: (item) => item.name,
			cell: (item) => <span class="ui-cell">
				<b>{item.name}</b>
				<small>{item.unit}</small>
			</span>,
		},
		{
			key: 'sku',
			header: t('catalog.table.column.sku'),
			width: '16%',
			value: (item) => item.sku,
			cell: (item) => <span class="ui-mono">{item.sku}</span>,
		},
		{
			key: 'kind',
			header: t('catalog.table.column.kind'),
			width: '12%',
			cell: (item) =>
				<Tag tone={item.kind === 'product' ? 'info' : 'neutral'}>{t(
					'catalog.kind.' + item.kind,
				)}</Tag>,
		},
		{
			key: 'price',
			header: t('catalog.table.column.price'),
			width: '14%',
			numeric: true,
			cell: (item) => price(item.basePriceMinor, item.currency),
		},
		{
			key: 'updatedAt',
			header: t('catalog.table.column.updated'),
			width: '18%',
			value: (item) => item.updatedAt,
			cell: (item) => updatedAt(item.updatedAt),
		},
		{
			key: 'status',
			header: t('catalog.table.column.status'),
			width: '12%',
			cell: (item) =>
				<Tag tone={item.status === 'active' ? 'success' : 'neutral'} dot>{t(
					'catalog.status.' + item.status,
				)}</Tag>,
		},
	];
}

export function CatalogView(props: CatalogViewProps) @{
	const catalogState = useMemo(() => createCatalogClientState(), []);
	/* Answers arrive in any order; only the latest request may write the page. */
	const requests = useMemo(() => ({ sequence: 0 }), []);
	const [items] = useValue(catalogState.state.items);
	const [status, setStatus] = useValue(catalogState.state.status);
	const [error, setError] = useValue(catalogState.state.error);
	const [query, setQuery] = useValue(catalogState.state.query);
	const [appliedQuery] = useValue(catalogState.state.appliedQuery);
	const [kindFilter, setKindFilter] = useValue(catalogState.state.kindFilter);
	const [statusFilter, setStatusFilter] = useValue(
		catalogState.state.statusFilter,
	);
	const [sorting, setSorting] = useValue(catalogState.state.sorting);
	const [pageIndex] = useValue(catalogState.state.pageIndex);
	const [pageSize, setPageSize] = useValue(catalogState.state.pageSize);
	const [cursors] = useValue(catalogState.state.cursors);
	const [nextCursor] = useValue(catalogState.state.nextCursor);
	const [filtersOpen, setFiltersOpen] = useValue(
		catalogState.state.filtersOpen,
	);
	const [formOpen, setFormOpen] = useValue(catalogState.state.formOpen);
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useValue(
		catalogState.state.deleteConfirmOpen,
	);
	const [editingItem, setEditingItem] = useValue(
		catalogState.state.editingItem,
	);
	const [formSession, setFormSession] = useValue(
		catalogState.state.formSession,
	);
	const [historyOpen, setHistoryOpen] = useValue(
		catalogState.state.historyOpen,
	);
	const [historyItem, setHistoryItem] = useValue(
		catalogState.state.historyItem,
	);
	const [historyEntries] = useValue(catalogState.state.historyEntries);
	const [historyLoading, setHistoryLoading] = useValue(
		catalogState.state.historyLoading,
	);
	const [historyError, setHistoryError] = useValue(
		catalogState.state.historyError,
	);
	const [selectedIds, setSelectedIds] = useValue(
		catalogState.state.selectedIds,
	);
	const [confirmArchiveMany, setConfirmArchiveMany] = useValue(
		catalogState.state.confirmArchiveMany,
	);
	const [exportStarted, setExportStarted] = useValue(
		catalogState.state.exportStarted,
	);
	const term = query.trim();
	const hasMore = nextCursor !== null;
	const archivable = bulkTargets(items, selectedIds, 'active');
	const restorable = bulkTargets(items, selectedIds, 'archived');
	const filterCount =
		(kindFilter === '' ? 0 : 1) +
		(statusFilter === DEFAULT_STATUS_FILTER ? 0 : 1);
	const listing = (): Listing => ({
		pageIndex,
		pageSize,
		sorting,
		query: appliedQuery,
		kind: kindFilter,
		status: statusFilter,
		cursors,
	});
	/* The search timer fires after later renders; it reads the listing those
   renders left here rather than the one the keystroke saw. */
	const latest = useMemo(() => ({ listing: listing() }), []);
	latest.listing = listing();
	/* A changed order, filter or page size is a new listing, whose cursors
   name positions in the old one. */
	const firstPage = (changes: Partial<Listing>): Listing => ({
		...listing(),
		...changes,
		pageIndex: 0,
		cursors: resetPageCursors(),
	});

	const failLoad = (loadError: unknown) => {
		setError(message(loadError, t('catalog.error.load')));
		setStatus(
			loadError instanceof ApiError && loadError.status === 403
				? 'denied'
				: 'error',
		);
	};

	/* The server sorts, narrows and cuts the page; the listing travels as an
   argument because the click that changes it and the load it starts happen
   in one render, where the state hooks still read the old values. */
	const load = async (next: Listing) => {
		const cursor = pageCursor(next.cursors, next.pageIndex);
		if (cursor === undefined) return;
		const sequence = requests.sequence + 1;
		requests.sequence = sequence;
		setStatus('loading');
		setError('');
		try {
			const { sort, direction } = catalogSort(next.sorting);
			const page = await loadCatalogItems({
				sort,
				direction,
				limit: next.pageSize,
				query: next.query,
				kind: next.kind,
				status: next.status,
				cursor,
			});
			if (sequence !== requests.sequence) return;
			const loaded = loadedListing(next, page);
			catalogState.store.act((transaction) => {
				transaction.set(catalogState.state.items, loaded.items);
				transaction.set(catalogState.state.appliedQuery, loaded.appliedQuery);
				transaction.set(catalogState.state.pageIndex, loaded.pageIndex);
				transaction.set(catalogState.state.cursors, loaded.cursors);
				transaction.set(catalogState.state.nextCursor, loaded.nextCursor);
				transaction.set(catalogState.state.selectedIds, loaded.selectedIds);
				transaction.set(catalogState.state.status, 'idle');
			}, 'catalog/loaded');
		} catch (loadError) {
			if (sequence === requests.sequence) failLoad(loadError);
		}
	};

	const refresh = () => {
		setExportStarted(false);
		return load(firstPage({}));
	};

	const openPage = (index: number) => {
		if (index !== pageIndex) void load({ ...listing(), pageIndex: index });
	};

	const changeSorting = (sorts: readonly TableSort[]) => {
		const next =
			sorts.length === 0 ? DEFAULT_CATALOG_SORTING : sorts;
		setSorting(next);
		void load(firstPage({ sorting: next }));
	};

	const changeKindFilter = (value: string) => {
		const next: CatalogKindFilter =
			value === 'product' || value === 'service' ? value : '';
		setKindFilter(next);
		void load(firstPage({ kind: next }));
	};

	const changeStatusFilter = (value: string) => {
		const next: CatalogStatusFilter =
			value === 'active' || value === 'archived' ? value : '';
		setStatusFilter(next);
		void load(firstPage({ status: next }));
	};

	const changePageSize = (size: number) => {
		setPageSize(size);
		void load(firstPage({ pageSize: size }));
	};

	useEffect(() => {
		void refresh();
	}, []);

	/* The term is the server's filter, so typing it starts a new listing rather
   than narrowing the page on screen: one listing per pause in the typing. */
	useEffect(() => {
		if (!searchPending(query, appliedQuery)) return;
		const timer = setTimeout(
			() => void load({
				...latest.listing,
				query: term,
				pageIndex: 0,
				cursors: resetPageCursors(),
			}),
			SEARCH_DEBOUNCE_MS,
		);
		return () => clearTimeout(timer);
	}, [query]);

	const openForm = (item: CatalogItem | null) => {
		setEditingItem(item);
		setError('');
		setFormSession((current) => current + 1);
		setFormOpen(true);
	};

	const closeForm = () => {
		setFormOpen(false);
		setEditingItem(null);
		setError('');
	};

	const replace = (item: CatalogItem) => {
		catalogState.store.act(
			(transaction) => transaction.set(
				catalogState.state.items,
				replaceItem(items, item),
			),
			'catalog/item-updated',
		);
		setEditingItem(item);
	};

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		const element = event.currentTarget as HTMLFormElement;
		const form = new FormData(element);
		setStatus('submitting');
		setError('');
		try {
			const mutable = {
				name: formValue(form, 'name'),
				kind: formValue(form, 'kind') as CatalogItemKind,
				unit: formValue(form, 'unit'),
				basePriceMinor: Number(formValue(form, 'basePriceMinor')),
				currency: formValue(form, 'currency'),
			};
			if (editingItem) {
				replace(
					await updateCatalogItem(
						{ id: editingItem.id, ...mutable },
						props.csrfToken,
					),
				);
				closeForm();
				setStatus('idle');
			} else {
				await createCatalogItem(
					{ sku: formValue(form, 'sku'), ...mutable },
					props.csrfToken,
				);
				closeForm();
				/* The new row belongs wherever the order puts it; the first page
   of the listing shows it or the page it is on does. */
				await load(firstPage({}));
			}
		} catch (saveError) {
			setError(
				message(
					saveError,
					t(editingItem ? 'catalog.error.update' : 'catalog.error.create'),
				),
			);
			setStatus('idle');
		}
	};

	const changeStatus = async (action: 'archive' | 'restore') => {
		if (!editingItem) return;
		setStatus('submitting');
		setError('');
		try {
			const item =
				action === 'archive'
					? await archiveCatalogItem(editingItem.id, props.csrfToken)
					: await restoreCatalogItem(editingItem.id, props.csrfToken);
			replace(item);
			setStatus('idle');
			/* Under a status filter the row no longer belongs on this page. */
			if (statusFilter !== '') await load(listing());
		} catch (lifecycleError) {
			setError(message(lifecycleError, t('catalog.error.lifecycle')));
			setStatus('idle');
		}
	};

	const remove = async () => {
		if (!editingItem) return;
		setStatus('submitting');
		setError('');
		try {
			await deleteCatalogItem(editingItem.id, props.csrfToken);
			setDeleteConfirmOpen(false);
			closeForm();
			await load(listing());
		} catch (deleteError) {
			setError(message(deleteError, t('catalog.error.delete')));
			setStatus('idle');
		}
	};

	/* Both bulk actions go the same way: the qualifying selected ids on screen,
   one outcome per id, then the listing is read again and the counts are
   told. A refused or missing id is a count, never a failure of the call. */
	const applyMany = async (
		ids: readonly string[],
		run: (ids: readonly string[]) => Promise<readonly CatalogBulkOutcome[]>,
		done: string,
		fallback: string,
	) => {
		if (ids.length === 0) return;
		setStatus('submitting');
		setError('');
		try {
			const outcomes = await run(ids);
			await load(listing());
			toasts.success(t(done, bulkOutcomeCounts(outcomes)));
		} catch (bulkError) {
			setError(message(bulkError, t(fallback)));
			setStatus('idle');
		}
	};

	const archiveMany = () => {
		setConfirmArchiveMany(false);
		void applyMany(
			archivable,
			(ids) => archiveCatalogItems(ids, props.csrfToken),
			'catalog.notice.archivedMany',
			'catalog.error.archiveMany',
		);
	};

	const restoreMany = () => {
		void applyMany(
			restorable,
			(ids) => restoreCatalogItems(ids, props.csrfToken),
			'catalog.notice.restoredMany',
			'catalog.error.restoreMany',
		);
	};

	/* exports.core answers as soon as the job is recorded, not when the file is
   written, so the screen reports that it started and points at the screen
   that hands it over. */
	const startExport = async () => {
		setStatus('submitting');
		setError('');
		try {
			await startListExport(CATALOG_ITEMS_EXPORT_LIST_ID, props.csrfToken);
			setExportStarted(true);
			setStatus('idle');
		} catch (exportError) {
			setError(message(exportError, t('catalog.export.error')));
			setStatus('idle');
		}
	};

	const openHistory = async (item: CatalogItem) => {
		setHistoryItem(item);
		setHistoryOpen(true);
		setHistoryLoading(true);
		setHistoryError('');
		catalogState.store.act(
			(transaction) => transaction.set(catalogState.state.historyEntries, []),
			'catalog/history-loading',
		);
		try {
			const page = await loadCatalogItemHistory(item.id);
			catalogState.store.act(
				(transaction) => transaction.set(
					catalogState.state.historyEntries,
					page.entries,
				),
				'catalog/history-loaded',
			);
		} catch (historyFailure) {
			setHistoryError(message(historyFailure, t('catalog.error.history')));
		} finally {
			setHistoryLoading(false);
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('catalog.page.eyebrow')}
			title={t('catalog.page.title')}
			description={t('catalog.page.description')}
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				{t('catalog.page.action.refresh')}
			</Button>
			@if (props.canExport) {
				<Button
					size="sm"
					disabled={status === 'denied' || status === 'submitting'}
					onClick={() => void startExport()}
				>
					<Icon name="download" size={14} />
					{t('catalog.export.action')}
				</Button>
			}
			@if (props.canManage) {
				<Button
					size="sm"
					variant="primary"
					disabled={status === 'denied'}
					onClick={() => openForm(null)}
				>
					<Icon name="plus" size={14} />
					{t('catalog.page.action.new')}
				</Button>
			}
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('catalog.denied.title')}>{t(
					'catalog.denied.description',
				)}</EmptyState>
			</section>
		} @else {
			<>
				@if (error && !formOpen) {
					<Alert>{error}</Alert>
				}
				@if (exportStarted) {
					<Alert tone="info">
						{t('catalog.export.started')}
						{' '}
						<a href="/exports">{t('catalog.export.link')}</a>
					</Alert>
				}
				<TableCard
					title={t('catalog.table.title')}
					count={t('catalog.table.count.page', { count: items.length })}
					search={<SearchField
						value={query}
						placeholder={t('catalog.table.search.placeholder')}
						label={t('catalog.table.search.label')}
						onInput={setQuery}
					/>}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={filterCount}
						label={t('catalog.filters.label')}
					>
						<Select
							id="catalog-kind-filter"
							label={t('catalog.filters.kind')}
							value={kindFilter}
							options={[
								{ value: '', label: t('catalog.filters.allKinds') },
								{ value: 'product', label: t('catalog.kind.product') },
								{ value: 'service', label: t('catalog.kind.service') },
							]}
							onChange={changeKindFilter}
						/>
						<Select
							id="catalog-status-filter"
							label={t('catalog.filters.status')}
							value={statusFilter}
							options={[
								{ value: '', label: t('catalog.filters.allStatuses') },
								{ value: 'active', label: t('catalog.status.active') },
								{ value: 'archived', label: t('catalog.status.archived') },
							]}
							onChange={changeStatusFilter}
						/>
					</Filters>}
					caption={t('catalog.table.caption')}
					mode="server"
					columns={columns()}
					rows={items}
					rowKey={(item) => item.id}
					sorting
					sortingState={sorting}
					onSortingChange={changeSorting}
					pagination={{
						pageIndex,
						pageSize,
						onPageChange: openPage,
						hasMore,
					}}
					after={<Pagination
						pageIndex={pageIndex}
						pageSize={pageSize}
						hasMore={hasMore}
						pageSizes={PAGE_SIZES}
						onPageChange={openPage}
						onPageSizeChange={changePageSize}
						label={t('catalog.pagination.label')}
						previousLabel={t('catalog.pagination.previous')}
						nextLabel={t('catalog.pagination.next')}
						pageSizeLabel={t('catalog.pagination.size')}
						summary={(page) => t('catalog.pagination.summary', {
							page: page.pageIndex + 1,
							from: page.from,
						})}
					/>}
					status={status === 'loading' ? 'loading' : 'idle'}
					loadingLabel={t('catalog.table.loading')}
					filtered={appliedQuery !== '' || filterCount > 0}
					empty={{
						icon: 'catalog',
						title: t('catalog.table.empty.title'),
						hint: t('catalog.table.empty.hint'),
					}}
					emptyFiltered={{
						icon: 'catalog',
						title: t('catalog.table.emptyFiltered.title'),
						hint: t('catalog.table.emptyFiltered.hint'),
					}}
					selection={props.canManage
						? {
								selectedKeys: selectedIds,
								onSelectionChange: setSelectedIds,
								label: t('catalog.selection.label'),
								rowLabel: (item) => t('catalog.selection.rowLabel', {
									name: item.name,
								}),
								clearLabel: t('catalog.selection.clear'),
							}
						: undefined}
					bulkActions={props.canManage
						? [
								{
									id: 'archive-selected',
									label: t('catalog.action.archiveSelected'),
									icon: 'x',
									tone: 'danger',
									disabled: archivable.length === 0 || status === 'submitting',
									reason: archivable.length === 0
										? t('catalog.action.archiveRefused')
										: undefined,
									onSelect: () => setConfirmArchiveMany(true),
								},
								{
									id: 'restore-selected',
									label: t('catalog.action.restoreSelected'),
									icon: 'refresh',
									disabled: restorable.length === 0 || status === 'submitting',
									reason: restorable.length === 0
										? t('catalog.action.restoreRefused')
										: undefined,
									onSelect: restoreMany,
								},
							]
						: undefined}
					selectionSummary={(count) => t('catalog.selection.summary', {
						count,
					})}
					actionsLabel={t('catalog.table.column.actions')}
					actionsWidth="280px"
					actions={(item) => [
						{
							id: 'history',
							label: t('catalog.action.history'),
							icon: 'activity',
							onSelect: () => void openHistory(item),
						},
						...(props.canManage
							? [
									{
										id: 'edit',
										label: t('catalog.action.edit'),
										icon: 'file-text',
										onSelect: () => openForm(item),
									},
								]
							: []),
					]}
				/>
			</>
		}
		<Drawer
			open={formOpen}
			title={t(
				editingItem ? 'catalog.drawer.editTitle' : 'catalog.drawer.title',
			)}
			subtitle={t('catalog.drawer.subtitle')}
			width="lg"
			onClose={closeForm}
		>
			<CatalogItemForm
				key={'catalog-form-' + formSession}
				item={editingItem}
				busy={status === 'submitting'}
				error={error}
				onCancel={closeForm}
				onArchive={editingItem?.status === 'active'
					? () => void changeStatus('archive')
					: undefined}
				onRestore={editingItem?.status === 'archived'
					? () => void changeStatus('restore')
					: undefined}
				onDelete={editingItem?.status === 'archived'
					? () => setDeleteConfirmOpen(true)
					: undefined}
				onHistory={editingItem
					? () => void openHistory(editingItem)
					: undefined}
				onSubmit={(event) => void submit(event)}
			/>
		</Drawer>
		<CatalogHistoryDrawer
			open={historyOpen}
			item={historyItem}
			entries={historyEntries}
			loading={historyLoading}
			error={historyError}
			onClose={() => {
				setHistoryOpen(false);
				setHistoryItem(null);
			}}
		/>
		<ConfirmDialog
			open={deleteConfirmOpen}
			title={t('catalog.delete.title')}
			confirmLabel={t('catalog.delete.confirm')}
			cancelLabel={t('catalog.form.cancel')}
			busy={status === 'submitting'}
			onConfirm={() => void remove()}
			onCancel={() => setDeleteConfirmOpen(false)}
		>{t('catalog.delete.description', {
			name: editingItem?.name ?? '',
		})}</ConfirmDialog>
		<ConfirmDialog
			open={confirmArchiveMany}
			title={t('catalog.archiveMany.title')}
			confirmLabel={t('catalog.action.archiveSelected')}
			cancelLabel={t('catalog.form.cancel')}
			busy={status === 'submitting'}
			onConfirm={archiveMany}
			onCancel={() => setConfirmArchiveMany(false)}
		>{t('catalog.archiveMany.description', {
			count: archivable.length,
		})}</ConfirmDialog>
		<ToastHost
			label={t('catalog.common.messages')}
			closeLabel={t('catalog.action.close')}
		/>
	</div>
}

export function CatalogDashboardWidget() @{
	const widgetState = useMemo(() => createCatalogClientState(), []);
	const [items] = useValue(widgetState.state.items);
	const [nextCursor] = useValue(widgetState.state.nextCursor);
	const [status, setStatus] = useValue(widgetState.state.status);
	useEffect(() => {
		setStatus('loading');
		void loadCatalogItems({
			sort: 'name',
			direction: 'asc',
			limit: WIDGET_PAGE,
			query: '',
			kind: '',
			status: 'active',
			cursor: null,
		}).then((page) => {
			widgetState.store.act((transaction) => {
				transaction.set(widgetState.state.items, page.items);
				transaction.set(widgetState.state.nextCursor, page.page.nextCursor);
			}, 'catalog/widget-loaded');
		}).catch(() => undefined).finally(() => setStatus('idle'));
	}, []);
	const count = new Intl.NumberFormat(activeLocale()).format(items.length);
	<Kpi
		label={t('catalog.widget.label')}
		value={status === 'loading'
			? '…'
			: nextCursor === null
				? count
				: count + '+'}
		note={t('catalog.widget.note')}
		href="/catalog"
		linkLabel={t('catalog.widget.link')}
	/>
}
