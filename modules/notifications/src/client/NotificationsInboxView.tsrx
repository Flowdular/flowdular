import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	CellMuted,
	CellStack,
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
	Select,
	TableCard,
	Tag,
	ToastHost,
	toasts,
	type TableAction,
	type TableColumn,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import { useValue } from 'segment-state';
import {
	INBOX_STATUSES,
	NOTIFICATION_KINDS,
	type InboxTransition,
	type NotificationKind,
	type NotificationsInbox,
	type NotificationsInboxStatus,
} from '../domain/types.ts';
import {
	archiveInboxItem,
	loadInbox,
	markInboxRead,
	markInboxUnread,
	NotificationsApiError,
	notificationsErrorMessage,
	transitionInboxItems,
} from './api.ts';
import { FactList } from './FactList.tsrx';
import {
	inboxActiveFilters,
	inboxRowActions,
	selectedInboxItem,
	type InboxRowAction,
} from './inbox.ts';
import {
	inboxStatusLabel,
	inboxStatusTone,
	isoTimestampLabel,
	kindLabel,
} from './presentation.ts';
import {
	createInboxClientState,
	FIRST_PAGE,
	pageCursor,
	pageLoaded,
	transitionableIds,
	transitionOutcomeCounts,
	type CursorStack,
} from './state.ts';
import { refreshUnreadCount } from './unread-count.ts';

export interface NotificationsInboxViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

const PAGE_SIZES = [10, 25, 50, 100];

/** One page request: the filters, the page and the cursors that reach it. */
interface InboxRequest {
	readonly status: NotificationsInboxStatus | '';
	readonly kind: NotificationKind | '';
	readonly pageIndex: number;
	readonly pageSize: number;
	readonly pages: CursorStack;
}

/* Two row actions, and the longer locale sets the width: the Polish read state
   label does not fit the 280 px the shared column defaults to. */
const INBOX_ACTIONS_WIDTH = '320px';

function columns(): readonly TableColumn<NotificationsInbox>[] {
	return [
		{
			key: 'title',
			header: t('notifications.inbox.column.title'),
			width: 'auto',
			cell: (item) =>
				<CellStack
					primary={item.title}
					secondary={item.sourceRef}
					secondaryMono
				/>,
		},
		{
			key: 'status',
			header: t('notifications.inbox.column.status'),
			width: '120px',
			cell: (item) =>
				<CellTag
					tone={inboxStatusTone(item.status)}
					dot
					label={inboxStatusLabel(item.status)}
				/>,
		},
		{
			key: 'kind',
			header: t('notifications.inbox.column.kind'),
			width: '150px',
			priority: 2,
			cell: (item) => <CellText value={kindLabel(item.kind)} />,
		},
		{
			key: 'sourceModule',
			header: t('notifications.inbox.column.sourceModule'),
			width: '160px',
			priority: 3,
			cell: (item) => <CellText value={item.sourceModule} mono />,
		},
		{
			key: 'readAt',
			header: t('notifications.inbox.column.readAt'),
			width: '170px',
			priority: 2,
			cell: (item) => item.readAt === null || item.readAt === ''
				? <CellMuted>{t('notifications.common.notYet')}</CellMuted>
				: <CellTime value={item.readAt} />,
		},
	];
}

export function NotificationsInboxView(props: NotificationsInboxViewProps) @{
	const client = useMemo(() => createInboxClientState(), []);
	/* Requests answer out of order; only the latest one may write the screen. */
	const requests = useMemo(() => ({ sequence: 0 }), []);
	const [items] = useValue(client.state.items);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [statusFilter] = useValue(client.state.statusFilter);
	const [kindFilter] = useValue(client.state.kindFilter);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [selectedId, setSelectedId] = useValue(client.state.selectedId);
	const [pageIndex] = useValue(client.state.pageIndex);
	const [pageSize] = useValue(client.state.pageSize);
	const [pages] = useValue(client.state.pages);
	const [archivedHidden] = useValue(client.state.archivedHidden);
	const [selectedIds, setSelectedIds] = useValue(client.state.selectedIds);
	const [confirmArchiveMany, setConfirmArchiveMany] = useValue(
		client.state.confirmArchiveMany,
	);
	const readable = transitionableIds(items, selectedIds, 'mark-read');
	const archivable = transitionableIds(items, selectedIds, 'archive');
	const activeFilters = inboxActiveFilters(statusFilter, kindFilter);
	const selected = selectedInboxItem(items, selectedId);
	const current: InboxRequest = {
		status: statusFilter,
		kind: kindFilter,
		pageIndex,
		pageSize,
		pages,
	};

	/* The server sorts, narrows and cuts the page: every request names its
   filters, its page and the cursor that opens it, and the response records
   the cursor of the page after it. */
	const load = async (request: InboxRequest) => {
		const cursor = pageCursor(request.pages, request.pageIndex);
		if (cursor === null) return;
		const sequence = requests.sequence += 1;
		client.store.act((transaction) => {
			transaction.set(client.state.statusFilter, request.status);
			transaction.set(client.state.kindFilter, request.kind);
			transaction.set(client.state.pageIndex, request.pageIndex);
			transaction.set(client.state.pageSize, request.pageSize);
			transaction.set(client.state.pages, request.pages);
			/* A new listing is a new set of rows: nothing checked before it stays. */
			transaction.set(client.state.selectedIds, new Set());
			transaction.set(client.state.status, 'loading');
			transaction.set(client.state.error, '');
		}, 'notifications/inbox-request');
		try {
			const page = await loadInbox({
				status: request.status,
				kind: request.kind,
				limit: request.pageSize,
				cursor,
			});
			/* An empty open inbox is a first run only when nothing is archived
   either; that is one more bounded read, paid in the empty case alone. */
			const hidden =
				page.items.length === 0 && request.status === '' &&
					request.kind === '' &&
					request.pageIndex === 0 &&
					(await loadInbox({ status: 'archived', limit: 1 })).items.length > 0;
			if (sequence !== requests.sequence) return;
			client.store.act((transaction) => {
				transaction.set(client.state.items, page.items);
				transaction.set(client.state.archivedHidden, hidden);
				transaction.set(
					client.state.pages,
					pageLoaded(request.pages, request.pageIndex, page.page.nextCursor),
				);
				transaction.set(client.state.status, 'idle');
			}, 'notifications/inbox-loaded');
		} catch (loadError) {
			if (sequence !== requests.sequence) return;
			setError(
				notificationsErrorMessage(loadError, 'notifications.inbox.error.load'),
			);
			setStatus(
				loadError instanceof NotificationsApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void load(current);
		void refreshUnreadCount();
	}, []);

	/* A filter starts a new listing from its first page, so the open record may
   not come back. The drawer closes with the same change that replaces the
   rows behind it. */
	const restart = (change: Partial<InboxRequest>) => {
		setSelectedId(null);
		void load({ ...current, ...change, pageIndex: 0, pages: FIRST_PAGE });
	};

	/* Every row action replaces the one row it changed, so the list the member
   is reading does not jump, and the badge follows the same change. */
	const mutate = async (run: () => Promise<NotificationsInbox>) => {
		setStatus('submitting');
		setError('');
		try {
			const item = await run();
			client.store.act((transaction) => {
				transaction.set(
					client.state.items,
					items.map((current) => current.id === item.id ? item : current),
				);
				transaction.set(client.state.status, 'idle');
			}, 'notifications/inbox-item-changed');
			void refreshUnreadCount();
		} catch (mutationError) {
			setError(
				notificationsErrorMessage(
					mutationError,
					'notifications.inbox.error.update',
				),
			);
			setStatus('idle');
		}
	};

	/* One change over every checked row, then the page and the badge read again:
   the rows that left the open inbox are gone and the count follows them. */
	const transitionMany = async (transition: InboxTransition) => {
		const ids =
			transition === 'mark-read' ? readable : archivable;
		setConfirmArchiveMany(false);
		if (ids.length === 0) return;
		setStatus('submitting');
		setError('');
		try {
			const outcomes = await transitionInboxItems(
				ids,
				transition,
				props.csrfToken,
			);
			await load(current);
			void refreshUnreadCount();
			toasts.success(
				t(
					transition === 'archive'
						? 'notifications.inbox.notice.archivedMany'
						: 'notifications.inbox.notice.readMany',
					transitionOutcomeCounts(outcomes),
				),
			);
		} catch (transitionError) {
			setError(
				notificationsErrorMessage(
					transitionError,
					'notifications.inbox.error.updateMany',
				),
			);
			setStatus('idle');
		}
	};

	const rowAction = (
		item: NotificationsInbox,
		id: InboxRowAction,
	): TableAction => {
		if (id === 'open') {
			return {
				id,
				label: t('notifications.inbox.action.open'),
				icon: 'file-text',
				onSelect: () => setSelectedId(item.id),
			};
		}
		if (id === 'archive') {
			return {
				id,
				label: t('notifications.inbox.action.archive'),
				icon: 'download',
				onSelect: () => void mutate(
					() => archiveInboxItem(item.id, props.csrfToken),
				),
			};
		}
		return {
			id,
			label: t('notifications.inbox.action.markUnread'),
			icon: 'refresh',
			onSelect: () => void mutate(
				() => markInboxUnread(item.id, props.csrfToken),
			),
		};
	};

	const rowActions = (item: NotificationsInbox): readonly TableAction[] =>
		inboxRowActions(item.status, props.canManage).map(
			(id) => rowAction(item, id),
		);

	<div class="ui-view">
		<PageHeader
			eyebrow={t('notifications.common.workspace')}
			title={t('notifications.inbox.title')}
			description={t('notifications.inbox.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => void load(current)}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('notifications.common.refreshing')
					: t('notifications.common.refresh')}
			</Button>
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState
					icon="shield"
					title={t('notifications.common.accessDenied')}
				>{t('notifications.inbox.denied')}</EmptyState>
			</section>
		} @else {
			<>
				@if (error) {
					<Alert>{error}</Alert>
				}
				<TableCard
					title={t('notifications.inbox.table.title')}
					count={pages.hasMore
						? t('notifications.inbox.table.countMore', {
								count: items.length,
							})
						: t('notifications.inbox.table.count', { count: items.length })}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={activeFilters}
						label={t('notifications.common.filters')}
					>
						<Select
							id="notifications-inbox-status"
							label={t('notifications.inbox.filter.status')}
							value={statusFilter}
							options={[
								{
									value: '',
									label: t('notifications.inbox.filter.statusOpen'),
								},
								...INBOX_STATUSES.map(
									(entry) => ({
										value: entry,
										label: inboxStatusLabel(entry),
									}),
								),
							]}
							onChange={(value) => restart({
								status: value as NotificationsInboxStatus | '',
							})}
						/>
						<Select
							id="notifications-inbox-kind"
							label={t('notifications.inbox.filter.kind')}
							value={kindFilter}
							options={[
								{
									value: '',
									label: t('notifications.inbox.filter.allKinds'),
								},
								...NOTIFICATION_KINDS.map(
									(entry) => ({
										value: entry,
										label: kindLabel(entry),
									}),
								),
							]}
							onChange={(value) => restart({
								kind: value as NotificationKind | '',
							})}
						/>
					</Filters>}
					caption={t('notifications.inbox.table.caption')}
					columns={columns()}
					rows={items}
					rowKey={(item) => item.id}
					mode="server"
					pagination={{
						pageIndex,
						pageSize,
						hasMore: pages.hasMore,
						onPageChange: (index) => void load({
							...current,
							pageIndex: index,
						}),
					}}
					after={<Pagination
						pageIndex={pageIndex}
						pageSize={pageSize}
						hasMore={pages.hasMore}
						pageSizes={PAGE_SIZES}
						onPageChange={(index) => void load({
							...current,
							pageIndex: index,
						})}
						onPageSizeChange={(size) => restart({ pageSize: size })}
						label={t('notifications.pagination.label')}
						previousLabel={t('notifications.pagination.previous')}
						nextLabel={t('notifications.pagination.next')}
						pageSizeLabel={t('notifications.pagination.size')}
						summary={(page) => t('notifications.pagination.keysetSummary', {
							page: page.pageIndex + 1,
							from: page.from,
						})}
					/>}
					status={status === 'loading' && items.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('notifications.inbox.table.loading')}
					filtered={activeFilters > 0 || archivedHidden}
					empty={{
						icon: 'activity',
						title: t('notifications.inbox.empty.title'),
						hint: t('notifications.inbox.empty.hint'),
					}}
					emptyFiltered={{
						icon: 'filter',
						title: t('notifications.inbox.emptyFiltered.title'),
						hint: t('notifications.inbox.emptyFiltered.hint'),
					}}
					onSelect={(item) => setSelectedId(item.id)}
					selectedKey={selectedId ?? undefined}
					selection={props.canManage
						? {
								selectedKeys: selectedIds,
								onSelectionChange: setSelectedIds,
								label: t('notifications.inbox.selection.label'),
								rowLabel: (item) => t(
									'notifications.inbox.selection.rowLabel',
									{
										title: item.title,
									},
								),
								clearLabel: t('notifications.inbox.selection.clear'),
							}
						: undefined}
					bulkActions={[
						{
							id: 'mark-read-selected',
							label: t('notifications.inbox.action.markReadSelected'),
							icon: 'check',
							disabled: readable.length === 0 || status === 'submitting',
							reason: readable.length === 0
								? t('notifications.inbox.action.markReadSelectedRefused')
								: undefined,
							onSelect: () => void transitionMany('mark-read'),
						},
						{
							id: 'archive-selected',
							label: t('notifications.inbox.action.archiveSelected'),
							icon: 'download',
							disabled: archivable.length === 0 || status === 'submitting',
							reason: archivable.length === 0
								? t('notifications.inbox.action.archiveSelectedRefused')
								: undefined,
							onSelect: () => setConfirmArchiveMany(true),
						},
					]}
					selectionSummary={(count) => t(
						'notifications.inbox.selection.summary',
						{
							count,
						},
					)}
					actions={rowActions}
					actionsLabel={t('notifications.common.actions')}
					actionsWidth={INBOX_ACTIONS_WIDTH}
					noteIcon="shield"
					note={t('notifications.inbox.note')}
				/>
			</>
		}
		<Drawer
			open={selected !== null}
			title={selected?.title ?? t('notifications.inbox.title')}
			subtitle={selected ? kindLabel(selected.kind) : ''}
			onClose={() => setSelectedId(null)}
		>
			@if (selected) {
				<div class="ui-drawer__body">
					<div class="ui-form">
						<p class="notifications-body">
							{selected.body ?? t('notifications.inbox.drawer.noBody')}
						</p>
						<FactList
							facts={[
								{
									key: 'status',
									label: t('notifications.inbox.column.status'),
									value: <Tag
										tone={inboxStatusTone(selected.status)}
										dot
									>{inboxStatusLabel(selected.status)}</Tag>,
								},
								{
									key: 'readAt',
									label: t('notifications.inbox.column.readAt'),
									value: isoTimestampLabel(selected.readAt),
								},
								{
									key: 'sourceModule',
									label: t('notifications.inbox.column.sourceModule'),
									value: <span class="ui-mono">{selected.sourceModule}</span>,
								},
								{
									key: 'sourceRef',
									label: t('notifications.inbox.drawer.sourceRef'),
									value: <span class="ui-mono">{selected.sourceRef}</span>,
								},
							]}
						/>
						@if (props.canManage) {
							<div class="ui-form__actions">
								@if (selected.status === 'unread') {
									<Button
										disabled={status === 'submitting'}
										onClick={() => void mutate(
											() => markInboxRead(selected.id, props.csrfToken),
										)}
									>{t('notifications.inbox.action.markRead')}</Button>
								} @else {
									<Button
										disabled={status === 'submitting'}
										onClick={() => void mutate(
											() => markInboxUnread(selected.id, props.csrfToken),
										)}
									>{t('notifications.inbox.action.markUnread')}</Button>
								}
								@if (selected.status !== 'archived') {
									<Button
										variant="primary"
										disabled={status === 'submitting'}
										onClick={() => void mutate(
											() => archiveInboxItem(selected.id, props.csrfToken),
										)}
									>{t('notifications.inbox.action.archive')}</Button>
								}
							</div>
						}
					</div>
				</div>
			}
		</Drawer>
		<ConfirmDialog
			open={confirmArchiveMany}
			title={t('notifications.inbox.archiveMany.title')}
			confirmLabel={t('notifications.inbox.action.archiveSelected')}
			tone="primary"
			busy={status === 'submitting'}
			onConfirm={() => void transitionMany('archive')}
			onCancel={() => setConfirmArchiveMany(false)}
		>{t('notifications.inbox.archiveMany.description', {
			count: archivable.length,
		})}</ConfirmDialog>
		<ToastHost
			label={t('notifications.common.messages')}
			closeLabel={t('notifications.common.close')}
		/>
	</div>
}
