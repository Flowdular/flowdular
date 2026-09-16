import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	CellCode,
	CellNumber,
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
	SearchField,
	Select,
	TableCard,
	ToastHost,
	toasts,
	type TableAction,
	type TableColumn,
	type TableSort,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import { useValue } from 'segment-state';
import {
	DELIVERY_STATUSES,
	type DeliveryAttempt,
	type DeliveryStatus,
} from '../domain/types.ts';
import {
	LIST_PAGE_MAX,
	loadDeliveries,
	loadWebhooks,
	NotificationsApiError,
	notificationsErrorMessage,
	replayDelivery,
} from './api.ts';
import {
	deliveryCompletedLabel,
	deliveryStatusLabel,
	deliveryStatusTone,
	errorClassLabel,
	kindLabel,
} from './presentation.ts';
import {
	createDeliveriesClientState,
	FIRST_PAGE,
	pageCursor,
	pageLoaded,
	searchPending,
	subscriptionNames,
	subscriptionOptions,
	type CursorStack,
	type SortDirection,
} from './state.ts';

export interface DeliveriesViewProps {
	readonly csrfToken: string;
	/** Names come from the webhooks list; without the scope the id is shown. */
	readonly canReadWebhooks: boolean;
}

const PAGE_SIZES = [10, 25, 50, 100];
const SEARCH_DEBOUNCE_MS = 300;

/** One page request: the filters, the order, the page and the cursors that reach it. */
interface DeliveriesRequest {
	readonly status: DeliveryStatus | '';
	readonly subscriptionId: string;
	readonly search: string;
	readonly direction: SortDirection;
	readonly pageIndex: number;
	readonly pageSize: number;
	readonly pages: CursorStack;
}

/* The ledger carries nine values per attempt, and nine columns beside the
   160 px action column leave none of them a readable share of a 1140 px row.
   The two timestamps share one cell and so do the two halves of the outcome,
   which buys every header and the longest status tag the width it needs. */
function columns(
	names: ReadonlyMap<string, string>,
): readonly TableColumn<DeliveryAttempt>[] {
	return [
		{
			key: 'subscription',
			header: t('notifications.deliveries.column.subscription'),
			width: 'auto',
			cell: (delivery) => {
				/* An e-mail attempt is addressed to a member, not to a subscription,
   so the column names the channel rather than an empty cell. */
				if (delivery.channel === 'email') {
					return <CellText
						value={t('notifications.deliveries.channel.email')}
					/>;
				}
				const id = delivery.subscriptionId ?? '';
				const name = names.get(id);
				return name === undefined
					? <CellCode value={id} />
					: <CellText value={name} />;
			},
		},
		{
			key: 'kind',
			header: t('notifications.deliveries.column.kind'),
			width: '150px',
			priority: 2,
			cell: (delivery) => <CellText value={kindLabel(delivery.kind)} />,
		},
		{
			key: 'sourceRef',
			header: t('notifications.deliveries.column.sourceRef'),
			width: '180px',
			priority: 3,
			cell: (delivery) =>
				<CellStack
					primary={<CellCode value={delivery.sourceRef} />}
					secondary={delivery.sourceModule}
				/>,
		},
		{
			key: 'attemptNumber',
			header: t('notifications.deliveries.column.attempt'),
			width: '100px',
			numeric: true,
			priority: 2,
			cell: (delivery) => <CellNumber value={delivery.attemptNumber} />,
		},
		{
			key: 'status',
			header: t('notifications.deliveries.column.status'),
			width: '130px',
			cell: (delivery) =>
				<CellTag
					tone={deliveryStatusTone(delivery.status)}
					dot
					label={deliveryStatusLabel(delivery.status)}
				/>,
		},
		{
			key: 'scheduledFor',
			header: t('notifications.deliveries.column.timing'),
			width: '190px',
			priority: 2,
			value: (delivery) => delivery.scheduledFor,
			cell: (delivery) =>
				<CellStack
					primary={<CellTime value={delivery.scheduledFor} />}
					secondary={deliveryCompletedLabel(delivery.completedAt)}
				/>,
		},
		{
			key: 'outcome',
			header: t('notifications.deliveries.column.outcome'),
			width: '160px',
			priority: 3,
			cell: (delivery) => {
				const failure = errorClassLabel(delivery.errorClass);
				if (delivery.responseStatus === null) {
					return failure === '' ? null : <CellText value={failure} />;
				}
				return <CellStack
					primary={String(delivery.responseStatus)}
					primaryMono
					secondary={failure}
				/>;
			},
		},
	];
}

export function DeliveriesView(props: DeliveriesViewProps) @{
	const client = useMemo(() => createDeliveriesClientState(), []);
	/* Requests answer out of order; only the latest one may write the screen. */
	const requests = useMemo(() => ({ sequence: 0 }), []);
	const [deliveries] = useValue(client.state.deliveries);
	const [subscriptions] = useValue(client.state.subscriptions);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [appliedQuery] = useValue(client.state.appliedQuery);
	const [statusFilter] = useValue(client.state.statusFilter);
	const [subscriptionFilter] = useValue(client.state.subscriptionFilter);
	const [direction] = useValue(client.state.direction);
	const [pageIndex] = useValue(client.state.pageIndex);
	const [pageSize] = useValue(client.state.pageSize);
	const [pages] = useValue(client.state.pages);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [replayId, setReplayId] = useValue(client.state.replayId);
	const names = subscriptionNames(subscriptions);
	const filterCount =
		(statusFilter === '' ? 0 : 1) + (subscriptionFilter === '' ? 0 : 1);
	const filtered = filterCount > 0 || appliedQuery !== '';
	const filterOptions = subscriptionOptions(subscriptions, deliveries);
	const sorting: readonly TableSort[] = [
		{ key: 'scheduledFor', desc: direction === 'desc' },
	];
	const current: DeliveriesRequest = {
		status: statusFilter,
		subscriptionId: subscriptionFilter,
		search: appliedQuery,
		direction,
		pageIndex,
		pageSize,
		pages,
	};

	/* The server sorts, narrows and cuts the page: every request names its
   filters, its order, its page and the cursor that opens it, and the
   response records the cursor of the page after it. */
	const load = async (request: DeliveriesRequest) => {
		const cursor = pageCursor(request.pages, request.pageIndex);
		if (cursor === null) return;
		const sequence = requests.sequence += 1;
		client.store.act((transaction) => {
			transaction.set(client.state.statusFilter, request.status);
			transaction.set(client.state.subscriptionFilter, request.subscriptionId);
			transaction.set(client.state.appliedQuery, request.search);
			transaction.set(client.state.direction, request.direction);
			transaction.set(client.state.pageIndex, request.pageIndex);
			transaction.set(client.state.pageSize, request.pageSize);
			transaction.set(client.state.pages, request.pages);
			transaction.set(client.state.status, 'loading');
			transaction.set(client.state.error, '');
		}, 'notifications/deliveries-request');
		try {
			const page = await loadDeliveries({
				status: request.status,
				subscriptionId: request.subscriptionId,
				search: request.search,
				direction: request.direction,
				limit: request.pageSize,
				cursor,
			});
			if (sequence !== requests.sequence) return;
			client.store.act((transaction) => {
				transaction.set(client.state.deliveries, page.items);
				transaction.set(
					client.state.pages,
					pageLoaded(request.pages, request.pageIndex, page.page.nextCursor),
				);
				transaction.set(client.state.status, 'idle');
			}, 'notifications/deliveries-loaded');
		} catch (loadError) {
			if (sequence !== requests.sequence) return;
			setError(
				notificationsErrorMessage(
					loadError,
					'notifications.deliveries.error.load',
				),
			);
			setStatus(
				loadError instanceof NotificationsApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	/* A filter, a term or an order starts a new listing from its first page. */
	const restart = (change: Partial<DeliveriesRequest>) => load({
		...current,
		...change,
		pageIndex: 0,
		pages: FIRST_PAGE,
	});

	/* The names behind the subscription column and filter: the largest page
   the list serves, which is every subscription of any workspace this screen
   is built for. */
	const loadSubscriptionNames = async () => {
		try {
			client.store.set(
				client.state.subscriptions,
				(await loadWebhooks({ limit: LIST_PAGE_MAX })).items,
				'notifications/deliveries-subscriptions',
			);
		} catch {
			/* Names are a convenience: the ledger reads fine with the ids alone, so
   a refused or failed subscription list never blocks this screen. */
		}
	};

	useEffect(() => {
		void load(current);
		if (props.canReadWebhooks) void loadSubscriptionNames();
	}, []);

	/* The term is the server's filter, so typing it starts a new listing rather
   than narrowing the page on screen. One listing per pause in the typing, and
   none at all while the rows already answer this term. */
	useEffect(() => {
		if (!searchPending(query, appliedQuery)) return;
		const timer = setTimeout(
			() => void restart({ search: query.trim() }),
			SEARCH_DEBOUNCE_MS,
		);
		return () => clearTimeout(timer);
	}, [query]);

	const replay = async () => {
		const id = replayId;
		if (id === null) return;
		setReplayId(null);
		setStatus('submitting');
		setError('');
		try {
			await replayDelivery(id, props.csrfToken);
			await load(current);
			toasts.success(t('notifications.deliveries.notice.replayed'));
		} catch (replayError) {
			setError(
				notificationsErrorMessage(
					replayError,
					'notifications.deliveries.error.replay',
				),
			);
			setStatus('idle');
		}
	};

	const rowActions = (delivery: DeliveryAttempt): readonly TableAction[] =>
		delivery.status === 'dead-letter'
			? [
					{
						id: 'replay',
						label: t('notifications.deliveries.action.replay'),
						icon: 'refresh',
						onSelect: () => setReplayId(delivery.id),
					},
				]
			: [];

	<div class="ui-view">
		<PageHeader
			eyebrow={t('notifications.common.administration')}
			title={t('notifications.deliveries.title')}
			description={t('notifications.deliveries.description')}
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
				>{t('notifications.deliveries.denied')}</EmptyState>
			</section>
		} @else {
			<>
				@if (error) {
					<Alert>{error}</Alert>
				}
				<TableCard
					title={t('notifications.deliveries.table.title')}
					count={pages.hasMore
						? t('notifications.deliveries.table.countMore', {
								count: deliveries.length,
							})
						: t('notifications.deliveries.table.count', {
								count: deliveries.length,
							})}
					search={<SearchField
						value={query}
						placeholder={t('notifications.deliveries.search.placeholder')}
						label={t('notifications.deliveries.search.label')}
						onInput={setQuery}
					/>}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={filterCount}
						label={t('notifications.common.filters')}
					>
						<Select
							id="notifications-deliveries-status"
							label={t('notifications.deliveries.filter.status')}
							value={statusFilter}
							options={[
								{
									value: '',
									label: t('notifications.deliveries.filter.allStatuses'),
								},
								...DELIVERY_STATUSES.map(
									(entry) => ({
										value: entry,
										label: deliveryStatusLabel(entry),
									}),
								),
							]}
							onChange={(value) => void restart({
								status: value as DeliveryStatus | '',
							})}
						/>
						<Select
							id="notifications-deliveries-subscription"
							label={t('notifications.deliveries.filter.subscription')}
							value={subscriptionFilter}
							options={[
								{
									value: '',
									label: t('notifications.deliveries.filter.allSubscriptions'),
								},
								...filterOptions,
							]}
							onChange={(value) => void restart({ subscriptionId: value })}
						/>
					</Filters>}
					caption={t('notifications.deliveries.table.caption')}
					columns={columns(names)}
					rows={deliveries}
					rowKey={(delivery) => delivery.id}
					mode="server"
					sorting
					sortingState={sorting}
					onSortingChange={(sorts) => void restart({
						direction: sorts[0]?.desc === true ? 'desc' : 'asc',
					})}
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
						onPageSizeChange={(size) => void restart({ pageSize: size })}
						label={t('notifications.pagination.label')}
						previousLabel={t('notifications.pagination.previous')}
						nextLabel={t('notifications.pagination.next')}
						pageSizeLabel={t('notifications.pagination.size')}
						summary={(page) => t('notifications.pagination.keysetSummary', {
							page: page.pageIndex + 1,
							from: page.from,
						})}
					/>}
					status={status === 'loading' && deliveries.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('notifications.deliveries.table.loading')}
					filtered={filtered}
					empty={{
						icon: 'activity',
						title: t('notifications.deliveries.empty.title'),
						hint: t('notifications.deliveries.empty.hint'),
					}}
					emptyFiltered={{
						icon: 'search',
						title: t('notifications.deliveries.emptyFiltered.title'),
						hint: t('notifications.deliveries.emptyFiltered.hint'),
					}}
					actions={rowActions}
					actionsLabel={t('notifications.common.actions')}
					noteIcon="shield"
					note={t('notifications.deliveries.note')}
				/>
			</>
		}
		<ConfirmDialog
			open={replayId !== null}
			title={t('notifications.deliveries.replay.title')}
			confirmLabel={t('notifications.deliveries.action.replay')}
			tone="primary"
			busy={status === 'submitting'}
			onConfirm={() => void replay()}
			onCancel={() => setReplayId(null)}
		>{t('notifications.deliveries.replay.description')}</ConfirmDialog>
		<ToastHost
			label={t('notifications.common.messages')}
			closeLabel={t('notifications.common.close')}
		/>
	</div>
}
