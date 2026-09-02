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
} from '@coreloom/ui';
import { activeLocale, t } from '@coreloom/client';
import { cell, createStore, useValue } from 'segment-state';
import type { Party, PartyKind } from '../domain/types.ts';
import {
	archiveParty,
	createParty,
	deleteParty,
	loadPartyHistory,
	loadParties,
	restoreParty,
	updateParty,
} from './api.ts';
import { filterParties } from './party-list.ts';
import { createPartiesClientState } from './state.ts';
import { PartyForm } from './PartyForm.tsrx';
import { PartyHistoryDrawer } from './PartyHistoryDrawer.tsrx';

export interface PartiesViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
	readonly kind: 'customer' | 'supplier';
}

function formValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value : '';
}

function kindLabel(kind: PartyKind): string {
	return t('parties.kind.' + kind);
}

function columns(): readonly TableColumn<Party>[] {
	return [
		{
			key: 'party',
			header: t('parties.table.column.party'),
			width: '34%',
			cell: (party) => <span class="ui-cell">
				<b>{party.name}</b>
				<small>
					{party.email ?? party.phone ?? t('parties.table.noContact')}
				</small>
			</span>,
		},
		{
			key: 'kind',
			header: t('parties.table.column.kind'),
			width: '18%',
			cell: (party) => kindLabel(party.kind),
		},
		{
			key: 'vatId',
			header: t('parties.table.column.vatId'),
			width: '22%',
			cell: (party) =>
				<span class="ui-mono">{party.vatId ?? t('parties.table.notSet')}</span>,
		},
		{
			key: 'status',
			header: t('parties.table.column.status'),
			width: '16%',
			cell: (party) =>
				<Tag tone={party.status === 'active' ? 'success' : 'neutral'} dot>{t(
					'parties.status.' + party.status,
				)}</Tag>,
		},
	];
}

export function PartiesView(props: PartiesViewProps) @{
	const partiesState = useMemo(() => createPartiesClientState(), []);
	const [parties] = useValue(partiesState.state.parties);
	const [status, setStatus] = useValue(partiesState.state.status);
	const [error, setError] = useValue(partiesState.state.error);
	const [query, setQuery] = useValue(partiesState.state.query);
	const [vatIdOnly, setVatIdOnly] = useValue(partiesState.state.vatIdOnly);
	const [includeArchived, setIncludeArchived] = useValue(
		partiesState.state.includeArchived,
	);
	const [formOpen, setFormOpen] = useValue(partiesState.state.formOpen);
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useValue(
		partiesState.state.deleteConfirmOpen,
	);
	const [editingParty, setEditingParty] = useValue(
		partiesState.state.editingParty,
	);
	const [historyOpen, setHistoryOpen] = useValue(
		partiesState.state.historyOpen,
	);
	const [historyParty, setHistoryParty] = useValue(
		partiesState.state.historyParty,
	);
	const [historyEntries] = useValue(partiesState.state.historyEntries);
	const [historyLoading, setHistoryLoading] = useValue(
		partiesState.state.historyLoading,
	);
	const [historyError, setHistoryError] = useValue(
		partiesState.state.historyError,
	);
	const [formSession, setFormSession] = useValue(
		partiesState.state.formSession,
	);
	const filterMenu = useMemo(() => createStore({ open: cell(false) }), []);
	const [filtersOpen, setFiltersOpen] = useValue(filterMenu.state.open);
	const visible = filterParties(
		parties,
		query,
		vatIdOnly,
		props.kind,
		includeArchived,
	);
	const records = parties.filter(
		(party) => party.kind === props.kind || party.kind === 'both',
	);
	const filtersActive = query.trim() !== '' || vatIdOnly || includeArchived;
	const namespace = 'parties.' + props.kind;

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const loaded = await loadParties();
			partiesState.store.act(
				(transaction) => transaction.set(partiesState.state.parties, loaded),
				'parties/loaded',
			);
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: t('parties.error.load'),
			);
		} finally {
			setStatus('idle');
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const openForm = (party: Party | null) => {
		setEditingParty(party);
		setError('');
		setFormSession((current) => current + 1);
		setFormOpen(true);
	};

	const closeForm = () => {
		setFormOpen(false);
		setEditingParty(null);
		setError('');
	};

	const replace = (party: Party) => {
		partiesState.store.act(
			(transaction) => transaction.set(
				partiesState.state.parties,
				parties.map((current) => current.id === party.id ? party : current),
			),
			'parties/lifecycle',
		);
		setEditingParty(party);
	};

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		const element = event.currentTarget as HTMLFormElement;
		const form = new FormData(element);
		setStatus('submitting');
		setError('');
		try {
			const input = {
				name: formValue(form, 'name'),
				kind: formValue(form, 'kind') as PartyKind,
				email: formValue(form, 'email'),
				phone: formValue(form, 'phone'),
				vatId: formValue(form, 'vatId'),
			};
			const party = editingParty
				? await updateParty({ id: editingParty.id, ...input }, props.csrfToken)
				: await createParty(input, props.csrfToken);
			const next =
				editingParty
					? parties.map((current) => current.id === party.id ? party : current)
					: [...parties, party];
			partiesState.store.act(
				(transaction) => transaction.set(
					partiesState.state.parties,
					[...next].sort((left, right) => left.name.localeCompare(right.name)),
				),
				editingParty ? 'parties/updated' : 'parties/created',
			);
			closeForm();
		} catch (saveError) {
			setError(
				saveError instanceof Error
					? saveError.message
					: t(editingParty ? 'parties.error.update' : 'parties.error.create'),
			);
		} finally {
			setStatus('idle');
		}
	};

	const changeStatus = async (action: 'archive' | 'restore') => {
		if (!editingParty) return;
		setStatus('submitting');
		setError('');
		try {
			const party =
				action === 'archive'
					? await archiveParty(editingParty.id, props.csrfToken)
					: await restoreParty(editingParty.id, props.csrfToken);
			replace(party);
		} catch (lifecycleError) {
			setError(
				lifecycleError instanceof Error
					? lifecycleError.message
					: t('parties.error.lifecycle'),
			);
		} finally {
			setStatus('idle');
		}
	};

	const remove = async () => {
		if (!editingParty) return;
		setStatus('submitting');
		setError('');
		try {
			await deleteParty(editingParty.id, props.csrfToken);
			partiesState.store.act(
				(transaction) => transaction.set(
					partiesState.state.parties,
					parties.filter((party) => party.id !== editingParty.id),
				),
				'parties/deleted',
			);
			setDeleteConfirmOpen(false);
			closeForm();
		} catch (deleteError) {
			setError(
				deleteError instanceof Error
					? deleteError.message
					: t('parties.error.delete'),
			);
		} finally {
			setStatus('idle');
		}
	};

	const openHistory = async (party: Party) => {
		setHistoryParty(party);
		setHistoryOpen(true);
		setHistoryLoading(true);
		setHistoryError('');
		partiesState.store.act(
			(transaction) => transaction.set(partiesState.state.historyEntries, []),
			'parties/history-loading',
		);
		try {
			const page = await loadPartyHistory(party.id);
			partiesState.store.act(
				(transaction) => transaction.set(
					partiesState.state.historyEntries,
					page.entries,
				),
				'parties/history-loaded',
			);
		} catch (historyFailure) {
			setHistoryError(
				historyFailure instanceof Error
					? historyFailure.message
					: t('parties.error.history'),
			);
		} finally {
			setHistoryLoading(false);
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('parties.page.eyebrow')}
			title={t(namespace + '.title')}
			description={t(namespace + '.description')}
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				{t('parties.action.refresh')}
			</Button>
			@if (props.canManage) {
				<Button size="sm" variant="primary" onClick={() => openForm(null)}>
					<Icon name="plus" size={14} />
					{t(namespace + '.new')}
				</Button>
			}
		</PageHeader>
		@if (error && !formOpen) {
			<Alert>{error}</Alert>
		}
		<TableCard
			title={t(namespace + '.tableTitle')}
			count={t('parties.table.count', { count: records.length })}
			search={<SearchField
				value={query}
				placeholder={t('parties.search.placeholder')}
				label={t('parties.search.label')}
				onInput={setQuery}
			/>}
			filters={<Filters
				open={filtersOpen}
				onToggle={() => setFiltersOpen(!filtersOpen)}
				activeCount={(vatIdOnly ? 1 : 0) + (includeArchived ? 1 : 0)}
				label={t('parties.filters.label')}
			>
				<label class="ui-checkbox">
					<input
						type="checkbox"
						checked={vatIdOnly}
						onChange={(event: Event) => setVatIdOnly(
							(event.currentTarget as HTMLInputElement).checked,
						)}
					/>
					<span>{t('parties.filters.hasVatId')}</span>
				</label>
				<label class="ui-checkbox">
					<input
						type="checkbox"
						checked={includeArchived}
						onChange={(event: Event) => setIncludeArchived(
							(event.currentTarget as HTMLInputElement).checked,
						)}
					/>
					<span>{t('parties.filters.includeArchived')}</span>
				</label>
			</Filters>}
			caption={t(namespace + '.tableTitle')}
			columns={columns()}
			rows={visible}
			rowKey={(party) => party.id}
			status={status === 'loading' && parties.length === 0 ? 'loading' : 'idle'}
			loadingLabel={t('parties.table.loading')}
			filtered={filtersActive}
			empty={{
				icon: 'parties',
				title: t(namespace + '.emptyTitle'),
				hint: t(namespace + '.emptyHint'),
			}}
			emptyFiltered={{
				icon: 'parties',
				title: t('parties.table.emptyFilteredTitle'),
				hint: t('parties.table.emptyFilteredHint'),
			}}
			actionsLabel={t('parties.table.column.actions')}
			actionsWidth={props.canManage ? '280px' : '160px'}
			actions={(party) => [
				{
					id: 'history',
					label: t('parties.action.history'),
					icon: 'activity',
					onSelect: () => void openHistory(party),
				},
				...(props.canManage
					? [
							{
								id: 'edit',
								label: t('parties.action.edit'),
								icon: 'file-text',
								onSelect: () => openForm(party),
							},
						]
					: []),
			]}
		/>
		<Drawer
			open={formOpen}
			title={editingParty ? t('parties.drawer.edit') : t(namespace + '.new')}
			subtitle={editingParty
				? t('parties.drawer.editSubtitle')
				: t(namespace + '.drawerSubtitle')}
			width="lg"
			onClose={closeForm}
		>
			<PartyForm
				key={'party-form-' + formSession}
				party={editingParty}
				defaultKind={props.kind}
				busy={status === 'submitting'}
				error={error}
				onCancel={closeForm}
				onArchive={editingParty?.status === 'active'
					? () => changeStatus('archive')
					: undefined}
				onRestore={editingParty?.status === 'archived'
					? () => changeStatus('restore')
					: undefined}
				onDelete={editingParty?.status === 'archived'
					? () => setDeleteConfirmOpen(true)
					: undefined}
				onSubmit={(event) => void submit(event)}
			/>
		</Drawer>
		<PartyHistoryDrawer
			open={historyOpen}
			party={historyParty}
			entries={historyEntries}
			loading={historyLoading}
			error={historyError}
			onClose={() => {
				setHistoryOpen(false);
				setHistoryParty(null);
			}}
		/>
		<ConfirmDialog
			open={deleteConfirmOpen}
			title={t('parties.delete.title')}
			confirmLabel={t('parties.delete.confirm')}
			cancelLabel={t('parties.action.cancel')}
			busy={status === 'submitting'}
			onConfirm={() => void remove()}
			onCancel={() => setDeleteConfirmOpen(false)}
		>{t('parties.delete.description', {
			name: editingParty?.name ?? '',
		})}</ConfirmDialog>
	</div>
}

export function PartiesDashboardWidget() @{
	const widgetState = useMemo(() => createPartiesClientState(), []);
	const [parties] = useValue(widgetState.state.parties);
	const [status, setStatus] = useValue(widgetState.state.status);
	useEffect(() => {
		setStatus('loading');
		void loadParties().then((records) => {
			widgetState.store.act(
				(transaction) => transaction.set(widgetState.state.parties, records),
				'parties/widget-loaded',
			);
		}).catch(() => undefined).finally(() => setStatus('idle'));
	}, []);
	<Kpi
		label={t('parties.widget.label')}
		value={status === 'loading'
			? '…'
			: new Intl.NumberFormat(activeLocale()).format(
					parties.filter((party) => party.status === 'active').length,
				)}
		note={t('parties.widget.note')}
		href="/customers"
		linkLabel={t('parties.widget.link')}
	/>
}
