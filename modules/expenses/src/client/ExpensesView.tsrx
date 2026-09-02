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
	TableCard,
	Tag,
	type TableAction,
	type TableColumn,
} from '@coreloom/ui';
import { activeLocale, t } from '@coreloom/client';
import { useValue } from 'segment-state';
import type {
	ExpenseClaimCategory,
	ExpenseClaimDecision,
	ExpensesClaim,
} from '../domain/types.ts';
import {
	createExpensesClaim,
	decideExpensesClaim,
	deleteExpensesClaim,
	loadAwaitingApprovalCount,
	loadExpenseClaimHistory,
	loadExpensesClaims,
	submitExpensesClaim,
} from './api.ts';
import {
	amountToMinorUnits,
	expenseStatusTone,
	formatExpenseAmount,
	showsExpenseActionColumn,
	type ExpenseStatusFilter,
} from './expense-claims.ts';
import {
	createExpensesClientState,
	createExpensesDashboardState,
} from './state.ts';
import { ExpenseClaimForm } from './ExpenseClaimForm.tsrx';
import { ExpenseDecisionForm } from './ExpenseDecisionForm.tsrx';
import { ExpenseHistoryDrawer } from './ExpenseHistoryDrawer.tsrx';

export interface ExpensesViewProps {
	readonly csrfToken: string;
	readonly canRead: boolean;
	readonly canManage: boolean;
	readonly canApprove: boolean;
}

function formValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value : '';
}

function columns(withActions: boolean): readonly TableColumn<ExpensesClaim>[] {
	return [
		{
			key: 'claim',
			header: t('expenses.table.claim'),
			width: withActions ? '22%' : '26%',
			cell: (claim) => <span class="ui-cell">
				<b>{claim.title}</b>
				<small class="ui-mono">{claim.id}</small>
			</span>,
		},
		{
			key: 'expenseDate',
			header: t('expenses.table.expenseDate'),
			width: withActions ? '13%' : '14%',
			cell: (claim) => <span class="ui-mono">{claim.expenseDate}</span>,
		},
		{
			key: 'category',
			header: t('expenses.table.category'),
			width: withActions ? '13%' : '14%',
			cell: (claim) => t('expenses.category.' + claim.category),
		},
		{
			key: 'amount',
			header: t('expenses.table.amount'),
			width: withActions ? '12%' : '13%',
			numeric: true,
			cell: (claim) => formatExpenseAmount(claim.amountMinor, claim.currency),
		},
		{
			key: 'status',
			header: t('expenses.table.status'),
			width: withActions ? '13%' : '14%',
			cell: (claim) =>
				<Tag tone={expenseStatusTone(claim.status)} dot>{t(
					'expenses.status.' + claim.status,
				)}</Tag>,
		},
		{
			key: 'decisionComment',
			header: t('expenses.table.decisionComment'),
			width: withActions ? '17%' : '19%',
			cell: (claim) => claim.decisionComment
				? claim.decisionComment
				: <span class="ui-cell__muted">{t(
						'expenses.table.noDecisionComment',
					)}</span>,
		},
	];
}

export function ExpensesView(props: ExpensesViewProps) @{
	const viewState = useMemo(() => createExpensesClientState(), []);
	const [claims] = useValue(viewState.state.claims);
	const [statusFilter, setStatusFilter] = useValue(
		viewState.state.statusFilter,
	);
	const [filtersOpen, setFiltersOpen] = useValue(viewState.state.filtersOpen);
	const [status, setStatus] = useValue(viewState.state.status);
	const [error, setError] = useValue(viewState.state.error);
	const [formOpen, setFormOpen] = useValue(viewState.state.formOpen);
	const [formSession, setFormSession] = useValue(viewState.state.formSession);
	const [formError, setFormError] = useValue(viewState.state.formError);
	const [decisionOpen, setDecisionOpen] = useValue(
		viewState.state.decisionOpen,
	);
	const [decisionSession, setDecisionSession] = useValue(
		viewState.state.decisionSession,
	);
	const [decisionClaim, setDecisionClaim] = useValue(
		viewState.state.decisionClaim,
	);
	const [decision, setDecision] = useValue(viewState.state.decision);
	const [decisionError, setDecisionError] = useValue(
		viewState.state.decisionError,
	);
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useValue(
		viewState.state.deleteConfirmOpen,
	);
	const [deleteClaim, setDeleteClaim] = useValue(viewState.state.deleteClaim);
	const [historyOpen, setHistoryOpen] = useValue(viewState.state.historyOpen);
	const [historyClaim, setHistoryClaim] = useValue(
		viewState.state.historyClaim,
	);
	const [historyEntries] = useValue(viewState.state.historyEntries);
	const [historyLoading, setHistoryLoading] = useValue(
		viewState.state.historyLoading,
	);
	const [historyError, setHistoryError] = useValue(
		viewState.state.historyError,
	);

	const refresh = async (filter: ExpenseStatusFilter = statusFilter) => {
		setStatus('loading');
		setError('');
		try {
			const loaded = await loadExpensesClaims(filter);
			viewState.store.act(
				(transaction) => transaction.set(viewState.state.claims, loaded),
				'expenses/loaded',
			);
		} catch (loadError) {
			viewState.store.act(
				(transaction) => transaction.set(viewState.state.claims, []),
				'expenses/load-failed',
			);
			setError(
				loadError instanceof Error
					? loadError.message
					: t('expenses.error.load'),
			);
		} finally {
			setStatus('idle');
		}
	};

	useEffect(() => {
		if (props.canRead) void refresh('all');
	}, [props.canRead]);

	const changeStatusFilter = (filter: ExpenseStatusFilter) => {
		setStatusFilter(filter);
		void refresh(filter);
	};

	const openCreate = () => {
		setFormError('');
		setFormOpen(true);
	};

	const closeCreate = () => {
		setFormError('');
		setFormOpen(false);
	};

	const createClaim = async (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		const amountMinor = amountToMinorUnits(formValue(form, 'amount'));
		if (amountMinor === null) {
			setFormError(t('expenses.error.amount'));
			return;
		}
		setStatus('submitting');
		setFormError('');
		try {
			await createExpensesClaim(
				{
					title: formValue(form, 'title'),
					amountMinor,
					currency: formValue(form, 'currency').toUpperCase(),
					category: formValue(form, 'category') as ExpenseClaimCategory,
					expenseDate: formValue(form, 'expenseDate'),
					note: formValue(form, 'note').trim() || null,
				},
				props.csrfToken,
			);
			setFormSession((current) => current + 1);
			setFormOpen(false);
			await refresh(statusFilter);
		} catch (createError) {
			setFormError(
				createError instanceof Error
					? createError.message
					: t('expenses.error.create'),
			);
			setStatus('idle');
		}
	};

	const submitDraft = async (claimId: string) => {
		setStatus('submitting');
		setError('');
		try {
			await submitExpensesClaim(claimId, props.csrfToken);
			await refresh(statusFilter);
		} catch (submitError) {
			setError(
				submitError instanceof Error
					? submitError.message
					: t('expenses.error.submit'),
			);
			setStatus('idle');
		}
	};

	const requestDelete = (claim: ExpensesClaim) => {
		setDeleteClaim(claim);
		setDeleteConfirmOpen(true);
	};

	const closeDelete = () => {
		setDeleteConfirmOpen(false);
		setDeleteClaim(null);
	};

	const deleteDraft = async () => {
		if (!deleteClaim) return;
		setStatus('deleting');
		setError('');
		try {
			await deleteExpensesClaim(deleteClaim.id, props.csrfToken);
			closeDelete();
			await refresh(statusFilter);
		} catch (deleteError) {
			setError(
				deleteError instanceof Error
					? deleteError.message
					: t('expenses.error.delete'),
			);
			setStatus('idle');
		}
	};

	const openDecision = (
		claim: ExpensesClaim,
		nextDecision: ExpenseClaimDecision,
	) => {
		setDecisionClaim(claim);
		setDecision(nextDecision);
		setDecisionError('');
		setDecisionSession((current) => current + 1);
		setDecisionOpen(true);
	};

	const closeDecision = () => {
		setDecisionError('');
		setDecisionOpen(false);
		setDecisionClaim(null);
	};

	const openHistory = async (claim: ExpensesClaim) => {
		setHistoryClaim(claim);
		setHistoryOpen(true);
		setHistoryLoading(true);
		setHistoryError('');
		viewState.store.act(
			(transaction) => transaction.set(viewState.state.historyEntries, []),
			'expenses/history-loading',
		);
		try {
			const page = await loadExpenseClaimHistory(claim.id);
			viewState.store.act(
				(transaction) => transaction.set(
					viewState.state.historyEntries,
					page.entries,
				),
				'expenses/history-loaded',
			);
		} catch (historyFailure) {
			setHistoryError(
				historyFailure instanceof Error
					? historyFailure.message
					: t('expenses.error.history'),
			);
		} finally {
			setHistoryLoading(false);
		}
	};

	const decideClaim = async (event: SubmitEvent) => {
		event.preventDefault();
		if (!decisionClaim) return;
		const form = new FormData(event.currentTarget as HTMLFormElement);
		setStatus('deciding');
		setDecisionError('');
		try {
			await decideExpensesClaim(
				decisionClaim.id,
				decision,
				formValue(form, 'comment'),
				props.csrfToken,
			);
			closeDecision();
			await refresh(statusFilter);
		} catch (decisionFailure) {
			setDecisionError(
				decisionFailure instanceof Error
					? decisionFailure.message
					: t('expenses.error.decision'),
			);
			setStatus('idle');
		}
	};

	/* Keep the action column whenever this principal can perform an action.
   Filtering to decided records must not resize every data column. */
	const showActionColumn = showsExpenseActionColumn(
		props.canManage,
		props.canApprove,
	);
	const claimActions = (claim: ExpensesClaim): readonly TableAction[] => {
		if (claim.status === 'draft' && props.canManage) {
			return [
				{
					id: 'submit',
					label: t('expenses.action.submit'),
					icon: 'play',
					disabled: status !== 'idle',
					onSelect: () => void submitDraft(claim.id),
				},
				{
					id: 'delete',
					label: t('expenses.action.delete'),
					icon: 'x',
					tone: 'danger',
					disabled: status !== 'idle',
					onSelect: () => requestDelete(claim),
				},
			];
		}
		if (claim.status === 'submitted' && props.canApprove) {
			return [
				{
					id: 'approve',
					label: t('expenses.action.approve'),
					icon: 'check',
					disabled: status !== 'idle',
					onSelect: () => openDecision(claim, 'approved'),
				},
				{
					id: 'reject',
					label: t('expenses.action.reject'),
					icon: 'x',
					tone: 'danger',
					disabled: status !== 'idle',
					onSelect: () => openDecision(claim, 'rejected'),
				},
			];
		}
		return [];
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('expenses.page.eyebrow')}
			title={t('expenses.page.title')}
			description={t('expenses.page.description')}
		>
			@if (props.canRead) {
				<Button size="sm" onClick={() => void refresh()}>
					<Icon name="refresh" size={14} />
					{t('expenses.action.refresh')}
				</Button>
			}
			@if (props.canManage) {
				<Button size="sm" variant="primary" onClick={openCreate}>
					<Icon name="plus" size={14} />
					{t('expenses.action.new')}
				</Button>
			}
		</PageHeader>
		@if (!props.canRead) {
			<Alert tone="warning">{t('expenses.denied')}</Alert>
		} @else {
			<>
				@if (error && !formOpen && !decisionOpen) {
					<Alert>{error}</Alert>
				}
				<TableCard
					title={t('expenses.table.title')}
					count={t('expenses.table.count', { count: claims.length })}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={statusFilter === 'all' ? 0 : 1}
						label={t('expenses.filters.label')}
					>
						<select
							class="ui-select"
							aria-label={t('expenses.filters.status')}
							value={statusFilter}
							disabled={status !== 'idle'}
							onInput={(event) => changeStatusFilter(
								event.currentTarget.value as ExpenseStatusFilter,
							)}
						>
							<option value="all">{t('expenses.filters.all')}</option>
							<option value="draft">{t('expenses.status.draft')}</option>
							<option value="submitted">{t(
								'expenses.status.submitted',
							)}</option>
							<option value="approved">{t('expenses.status.approved')}</option>
							<option value="rejected">{t('expenses.status.rejected')}</option>
						</select>
					</Filters>}
					caption={t('expenses.table.caption')}
					columns={columns(showActionColumn)}
					rows={claims}
					rowKey={(claim) => claim.id}
					status={status === 'loading' && claims.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('expenses.table.loading')}
					filtered={statusFilter !== 'all'}
					empty={{
						icon: 'file-text',
						title: t('expenses.table.emptyTitle'),
						hint: props.canManage
							? t('expenses.table.emptyManage')
							: t('expenses.table.emptyRead'),
					}}
					emptyFiltered={statusFilter === 'all'
						? undefined
						: {
								icon: 'file-text',
								title: t('expenses.table.emptyFilteredTitle'),
								hint: t('expenses.table.emptyFilteredHint'),
							}}
					actionsLabel={t('expenses.table.actions')}
					actionsWidth="280px"
					actions={showActionColumn ? claimActions : undefined}
					onSelect={(claim) => void openHistory(claim)}
				/>
				<Drawer
					open={formOpen}
					title={t('expenses.drawer.newTitle')}
					subtitle={t('expenses.drawer.newSubtitle')}
					width="lg"
					onClose={closeCreate}
				>
					<ExpenseClaimForm
						key={'expense-form-' + formSession}
						busy={status === 'submitting'}
						error={formError}
						onCancel={closeCreate}
						onSubmit={(event) => void createClaim(event)}
					/>
				</Drawer>
				<Drawer
					open={decisionOpen && decisionClaim !== null}
					title={decision === 'approved'
						? t('expenses.drawer.approveTitle')
						: t('expenses.drawer.rejectTitle')}
					subtitle={t('expenses.drawer.decisionSubtitle')}
					onClose={closeDecision}
				>
					@if (decisionClaim) {
						<ExpenseDecisionForm
							key={'expense-decision-' + decisionSession}
							claim={decisionClaim}
							decision={decision}
							busy={status === 'deciding'}
							error={decisionError}
							onCancel={closeDecision}
							onSubmit={(event) => void decideClaim(event)}
						/>
					}
				</Drawer>
				<ExpenseHistoryDrawer
					open={historyOpen}
					claim={historyClaim}
					entries={historyEntries}
					loading={historyLoading}
					error={historyError}
					onClose={() => {
						setHistoryOpen(false);
						setHistoryClaim(null);
					}}
				/>
				<ConfirmDialog
					open={deleteConfirmOpen && deleteClaim !== null}
					title={t('expenses.delete.title')}
					confirmLabel={t('expenses.delete.confirm')}
					cancelLabel={t('expenses.action.cancel')}
					busy={status === 'deleting'}
					tone="danger"
					onConfirm={() => void deleteDraft()}
					onCancel={closeDelete}
				>{t('expenses.delete.description', {
					name: deleteClaim?.title ?? '',
				})}</ConfirmDialog>
			</>
		}
	</div>
}

export function ExpensesDashboardWidget() @{
	const widgetState = useMemo(() => createExpensesDashboardState(), []);
	const [count, setCount] = useValue(widgetState.state.count);
	const [status, setStatus] = useValue(widgetState.state.status);
	const [error, setError] = useValue(widgetState.state.error);

	useEffect(() => {
		setStatus('loading');
		setError('');
		void loadAwaitingApprovalCount().then(setCount).catch(
			(loadError) => setError(
				loadError instanceof Error
					? loadError.message
					: t('expenses.widget.error'),
			),
		).finally(() => setStatus('idle'));
	}, []);

	<Kpi
		label={t('expenses.widget.label')}
		value={status === 'loading'
			? '…'
			: error
				? t('expenses.widget.unavailable')
				: new Intl.NumberFormat(activeLocale()).format(count)}
		note={error || t('expenses.widget.note')}
		href="/expenses"
		linkLabel={t('expenses.widget.link')}
	/>
}
