import { useEffect, useMemo, useState } from 'octane';
import {
	Alert,
	Button,
	DateField,
	Drawer,
	EmptyState,
	Filters,
	FormField,
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
	HOLD_SCOPE_KINDS,
	HOLD_STATUSES,
	type AuditLegalHold,
	type HoldScopeKind,
	type HoldStatus,
} from '../domain/types.ts';
import {
	AuditApiError,
	auditErrorMessage,
	liftHold,
	loadHolds,
	placeHold,
} from './api.ts';
import {
	holdRangeDetail,
	holdScopeDetail,
	holdScopeLabel,
	holdStatusLabel,
	holdStatusTone,
	timestampLabel,
} from './presentation.ts';
import { createHoldsClientState } from './state.ts';

export interface HoldsViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

const PAGE_SIZES = [10, 25, 50, 100];
const REASON_LIMIT = 400;

function columns(): readonly TableColumn<AuditLegalHold>[] {
	return [
		{
			key: 'placedAt',
			header: t('audit.holds.column.placedAt'),
			width: '14%',
			value: (hold) => hold.placedAt,
			cell: (hold) => timestampLabel(hold.placedAt),
		},
		{
			key: 'scopeKind',
			header: t('audit.holds.column.scope'),
			width: '18%',
			value: (hold) => hold.scopeKind,
			cell: (hold) => <span class="ui-cell">
				<b>{holdScopeLabel(hold.scopeKind)}</b>
				<small class="ui-cell__muted ui-mono">{holdRangeDetail(hold)}</small>
			</span>,
		},
		{
			key: 'accountId',
			header: t('audit.holds.column.accountId'),
			width: '14%',
			value: (hold) => hold.accountId ?? '',
			cell: (hold) => hold.accountId === null
				? <span class="ui-cell__muted">{t('audit.common.none')}</span>
				: <span class="ui-mono">{hold.accountId}</span>,
		},
		{
			key: 'classId',
			header: t('audit.holds.column.classId'),
			width: '16%',
			value: (hold) => hold.classId ?? '',
			cell: (hold) => hold.classId === null
				? <span class="ui-cell__muted">{t('audit.common.none')}</span>
				: <span class="ui-mono">{hold.classId}</span>,
		},
		{
			key: 'reason',
			header: t('audit.holds.column.reason'),
			width: '18%',
			value: (hold) => hold.reason,
			cell: (hold) => hold.reason,
		},
		{
			key: 'placedBy',
			header: t('audit.holds.column.placedBy'),
			width: '12%',
			value: (hold) => hold.placedBy,
			cell: (hold) => <span class="ui-mono">{hold.placedBy}</span>,
		},
		{
			key: 'status',
			header: t('audit.holds.column.status'),
			width: '12%',
			value: (hold) => hold.status,
			cell: (hold) =>
				<Tag tone={holdStatusTone(hold.status)} dot>{holdStatusLabel(
					hold.status,
				)}</Tag>,
		},
	];
}

export function HoldsView(props: HoldsViewProps) @{
	const client = useMemo(() => createHoldsClientState(), []);
	const [holds] = useValue(client.state.holds);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [statusFilter, setStatusFilter] = useValue(client.state.statusFilter);
	const [scopeFilter, setScopeFilter] = useValue(client.state.scopeFilter);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [placing, setPlacing] = useValue(client.state.placing);
	const [lifting, setLifting] = useValue(client.state.lifting);
	const [formScope, setFormScope] = useValue(client.state.formScope);
	const [formAccountId, setFormAccountId] = useValue(
		client.state.formAccountId,
	);
	const [formClassId, setFormClassId] = useValue(client.state.formClassId);
	const [formFrom, setFormFrom] = useValue(client.state.formFrom);
	const [formTo, setFormTo] = useValue(client.state.formTo);
	const [formReason, setFormReason] = useValue(client.state.formReason);
	const [formError, setFormError] = useValue(client.state.formError);
	const [pageIndex, setPageIndex] = useState(0);
	const [pageSize, setPageSize] = useState(25);
	const locale = activeLocale();
	const term = query.trim().toLocaleLowerCase(locale);
	const visible = holds.filter(
		(hold) =>
			(scopeFilter === '' || hold.scopeKind === scopeFilter) &&
				(term === '' || hold.reason.toLocaleLowerCase(locale).includes(term) ||
					(hold.accountId ?? '').toLocaleLowerCase(locale).includes(term) ||
					(hold.classId ?? '').toLocaleLowerCase(locale).includes(term)),
	);
	const filterCount =
		(statusFilter === '' ? 0 : 1) + (scopeFilter === '' ? 0 : 1);
	const filtered = filterCount > 0 || term !== '';

	const refresh = async (nextStatus: HoldStatus | '') => {
		setStatus('loading');
		setError('');
		try {
			const loaded = await loadHolds(nextStatus);
			client.store.act((transaction) => {
				transaction.set(client.state.holds, loaded);
				transaction.set(client.state.status, 'idle');
			}, 'audit/holds-loaded');
		} catch (loadError) {
			setError(auditErrorMessage(loadError, 'audit.holds.error.load'));
			setStatus(
				loadError instanceof AuditApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void refresh('');
	}, []);

	const openPlace = () => {
		client.store.act((transaction) => {
			transaction.set(client.state.placing, true);
			transaction.set(client.state.formScope, 'account');
			transaction.set(client.state.formAccountId, '');
			transaction.set(client.state.formClassId, '');
			transaction.set(client.state.formFrom, '');
			transaction.set(client.state.formTo, '');
			transaction.set(client.state.formReason, '');
			transaction.set(client.state.formError, '');
		}, 'audit/hold-form-opened');
	};

	const openLift = (hold: AuditLegalHold) => {
		client.store.act((transaction) => {
			transaction.set(client.state.lifting, hold);
			transaction.set(client.state.formReason, '');
			transaction.set(client.state.formError, '');
		}, 'audit/hold-lift-opened');
	};

	const dateValue = (value: string) => {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	};

	const submitPlace = async () => {
		const reason = formReason.trim();
		if (reason === '' || reason.length > REASON_LIMIT) {
			setFormError(t('audit.holds.form.reasonInvalid'));
			return;
		}
		if (formScope === 'account' && formAccountId.trim() === '') {
			setFormError(t('audit.holds.form.accountRequired'));
			return;
		}
		if (formScope === 'data-class' && formClassId.trim() === '') {
			setFormError(t('audit.holds.form.classRequired'));
			return;
		}
		if (
			formScope === 'date-range' &&
				(dateValue(formFrom) === null || dateValue(formTo) === null)
		) {
			setFormError(t('audit.holds.form.rangeRequired'));
			return;
		}
		setStatus('submitting');
		setFormError('');
		try {
			await placeHold(
				{
					scopeKind: formScope,
					accountId: formAccountId.trim() === '' ? null : formAccountId.trim(),
					classId: formClassId.trim() === '' ? null : formClassId.trim(),
					fromAt: dateValue(formFrom),
					toAt: dateValue(formTo),
					reason,
				},
				props.csrfToken,
			);
			setPlacing(false);
			await refresh(statusFilter);
			toasts.success(t('audit.holds.notice.placed'));
		} catch (saveError) {
			setFormError(auditErrorMessage(saveError, 'audit.holds.error.place'));
			setStatus('idle');
		}
	};

	const submitLift = async () => {
		const hold = lifting;
		const reason = formReason.trim();
		if (!hold) return;
		if (reason === '' || reason.length > REASON_LIMIT) {
			setFormError(t('audit.holds.form.reasonInvalid'));
			return;
		}
		setStatus('submitting');
		setFormError('');
		try {
			await liftHold({ id: hold.id, reason }, props.csrfToken);
			setLifting(null);
			await refresh(statusFilter);
			toasts.success(t('audit.holds.notice.lifted'));
		} catch (saveError) {
			setFormError(auditErrorMessage(saveError, 'audit.holds.error.lift'));
			setStatus('idle');
		}
	};

	const rowActions = (hold: AuditLegalHold): readonly TableAction[] =>
		props.canManage && hold.status === 'active'
			? [
					{
						id: 'lift',
						label: t('audit.holds.action.lift'),
						icon: 'check',
						onSelect: () => openLift(hold),
					},
				]
			: [];

	<div class="ui-view">
		<PageHeader
			eyebrow={t('audit.common.administration')}
			title={t('audit.holds.title')}
			description={t('audit.holds.description')}
		>
			@if (props.canManage) {
				<Button
					size="sm"
					variant="primary"
					disabled={status === 'denied'}
					onClick={() => openPlace()}
				>
					<Icon name="plus" size={14} />
					{t('audit.holds.action.place')}
				</Button>
			}
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => void refresh(statusFilter)}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('audit.common.refreshing')
					: t('audit.common.refresh')}
			</Button>
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('audit.common.accessDenied')}>{t(
					'audit.holds.denied',
				)}</EmptyState>
			</section>
		} @else {
			<>
				@if (error) {
					<Alert>{error}</Alert>
				}
				<TableCard
					title={t('audit.holds.table.title')}
					count={t('audit.holds.table.count', { count: visible.length })}
					search={<SearchField
						value={query}
						placeholder={t('audit.holds.search.placeholder')}
						label={t('audit.holds.search.label')}
						onInput={(value) => {
							setQuery(value);
							setPageIndex(0);
						}}
					/>}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={filterCount}
						label={t('audit.common.filters')}
					>
						<Select
							id="audit-holds-status"
							label={t('audit.holds.filter.status')}
							value={statusFilter}
							options={[
								{ value: '', label: t('audit.holds.filter.allStatuses') },
								...HOLD_STATUSES.map(
									(entry) => ({
										value: entry,
										label: holdStatusLabel(entry),
									}),
								),
							]}
							onChange={(value) => {
								const next = value as HoldStatus | '';
								setStatusFilter(next);
								setPageIndex(0);
								void refresh(next);
							}}
						/>
						<Select
							id="audit-holds-scope"
							label={t('audit.holds.filter.scope')}
							value={scopeFilter}
							options={[
								{ value: '', label: t('audit.holds.filter.allScopes') },
								...HOLD_SCOPE_KINDS.map(
									(entry) => ({
										value: entry,
										label: holdScopeLabel(entry),
									}),
								),
							]}
							onChange={(value) => {
								setScopeFilter(value as HoldScopeKind | '');
								setPageIndex(0);
							}}
						/>
					</Filters>}
					caption={t('audit.holds.table.caption')}
					columns={columns()}
					rows={visible}
					rowKey={(hold) => hold.id}
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
						label={t('audit.pagination.label')}
						previousLabel={t('audit.pagination.previous')}
						nextLabel={t('audit.pagination.next')}
						pageSizeLabel={t('audit.pagination.size')}
						summary={(range) => t('audit.pagination.summary', {
							page: range.pageIndex + 1,
							pages: range.pageCount,
							from: range.from,
							to: range.to,
							total: range.totalRows,
						})}
					/>}
					status={status === 'loading' && holds.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('audit.holds.table.loading')}
					filtered={filtered}
					empty={{
						icon: 'shield',
						title: t('audit.holds.empty.title'),
						hint: t('audit.holds.empty.hint'),
					}}
					emptyFiltered={{
						icon: 'search',
						title: t('audit.holds.emptyFiltered.title'),
						hint: t('audit.holds.emptyFiltered.hint'),
					}}
					actions={rowActions}
					actionsLabel={t('audit.common.actions')}
					noteIcon="shield"
					note={t('audit.holds.note')}
				/>
			</>
		}
		<Drawer
			open={placing}
			title={t('audit.holds.form.placeTitle')}
			subtitle={t('audit.holds.form.placeSubtitle')}
			onClose={() => setPlacing(false)}
		>
			<form
				class="ui-drawer__form"
				onSubmit={(event: Event) => {
					event.preventDefault();
					void submitPlace();
				}}
			>
				<div class="ui-drawer__body">
					@if (formError) {
						<Alert>{formError}</Alert>
					}
					<div class="ui-form">
						<Select
							id="audit-hold-scope"
							label={t('audit.holds.form.scope')}
							value={formScope}
							options={HOLD_SCOPE_KINDS.map(
								(scope) => ({ value: scope, label: holdScopeLabel(scope) }),
							)}
							help={t('audit.holds.form.scopeHelp')}
							onChange={(value) => setFormScope(value as HoldScopeKind)}
						/>
						@if (formScope !== 'workspace') {
							<>
								<div class="ui-form__row">
									<FormField
										label={t('audit.holds.form.account')}
										required={formScope === 'account'}
										help={t('audit.holds.form.accountHelp')}
									>
										<input
											class="ui-input ui-mono"
											type="text"
											maxLength={64}
											value={formAccountId}
											onInput={(event: Event) => setFormAccountId(
												(event.target as HTMLInputElement).value,
											)}
										/>
									</FormField>
									<FormField
										label={t('audit.holds.form.class')}
										required={formScope === 'data-class'}
										help={t('audit.holds.form.classHelp')}
									>
										<input
											class="ui-input ui-mono"
											type="text"
											maxLength={96}
											value={formClassId}
											onInput={(event: Event) => setFormClassId(
												(event.target as HTMLInputElement).value,
											)}
										/>
									</FormField>
								</div>
								<div class="ui-form__row">
									<DateField
										id="audit-hold-from"
										label={t('audit.holds.form.from')}
										value={formFrom}
										required={formScope === 'date-range'}
										onChange={(value) => setFormFrom(value)}
									/>
									<DateField
										id="audit-hold-to"
										label={t('audit.holds.form.to')}
										value={formTo}
										required={formScope === 'date-range'}
										onChange={(value) => setFormTo(value)}
									/>
								</div>
							</>
						}
						<FormField
							label={t('audit.holds.form.reason')}
							required
							help={t('audit.holds.form.reasonHelp')}
						>
							<textarea
								class="ui-textarea"
								rows={3}
								maxLength={REASON_LIMIT}
								value={formReason}
								onInput={(event: Event) => setFormReason(
									(event.target as HTMLTextAreaElement).value,
								)}
							/>
						</FormField>
					</div>
				</div>
				<div class="ui-drawer__foot">
					<small>{t('audit.holds.form.constraint')}</small>
					<div class="ui-form__actions">
						<Button type="button" onClick={() => setPlacing(false)}>{t(
							'audit.common.close',
						)}</Button>
						<Button
							variant="primary"
							type="submit"
							disabled={status === 'submitting'}
						>
							{status === 'submitting'
								? t('audit.common.saving')
								: t('audit.holds.action.place')}
						</Button>
					</div>
				</div>
			</form>
		</Drawer>
		<Drawer
			open={lifting !== null}
			title={t('audit.holds.form.liftTitle')}
			subtitle={lifting === null ? '' : holdScopeDetail(lifting)}
			onClose={() => setLifting(null)}
		>
			<form
				class="ui-drawer__form"
				onSubmit={(event: Event) => {
					event.preventDefault();
					void submitLift();
				}}
			>
				<div class="ui-drawer__body">
					@if (formError) {
						<Alert>{formError}</Alert>
					}
					<div class="ui-form">
						<FormField
							label={t('audit.holds.form.liftReason')}
							required
							help={t('audit.holds.form.liftReasonHelp')}
						>
							<textarea
								class="ui-textarea"
								rows={3}
								maxLength={REASON_LIMIT}
								value={formReason}
								onInput={(event: Event) => setFormReason(
									(event.target as HTMLTextAreaElement).value,
								)}
							/>
						</FormField>
					</div>
				</div>
				<div class="ui-drawer__foot">
					<small>{t('audit.holds.form.liftConstraint')}</small>
					<div class="ui-form__actions">
						<Button type="button" onClick={() => setLifting(null)}>{t(
							'audit.common.close',
						)}</Button>
						<Button
							variant="primary"
							type="submit"
							disabled={status === 'submitting'}
						>
							{status === 'submitting'
								? t('audit.common.saving')
								: t('audit.holds.action.lift')}
						</Button>
					</div>
				</div>
			</form>
		</Drawer>
		<ToastHost
			label={t('audit.common.messages')}
			closeLabel={t('audit.common.close')}
		/>
	</div>
}
