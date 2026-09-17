import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	CellCode,
	CellStack,
	CellTag,
	CellText,
	CellTime,
	ConfirmDialog,
	EmptyState,
	Filters,
	Icon,
	PageHeader,
	Pagination,
	Select,
	TableCard,
	ToastHost,
	toasts,
	type TableColumn,
	type TableSort,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import { useValue } from 'segment-state';
import {
	APPROVAL_STATUSES,
	type ApprovalListDirection,
	type ApprovalRequest,
	type ApprovalStatus,
} from '../domain/types.ts';
import {
	ApprovalsApiError,
	approveRequest,
	approvalsErrorMessage,
	cancelRequest,
	decideRequests,
	loadRequest,
	loadRequests,
	rejectRequest,
	type ApprovalsListScope,
	type BulkDecision,
} from './api.ts';
import { ApprovalRequestDrawer } from './ApprovalRequestDrawer.tsrx';
import { statusLabel, statusTone } from './presentation.ts';
import { refreshPendingCount } from './pending-count.ts';
import {
	approvalsListing,
	canOpenPage,
	createApprovalsClientState,
	decidableIds,
	decideOutcomeCounts,
	FIRST_PAGE,
	pageCursor,
	recordNextCursor,
	type CursorStack,
} from './state.ts';

export interface ApprovalsViewProps {
	readonly csrfToken: string;
	/* Only the scope selector needs this; what a member may do with one request
   is the server's answer, carried on the request it returns. */
	readonly canManage: boolean;
	/* Whether the principal holds the decide permission; which rows they may
   actually decide is still the server's answer, per request. */
	readonly canDecide: boolean;
}

const PAGE_SIZES = [10, 25, 50, 100];

/* The server orders by createdAt alone, so that is the one column with a
   sortable header; its `value` is the flag, the server does the ordering. */
function columns(): readonly TableColumn<ApprovalRequest>[] {
	return [
		{
			key: 'title',
			header: t('approvals.column.title'),
			width: 'auto',
			cell: (item) =>
				<CellStack
					primary={item.title}
					secondary={item.subjectRef}
					secondaryMono
				/>,
		},
		{
			key: 'status',
			header: t('approvals.column.status'),
			width: '130px',
			cell: (item) =>
				<CellTag
					tone={statusTone(item.status)}
					dot
					label={statusLabel(item.status)}
				/>,
		},
		{
			key: 'subjectModule',
			header: t('approvals.column.subjectModule'),
			width: '160px',
			priority: 2,
			cell: (item) => <CellText value={item.subjectModule} mono />,
		},
		{
			key: 'action',
			header: t('approvals.column.action'),
			width: '180px',
			priority: 2,
			cell: (item) => <CellText value={item.action} mono />,
		},
		{
			key: 'requester',
			header: t('approvals.column.requester'),
			width: '160px',
			priority: 3,
			cell: (item) => <CellCode value={item.requesterAccountId} />,
		},
		{
			key: 'createdAt',
			header: t('approvals.column.createdAt'),
			width: '170px',
			priority: 2,
			value: (item) => item.createdAt,
			cell: (item) => <CellTime value={item.createdAt} />,
		},
		{
			key: 'expiresAt',
			header: t('approvals.column.expiresAt'),
			width: '170px',
			priority: 3,
			cell: (item) => <CellTime value={item.expiresAt} />,
		},
	];
}

/** Everything one page request depends on. */
interface PageTarget {
	readonly scope: ApprovalsListScope;
	readonly status: ApprovalStatus | '';
	readonly direction: ApprovalListDirection;
	readonly pageIndex: number;
	readonly pageSize: number;
	readonly cursors: CursorStack;
}

export function ApprovalsView(props: ApprovalsViewProps) @{
	const client = useMemo(() => createApprovalsClientState(), []);
	const [requests] = useValue(client.state.requests);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [scope] = useValue(client.state.scope);
	const [statusFilter] = useValue(client.state.statusFilter);
	const [direction] = useValue(client.state.direction);
	const [pageIndex] = useValue(client.state.pageIndex);
	const [pageSize] = useValue(client.state.pageSize);
	const [cursors] = useValue(client.state.cursors);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [selected, setSelected] = useValue(client.state.selected);
	const [comment, setComment] = useValue(client.state.comment);
	const [selectedIds, setSelectedIds] = useValue(client.state.selectedIds);
	const [confirmDecision, setConfirmDecision] = useValue(
		client.state.confirmDecision,
	);
	const [bulkComment, setBulkComment] = useValue(client.state.bulkComment);
	const decidable = decidableIds(requests, selectedIds);
	const listing = approvalsListing(requests, scope, statusFilter, status);
	const sortingState = useMemo<readonly TableSort[]>(
		() => [
			{ key: 'createdAt', desc: direction === 'desc' },
		],
		[direction],
	);
	const hasMore = canOpenPage(cursors, pageIndex + 1);

	const load = async (target: PageTarget) => {
		setStatus('loading');
		setError('');
		try {
			const page = await loadRequests({
				scope: target.scope,
				status: target.status,
				sort: 'createdAt',
				direction: target.direction,
				limit: target.pageSize,
				cursor: pageCursor(target.cursors, target.pageIndex),
			});
			client.store.act((transaction) => {
				transaction.set(client.state.requests, page.items);
				transaction.set(
					client.state.cursors,
					recordNextCursor(target.cursors, target.pageIndex, page.nextCursor),
				);
				/* A new listing is a new set of rows; nothing checked before it is
   still selected. */
				transaction.set(client.state.selectedIds, new Set());
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

	const current = (): PageTarget => ({
		scope,
		status: statusFilter,
		direction,
		pageIndex,
		pageSize,
		cursors,
	});

	/* A filter, sort or page size change names a different list, so the walk
   starts again from its first page. */
	const restart = (
		change: Partial<
			Pick<PageTarget, 'scope' | 'status' | 'direction' | 'pageSize'>
		>,
		label: string,
	) => {
		const target: PageTarget = {
			...current(),
			...change,
			pageIndex: 0,
			cursors: FIRST_PAGE,
		};
		client.store.act((transaction) => {
			transaction.set(client.state.scope, target.scope);
			transaction.set(client.state.statusFilter, target.status);
			transaction.set(client.state.direction, target.direction);
			transaction.set(client.state.pageSize, target.pageSize);
			transaction.set(client.state.pageIndex, 0);
			transaction.set(client.state.cursors, FIRST_PAGE);
			transaction.set(client.state.selected, null);
			transaction.set(client.state.selectedIds, new Set());
		}, label);
		void load(target);
	};

	const goToPage = (next: number) => {
		if (next === pageIndex || !canOpenPage(cursors, next)) return;
		client.store.act((transaction) => {
			transaction.set(client.state.pageIndex, next);
			transaction.set(client.state.selected, null);
			transaction.set(client.state.selectedIds, new Set());
		}, 'approvals/page');
		void load({ ...current(), pageIndex: next });
	};

	const applySorting = (sorts: readonly TableSort[]) => {
		const next: ApprovalListDirection =
			sorts[0]?.desc ?? true ? 'desc' : 'asc';
		if (next !== direction) restart({ direction: next }, 'approvals/sort');
	};

	useEffect(() => {
		void load(current());
		void refreshPendingCount();
	}, []);

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

	/* One decision per selected row through the single decision path; the
   listing is read again because a resolved row may leave the scope on screen. */
	const decideSelected = async () => {
		const decision = confirmDecision;
		const ids = decidable;
		setConfirmDecision(null);
		if (!decision || ids.length === 0) return;
		setStatus('submitting');
		setError('');
		try {
			const outcomes = await decideRequests(
				ids,
				decision,
				bulkComment,
				props.csrfToken,
			);
			setBulkComment('');
			await load(current());
			toasts.success(
				t('approvals.notice.decidedMany', decideOutcomeCounts(outcomes)),
			);
			void refreshPendingCount();
		} catch (decideError) {
			setError(
				approvalsErrorMessage(decideError, 'approvals.error.decideMany'),
			);
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
				onClick={() => void load(current())}
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
							onChange={(value) => restart(
								{ scope: value as ApprovalsListScope },
								'approvals/scope-filter',
							)}
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
							onChange={(value) => restart(
								{ status: value as ApprovalStatus | '' },
								'approvals/status-filter',
							)}
						/>
					</Filters>}
					caption={t('approvals.inbox.table.caption')}
					columns={columns()}
					rows={listing.visible}
					rowKey={(item) => item.id}
					mode="server"
					sorting
					sortingState={sortingState}
					onSortingChange={applySorting}
					pagination={{ pageIndex, pageSize, onPageChange: goToPage, hasMore }}
					after={<Pagination
						pageIndex={pageIndex}
						pageSize={pageSize}
						hasMore={hasMore}
						pageSizes={PAGE_SIZES}
						onPageChange={goToPage}
						onPageSizeChange={(size) => restart(
							{ pageSize: size },
							'approvals/page-size',
						)}
						label={t('approvals.pagination.label')}
						previousLabel={t('approvals.pagination.previous')}
						nextLabel={t('approvals.pagination.next')}
						pageSizeLabel={t('approvals.pagination.size')}
						summary={(page) => t('approvals.pagination.summary', {
							page: page.pageIndex + 1,
							from: page.from,
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
					selection={props.canDecide
						? {
								selectedKeys: selectedIds,
								onSelectionChange: setSelectedIds,
								label: t('approvals.selection.label'),
								rowLabel: (item) => t('approvals.selection.rowLabel', {
									title: item.title,
								}),
								selectable: (item) => item.status === 'pending',
								clearLabel: t('approvals.selection.clear'),
							}
						: undefined}
					bulkActions={props.canDecide
						? [
								{
									id: 'approve-selected',
									label: t('approvals.action.approveSelected'),
									icon: 'check',
									disabled: decidable.length === 0 || status === 'submitting',
									reason: decidable.length === 0
										? t('approvals.action.selectedRefused')
										: undefined,
									onSelect: () => setConfirmDecision('approve'),
								},
								{
									id: 'reject-selected',
									label: t('approvals.action.rejectSelected'),
									icon: 'x',
									tone: 'danger',
									disabled: decidable.length === 0 || status === 'submitting',
									reason: decidable.length === 0
										? t('approvals.action.selectedRefused')
										: undefined,
									onSelect: () => setConfirmDecision('reject'),
								},
							]
						: undefined}
					selectionSummary={(count) => t('approvals.selection.summary', {
						count,
					})}
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
		<ConfirmDialog
			open={confirmDecision !== null}
			title={confirmDecision === 'reject'
				? t('approvals.decideMany.rejectTitle')
				: t('approvals.decideMany.approveTitle')}
			confirmLabel={confirmDecision === 'reject'
				? t('approvals.action.rejectSelected')
				: t('approvals.action.approveSelected')}
			tone={confirmDecision === 'reject' ? 'danger' : 'primary'}
			busy={status === 'submitting'}
			onConfirm={() => void decideSelected()}
			onCancel={() => setConfirmDecision(null)}
		>
			<p>{t('approvals.decideMany.description', {
				count: decidable.length,
			})}</p>
			<label class="ui-field">
				<span class="ui-label">{t('approvals.request.comment')}</span>
				<textarea
					class="ui-textarea"
					rows={3}
					maxLength={2000}
					value={bulkComment}
					disabled={status === 'submitting'}
					onInput={(event: Event) => setBulkComment(
						(event.target as HTMLTextAreaElement).value,
					)}
				/>
			</label>
		</ConfirmDialog>
		<ToastHost
			label={t('approvals.common.messages')}
			closeLabel={t('approvals.common.close')}
		/>
	</div>
}
