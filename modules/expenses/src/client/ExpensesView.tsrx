import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	Drawer,
	EmptyState,
	Icon,
	Kpi,
	PageHeader,
	Tag,
} from '@coreloom/ui';
import { useValue } from 'segment-state';
import type {
	ExpenseClaimCategory,
	ExpenseClaimDecision,
	ExpensesClaim,
} from '../domain/types.ts';
import {
	createExpensesClaim,
	decideExpensesClaim,
	loadAwaitingApprovalCount,
	loadExpensesClaims,
	submitExpensesClaim,
} from './api.ts';
import {
	amountToMinorUnits,
	expenseCategoryLabel,
	expenseStatusLabel,
	expenseStatusTone,
	formatExpenseAmount,
	type ExpenseStatusFilter,
} from './expense-claims.ts';
import {
	createExpensesClientState,
	createExpensesDashboardState,
} from './state.ts';
import { ExpenseClaimForm } from './ExpenseClaimForm.tsrx';
import { ExpenseDecisionForm } from './ExpenseDecisionForm.tsrx';

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

export function ExpensesView(props: ExpensesViewProps) @{
	const viewState = useMemo(() => createExpensesClientState(), []);
	const [claims] = useValue(viewState.state.claims);
	const [statusFilter, setStatusFilter] = useValue(
		viewState.state.statusFilter,
	);
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
					: 'Could not load expense claims.',
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
			setFormError('Amount must use no more than two decimal places.');
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
					: 'Could not create the expense claim.',
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
					: 'Could not submit the expense claim.',
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
					: 'Could not record the decision.',
			);
			setStatus('idle');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow="Employee expenses"
			title="Expense claims"
			description="Record expenses, submit drafts, and review approval decisions."
		>
			@if (props.canRead) {
				<Button size="sm" onClick={() => void refresh()}>
					<Icon name="refresh" size={14} />
					Refresh
				</Button>
			}
			@if (props.canManage) {
				<Button size="sm" variant="primary" onClick={openCreate}>
					<Icon name="plus" size={14} />
					New claim
				</Button>
			}
		</PageHeader>
		@if (!props.canRead) {
			<Alert tone="warning">
				You do not have permission to view expense claims.
			</Alert>
		} @else {
			<>
				@if (error && !formOpen && !decisionOpen) {
					<Alert>{error}</Alert>
				}
				<section class="ui-card">
					<div class="ui-card__head">
						<span class="ui-card__title">
							Claims
							<small>
								{claims.length + (claims.length === 1 ? ' claim' : ' claims')}
							</small>
						</span>
					</div>
					<div class="ui-toolbar">
						<select
							class="ui-select"
							aria-label="Filter claims by status"
							value={statusFilter}
							disabled={status !== 'idle'}
							onInput={(event) => changeStatusFilter(
								event.currentTarget.value as ExpenseStatusFilter,
							)}
						>
							<option value="all">All statuses</option>
							<option value="draft">Draft</option>
							<option value="submitted">Submitted</option>
							<option value="approved">Approved</option>
							<option value="rejected">Rejected</option>
						</select>
					</div>
					@if (status === 'loading') {
						<p class="ui-table__empty">Loading expense claims…</p>
					} @else if (claims.length === 0) {
						<EmptyState
							icon="file-text"
							title={statusFilter === 'all'
								? 'No expense claims yet'
								: `No ${expenseStatusLabel(statusFilter).toLowerCase()} claims`}
						>
							{statusFilter === 'all'
								? props.canManage
									? 'Create the first expense claim for this workspace.'
									: 'No expense claims are available to your account.'
								: 'No claims match the selected status.'}
						</EmptyState>
					} @else {
						<div class="ui-table-wrap">
							<table class="ui-table" aria-label="Expense claims">
								<thead>
									<tr>
										<th>Claim</th>
										<th>Expense date</th>
										<th>Category</th>
										<th class="num">Amount</th>
										<th>Status</th>
										<th class="ui-table__actions">Actions</th>
									</tr>
								</thead>
								<tbody>
									@for (const claim of claims; key claim.id) {
										<tr>
											<td>
												<span class="ui-cell">
													<b>{claim.title}</b>
													<small class="ui-mono">{claim.id}</small>
												</span>
											</td>
											<td class="ui-mono">{claim.expenseDate}</td>
											<td>{expenseCategoryLabel(claim.category)}</td>
											<td class="num">{formatExpenseAmount(
												claim.amountMinor,
												claim.currency,
											)}</td>
											<td>
												<span class="ui-cell">
													<Tag
														tone={expenseStatusTone(claim.status)}
														dot
													>{expenseStatusLabel(claim.status)}</Tag>
													@if (claim.decisionComment) {
														<small>{claim.decisionComment}</small>
													}
												</span>
											</td>
											<td class="ui-table__actions">
												<span class="ui-table__state">
													@if (claim.status === 'draft' && props.canManage) {
														<Button
															size="sm"
															variant="primary"
															disabled={status !== 'idle'}
															onClick={() => void submitDraft(claim.id)}
														>
															Submit
														</Button>
													} @else if (
														claim.status === 'submitted' && props.canApprove
													) {
														<>
															<Button
																size="sm"
																variant="primary"
																disabled={status !== 'idle'}
																onClick={() => openDecision(claim, 'approved')}
															>
																Approve
															</Button>
															<Button
																size="sm"
																variant="danger"
																disabled={status !== 'idle'}
																onClick={() => openDecision(claim, 'rejected')}
															>
																Reject
															</Button>
														</>
													} @else {
														<small>
															{claim.status === 'submitted'
																? 'Awaiting decision'
																: 'No action'}
														</small>
													}
												</span>
											</td>
										</tr>
									}
								</tbody>
							</table>
						</div>
					}
				</section>
				<Drawer
					open={formOpen}
					title="New expense claim"
					subtitle="Saved as draft"
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
					title={decision === 'approved' ? 'Approve claim' : 'Reject claim'}
					subtitle="Manager decision"
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
					: 'Could not load the approval count.',
			),
		).finally(() => setStatus('idle'));
	}, []);

	<Kpi
		label="Awaiting approval"
		value={status === 'loading'
			? '…'
			: error
				? 'Unavailable'
				: String(count)}
		note={error || 'Submitted expense claims waiting for a decision.'}
		href="/expenses"
		linkLabel="Review claims"
	/>
}
