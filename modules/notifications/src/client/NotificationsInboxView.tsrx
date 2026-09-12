import { useEffect, useMemo, useState } from 'octane';
import {
	Alert,
	Button,
	Drawer,
	EmptyState,
	Filters,
	Icon,
	PageHeader,
	Pagination,
	Select,
	TableCard,
	Tag,
	type TableAction,
	type TableColumn,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import { useValue } from 'segment-state';
import {
	INBOX_STATUSES,
	NOTIFICATION_KINDS,
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
} from './api.ts';
import { FactList } from './FactList.tsrx';
import {
	inboxListing,
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
import { createInboxClientState } from './state.ts';
import { refreshUnreadCount } from './unread-count.ts';

export interface NotificationsInboxViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

const PAGE_SIZES = [10, 25, 50, 100];

/* Two row actions, and the longer locale sets the width: the Polish read state
   label does not fit the 280 px the shared column defaults to. */
const INBOX_ACTIONS_WIDTH = '320px';

function columns(): readonly TableColumn<NotificationsInbox>[] {
	return [
		{
			key: 'status',
			header: t('notifications.inbox.column.status'),
			width: '14%',
			value: (item) => item.status,
			cell: (item) =>
				<Tag tone={inboxStatusTone(item.status)} dot>{inboxStatusLabel(
					item.status,
				)}</Tag>,
		},
		{
			key: 'kind',
			header: t('notifications.inbox.column.kind'),
			width: '12%',
			value: (item) => kindLabel(item.kind),
			cell: (item) => kindLabel(item.kind),
		},
		{
			key: 'title',
			header: t('notifications.inbox.column.title'),
			width: '19%',
			value: (item) => item.title,
			cell: (item) => <span class="ui-cell">
				<b>{item.title}</b>
				<small class="ui-mono">{item.sourceRef}</small>
			</span>,
		},
		{
			key: 'sourceModule',
			header: t('notifications.inbox.column.sourceModule'),
			width: '14%',
			value: (item) => item.sourceModule,
			cell: (item) => <span class="ui-mono">{item.sourceModule}</span>,
		},
		{
			key: 'readAt',
			header: t('notifications.inbox.column.readAt'),
			width: '13%',
			value: (item) => item.readAt ?? '',
			cell: (item) => isoTimestampLabel(item.readAt),
		},
	];
}

export function NotificationsInboxView(props: NotificationsInboxViewProps) @{
	const client = useMemo(() => createInboxClientState(), []);
	const [items] = useValue(client.state.items);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [statusFilter] = useValue(client.state.statusFilter);
	const [kindFilter] = useValue(client.state.kindFilter);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [selectedId, setSelectedId] = useValue(client.state.selectedId);
	const [pageIndex, setPageIndex] = useState(0);
	const [pageSize, setPageSize] = useState(25);
	const listing = inboxListing(items, statusFilter, kindFilter);
	const visible = listing.visible;
	const selected = selectedInboxItem(items, selectedId);

	const refresh = async (
		nextStatus: NotificationsInboxStatus | '',
		nextKind: NotificationKind | '',
	) => {
		setStatus('loading');
		setError('');
		try {
			const loaded = await loadInbox({ status: nextStatus, kind: nextKind });
			client.store.act((transaction) => {
				transaction.set(client.state.items, loaded);
				transaction.set(client.state.status, 'idle');
			}, 'notifications/inbox-loaded');
		} catch (loadError) {
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
		void refresh('', '');
		void refreshUnreadCount();
	}, []);

	/* A filter reloads the set, so the open record may not come back. The drawer
   closes with the same change that replaces the rows behind it. */
	const applyStatus = (next: NotificationsInboxStatus | '') => {
		client.store.act((transaction) => {
			transaction.set(client.state.statusFilter, next);
			transaction.set(client.state.selectedId, null);
		}, 'notifications/inbox-status-filter');
		setPageIndex(0);
		void refresh(next, kindFilter);
	};

	const applyKind = (next: NotificationKind | '') => {
		client.store.act((transaction) => {
			transaction.set(client.state.kindFilter, next);
			transaction.set(client.state.selectedId, null);
		}, 'notifications/inbox-kind-filter');
		setPageIndex(0);
		void refresh(statusFilter, next);
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
				onClick={() => void refresh(statusFilter, kindFilter)}
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
					count={t('notifications.inbox.table.count', {
						count: visible.length,
					})}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={listing.activeFilters}
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
							onChange={(value) => applyStatus(
								value as NotificationsInboxStatus | '',
							)}
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
							onChange={(value) => applyKind(value as NotificationKind | '')}
						/>
					</Filters>}
					caption={t('notifications.inbox.table.caption')}
					columns={columns()}
					rows={visible}
					rowKey={(item) => item.id}
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
						label={t('notifications.pagination.label')}
						previousLabel={t('notifications.pagination.previous')}
						nextLabel={t('notifications.pagination.next')}
						pageSizeLabel={t('notifications.pagination.size')}
						summary={(range) => t('notifications.pagination.summary', {
							page: range.pageIndex + 1,
							pages: range.pageCount,
							from: range.from,
							to: range.to,
							total: range.totalRows,
						})}
					/>}
					status={status === 'loading' && items.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('notifications.inbox.table.loading')}
					filtered={listing.filtered}
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
	</div>
}
