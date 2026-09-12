import { useEffect, useMemo, useState } from 'octane';
import {
	Alert,
	Button,
	EmptyState,
	Filters,
	Icon,
	PageHeader,
	Pagination,
	Select,
	TableCard,
	Tag,
	type TableColumn,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import { useValue } from 'segment-state';
import {
	APPROVAL_STATUSES,
	type ApprovalRequest,
	type ApprovalStatus,
} from '../domain/types.ts';
import {
	ApprovalsApiError,
	approveRequest,
	approvalsErrorMessage,
	cancelRequest,
	loadRequest,
	loadRequests,
	rejectRequest,
	type ApprovalsListScope,
} from './api.ts';
import { ApprovalRequestDrawer } from './ApprovalRequestDrawer.tsrx';
import { statusLabel, statusTone, timestampLabel } from './presentation.ts';
import { refreshPendingCount } from './pending-count.ts';
import { approvalsListing, createApprovalsClientState } from './state.ts';

export interface ApprovalsViewProps {
	readonly csrfToken: string;
	/* Only the scope selector needs this; what a member may do with one request
   is the server's answer, carried on the request it returns. */
	readonly canManage: boolean;
}

const PAGE_SIZES = [10, 25, 50, 100];

function columns(): readonly TableColumn<ApprovalRequest>[] {
	return [
		{
			key: 'status',
			header: t('approvals.column.status'),
			width: '12%',
			value: (item) => item.status,
			cell: (item) =>
				<Tag tone={statusTone(item.status)} dot>{statusLabel(
					item.status,
				)}</Tag>,
		},
		{
			key: 'title',
			header: t('approvals.column.title'),
			width: '26%',
			value: (item) => item.title,
			cell: (item) => <span class="ui-cell">
				<b>{item.title}</b>
				<small class="ui-mono">{item.subjectRef}</small>
			</span>,
		},
		{
			key: 'subjectModule',
			header: t('approvals.column.subjectModule'),
			width: '16%',
			value: (item) => item.subjectModule,
			cell: (item) => <span class="ui-mono">{item.subjectModule}</span>,
		},
		{
			key: 'action',
			header: t('approvals.column.action'),
			width: '14%',
			value: (item) => item.action,
			cell: (item) => <span class="ui-mono">{item.action}</span>,
		},
		{
			key: 'requester',
			header: t('approvals.column.requester'),
			width: '16%',
			value: (item) => item.requesterAccountId,
			cell: (item) => <span class="ui-mono">{item.requesterAccountId}</span>,
		},
		{
			key: 'expiresAt',
			header: t('approvals.column.expiresAt'),
			width: '16%',
			value: (item) => String(item.expiresAt),
			cell: (item) => timestampLabel(item.expiresAt),
		},
	];
}

export function ApprovalsView(props: ApprovalsViewProps) @{
	const client = useMemo(() => createApprovalsClientState(), []);
	const [requests] = useValue(client.state.requests);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [scope] = useValue(client.state.scope);
	const [statusFilter] = useValue(client.state.statusFilter);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [selected, setSelected] = useValue(client.state.selected);
	const [comment, setComment] = useValue(client.state.comment);
	const [pageIndex, setPageIndex] = useState(0);
	const [pageSize, setPageSize] = useState(25);
	const listing = approvalsListing(requests, scope, statusFilter, status);

	const refresh = async (
		nextScope: ApprovalsListScope,
		nextStatus: ApprovalStatus | '',
	) => {
		setStatus('loading');
		setError('');
		try {
			const loaded = await loadRequests({
				scope: nextScope,
				status: nextStatus,
			});
			client.store.act((transaction) => {
				transaction.set(client.state.requests, loaded);
				transaction.set(client.state.status, 'idle');
			}, 'approvals/loaded');
		} catch (loadError) {
			setError(approvalsErrorMessage(loadError, 'approvals.error.load'));
			setStatus(
				loadError instanceof ApprovalsApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void refresh('decidable', '');
		void refreshPendingCount();
	}, []);

	const applyScope = (next: ApprovalsListScope) => {
		client.store.act((transaction) => {
			transaction.set(client.state.scope, next);
			transaction.set(client.state.selected, null);
		}, 'approvals/scope-filter');
		setPageIndex(0);
		void refresh(next, statusFilter);
	};

	const applyStatus = (next: ApprovalStatus | '') => {
		client.store.act((transaction) => {
			transaction.set(client.state.statusFilter, next);
			transaction.set(client.state.selected, null);
		}, 'approvals/status-filter');
		setPageIndex(0);
		void refresh(scope, next);
	};

	const open = async (request: ApprovalRequest) => {
		setError('');
		try {
			const detail = await loadRequest(request.id);
			client.store.act((transaction) => {
				transaction.set(client.state.selected, detail);
				transaction.set(client.state.selectedId, detail.request.id);
				transaction.set(client.state.comment, '');
			}, 'approvals/opened');
		} catch (openError) {
			setError(approvalsErrorMessage(openError, 'approvals.error.load'));
		}
	};

	/* Every decision replaces the one row it changed, so the list the member is
   reading does not jump, and the badge follows the same change. */
	const mutate = async (
		run: () => Promise<Awaited<ReturnType<typeof loadRequest>>>,
	) => {
		setStatus('submitting');
		setError('');
		try {
			const detail = await run();
			client.store.act((transaction) => {
				transaction.set(
					client.state.requests,
					requests.map(
						(current) => current.id === detail.request.id
							? detail.request
							: current,
					),
				);
				transaction.set(client.state.selected, detail);
				transaction.set(client.state.comment, '');
				transaction.set(client.state.status, 'idle');
			}, 'approvals/decided');
			void refreshPendingCount();
		} catch (mutationError) {
			setError(approvalsErrorMessage(mutationError, 'approvals.error.decide'));
			setStatus('idle');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('approvals.common.workspace')}
			title={t('approvals.inbox.title')}
			description={t('approvals.inbox.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => void refresh(scope, statusFilter)}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('approvals.common.refreshing')
					: t('approvals.common.refresh')}
			</Button>
		</PageHeader>
		@if (listing.screen === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('approvals.common.accessDenied')}>{t(
					'approvals.inbox.denied',
				)}</EmptyState>
			</section>
		} @else if (listing.screen === 'error') {
			<section class="ui-card">
				<EmptyState icon="alert" title={t('approvals.inbox.error.title')}>
					{error || t('approvals.inbox.error.hint')}
				</EmptyState>
			</section>
		} @else {
			<>
				@if (error) {
					<Alert>{error}</Alert>
				}
				<TableCard
					title={t('approvals.inbox.table.title')}
					count={t('approvals.inbox.table.count', {
						count: listing.visible.length,
					})}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={listing.activeFilters}
						label={t('approvals.common.filters')}
					>
						<Select
							id="approvals-scope"
							label={t('approvals.filter.scope')}
							value={scope}
							options={[
								{
									value: 'decidable',
									label: t('approvals.filter.scopeDecidable'),
								},
								{ value: 'mine', label: t('approvals.filter.scopeMine') },
								...(props.canManage
									? [
											{
												value: 'all',
												label: t('approvals.filter.scopeAll'),
											},
										]
									: []),
							]}
							onChange={(value) => applyScope(value as ApprovalsListScope)}
						/>
						<Select
							id="approvals-status"
							label={t('approvals.filter.status')}
							value={statusFilter}
							options={[
								{ value: '', label: t('approvals.filter.allStatuses') },
								...APPROVAL_STATUSES.map(
									(entry) => ({
										value: entry,
										label: statusLabel(entry),
									}),
								),
							]}
							onChange={(value) => applyStatus(value as ApprovalStatus | '')}
						/>
					</Filters>}
					caption={t('approvals.inbox.table.caption')}
					columns={columns()}
					rows={listing.visible}
					rowKey={(item) => item.id}
					sorting
					onSortingChange={() => setPageIndex(0)}
					pagination={{ pageIndex, pageSize, onPageChange: setPageIndex }}
					after={<Pagination
						pageIndex={pageIndex}
						pageSize={pageSize}
						totalRows={listing.visible.length}
						pageSizes={PAGE_SIZES}
						onPageChange={setPageIndex}
						onPageSizeChange={(size) => {
							setPageSize(size);
							setPageIndex(0);
						}}
						label={t('approvals.pagination.label')}
						previousLabel={t('approvals.pagination.previous')}
						nextLabel={t('approvals.pagination.next')}
						pageSizeLabel={t('approvals.pagination.size')}
						summary={(range) => t('approvals.pagination.summary', {
							page: range.pageIndex + 1,
							pages: range.pageCount,
							from: range.from,
							to: range.to,
							total: range.totalRows,
						})}
					/>}
					status={status === 'loading' && requests.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('approvals.inbox.table.loading')}
					filtered={listing.filtered}
					empty={{
						icon: 'check',
						title: t('approvals.inbox.empty.title'),
						hint: t('approvals.inbox.empty.hint'),
					}}
					emptyFiltered={{
						icon: 'filter',
						title: t('approvals.inbox.emptyFiltered.title'),
						hint: t('approvals.inbox.emptyFiltered.hint'),
					}}
					onSelect={(item) => void open(item)}
					selectedKey={selected?.request.id ?? undefined}
					noteIcon="shield"
					note={t('approvals.inbox.note')}
				/>
			</>
		}
		<ApprovalRequestDrawer
			detail={selected}
			comment={comment}
			busy={status === 'submitting'}
			canDecide={selected?.viewer.canDecide === true}
			canCancel={selected?.viewer.canCancel === true}
			onComment={setComment}
			onApprove={() => {
				const id = selected?.request.id;
				if (id) {
					void mutate(() => approveRequest(id, comment, props.csrfToken));
				}
			}}
			onReject={() => {
				const id = selected?.request.id;
				if (id) {
					void mutate(() => rejectRequest(id, comment, props.csrfToken));
				}
			}}
			onCancel={() => {
				const id = selected?.request.id;
				if (id) void mutate(() => cancelRequest(id, props.csrfToken));
			}}
			onClose={() => setSelected(null)}
		/>
	</div>
}
