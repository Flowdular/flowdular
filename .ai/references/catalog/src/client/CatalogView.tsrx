import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	ConfirmDialog,
	Drawer,
	Filters,
	Icon,
	Kpi,
	PageHeader,
	SearchField,
	TableCard,
	Tag,
	type TableColumn,
} from '@flowdular/sdk/ui';
import { activeLocale, t } from '@flowdular/sdk/client';
import { useValue } from 'segment-state';
import type { CatalogItem, CatalogItemKind } from '../domain/types.ts';
import {
	archiveCatalogItem,
	createCatalogItem,
	deleteCatalogItem,
	loadCatalogItemHistory,
	loadCatalogItems,
	restoreCatalogItem,
	updateCatalogItem,
} from './api.ts';
import { createCatalogClientState } from './state.ts';
import { CatalogItemForm } from './CatalogItemForm.tsrx';
import { CatalogHistoryDrawer } from './CatalogHistoryDrawer.tsrx';

export interface CatalogViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

function formValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value : '';
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

function columns(): readonly TableColumn<CatalogItem>[] {
	return [
		{
			key: 'item',
			header: t('catalog.table.column.item'),
			width: '36%',
			cell: (item) => <span class="ui-cell">
				<b>{item.name}</b>
				<small class="ui-mono">{item.sku + ' · ' + item.unit}</small>
			</span>,
		},
		{
			key: 'kind',
			header: t('catalog.table.column.kind'),
			width: '16%',
			cell: (item) =>
				<Tag tone={item.kind === 'product' ? 'info' : 'neutral'}>{t(
					'catalog.kind.' + item.kind,
				)}</Tag>,
		},
		{
			key: 'price',
			header: t('catalog.table.column.price'),
			width: '22%',
			numeric: true,
			cell: (item) => price(item.basePriceMinor, item.currency),
		},
		{
			key: 'status',
			header: t('catalog.table.column.status'),
			width: '16%',
			cell: (item) =>
				<Tag tone={item.status === 'active' ? 'success' : 'neutral'} dot>{t(
					'catalog.status.' + item.status,
				)}</Tag>,
		},
	];
}

export function CatalogView(props: CatalogViewProps) @{
	const catalogState = useMemo(() => createCatalogClientState(), []);
	const [items] = useValue(catalogState.state.items);
	const [status, setStatus] = useValue(catalogState.state.status);
	const [error, setError] = useValue(catalogState.state.error);
	const [query, setQuery] = useValue(catalogState.state.query);
	const [includeArchived, setIncludeArchived] = useValue(
		catalogState.state.includeArchived,
	);
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
	const locale = activeLocale();
	const term = query.trim().toLocaleLowerCase(locale);
	const visible = items.filter(
		(item) =>
			(includeArchived || item.status === 'active') &&
				(term === '' || item.name.toLocaleLowerCase(locale).includes(term) ||
					item.sku.toLocaleLowerCase(locale).includes(term)),
	);
	const filtered = term !== '' || includeArchived;

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const records = await loadCatalogItems();
			catalogState.store.act(
				(transaction) => transaction.set(catalogState.state.items, records),
				'catalog/loaded',
			);
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: t('catalog.error.load'),
			);
		} finally {
			setStatus('idle');
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

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
				items.map((current) => current.id === item.id ? item : current),
			),
			'catalog/lifecycle',
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
			const item = editingItem
				? await updateCatalogItem(
						{ id: editingItem.id, ...mutable },
						props.csrfToken,
					)
				: await createCatalogItem(
						{ sku: formValue(form, 'sku'), ...mutable },
						props.csrfToken,
					);
			const next =
				editingItem
					? items.map((current) => current.id === item.id ? item : current)
					: [...items, item];
			catalogState.store.act(
				(transaction) => transaction.set(
					catalogState.state.items,
					[...next].sort((left, right) => left.sku.localeCompare(right.sku)),
				),
				editingItem ? 'catalog/updated' : 'catalog/created',
			);
			closeForm();
		} catch (saveError) {
			setError(
				saveError instanceof Error
					? saveError.message
					: t(editingItem ? 'catalog.error.update' : 'catalog.error.create'),
			);
		} finally {
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
		} catch (lifecycleError) {
			setError(
				lifecycleError instanceof Error
					? lifecycleError.message
					: t('catalog.error.lifecycle'),
			);
		} finally {
			setStatus('idle');
		}
	};

	const remove = async () => {
		if (!editingItem) return;
		setStatus('submitting');
		setError('');
		try {
			await deleteCatalogItem(editingItem.id, props.csrfToken);
			catalogState.store.act(
				(transaction) => transaction.set(
					catalogState.state.items,
					items.filter((item) => item.id !== editingItem.id),
				),
				'catalog/deleted',
			);
			setDeleteConfirmOpen(false);
			closeForm();
		} catch (deleteError) {
			setError(
				deleteError instanceof Error
					? deleteError.message
					: t('catalog.error.delete'),
			);
		} finally {
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
			setHistoryError(
				historyFailure instanceof Error
					? historyFailure.message
					: t('catalog.error.history'),
			);
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
			@if (props.canManage) {
				<Button size="sm" variant="primary" onClick={() => openForm(null)}>
					<Icon name="plus" size={14} />
					{t('catalog.page.action.new')}
				</Button>
			}
		</PageHeader>
		@if (error && !formOpen) {
			<Alert>{error}</Alert>
		}
		<TableCard
			title={t('catalog.table.title')}
			count={t(
				items.length === 1
					? 'catalog.table.count.one'
					: 'catalog.table.count.other',
				{ count: items.length },
			)}
			search={<SearchField
				value={query}
				placeholder={t('catalog.table.search.placeholder')}
				label={t('catalog.table.search.label')}
				onInput={setQuery}
			/>}
			filters={<Filters
				open={filtersOpen}
				onToggle={() => setFiltersOpen(!filtersOpen)}
				activeCount={includeArchived ? 1 : 0}
				label={t('catalog.filters.label')}
			>
				<label class="ui-checkbox">
					<input
						type="checkbox"
						checked={includeArchived}
						onChange={(event: Event) => setIncludeArchived(
							(event.currentTarget as HTMLInputElement).checked,
						)}
					/>
					<span>{t('catalog.filters.includeArchived')}</span>
				</label>
			</Filters>}
			caption={t('catalog.table.caption')}
			columns={columns()}
			rows={visible}
			rowKey={(item) => item.id}
			status={status === 'loading' && items.length === 0 ? 'loading' : 'idle'}
			loadingLabel={t('catalog.table.loading')}
			filtered={filtered}
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
	</div>
}

export function CatalogDashboardWidget() @{
	const widgetState = useMemo(() => createCatalogClientState(), []);
	const [items] = useValue(widgetState.state.items);
	const [status, setStatus] = useValue(widgetState.state.status);
	useEffect(() => {
		setStatus('loading');
		void loadCatalogItems().then((records) => {
			widgetState.store.act(
				(transaction) => transaction.set(widgetState.state.items, records),
				'catalog/widget-loaded',
			);
		}).catch(() => undefined).finally(() => setStatus('idle'));
	}, []);
	<Kpi
		label={t('catalog.widget.label')}
		value={status === 'loading'
			? '…'
			: new Intl.NumberFormat(activeLocale()).format(items.length)}
		note={t('catalog.widget.note')}
		href="/catalog"
		linkLabel={t('catalog.widget.link')}
	/>
}
