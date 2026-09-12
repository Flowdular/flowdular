import { useEffect, useMemo, useState } from 'octane';
import {
	Alert,
	Button,
	ConfirmDialog,
	EmptyState,
	Filters,
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
	DELIVERY_STATUSES,
	type DeliveryAttempt,
	type DeliveryStatus,
} from '../domain/types.ts';
import {
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
	timestampLabel,
} from './presentation.ts';
import { createDeliveriesClientState, subscriptionNames } from './state.ts';

export interface DeliveriesViewProps {
	readonly csrfToken: string;
	/** Names come from the webhooks list; without the scope the id is shown. */
	readonly canReadWebhooks: boolean;
}

const PAGE_SIZES = [10, 25, 50, 100];

/* The ledger carries nine values per attempt, and nine columns beside the
   160 px action column leave none of them a readable share of a 1140 px row.
   The two timestamps share one cell and so do the two halves of the outcome,
   which buys every header and the longest status tag the width it needs. */
/** What the subscription column sorts and searches on, for either channel. */
function targetLabel(
	delivery: DeliveryAttempt,
	names: ReadonlyMap<string, string>,
): string {
	if (delivery.channel === 'email') {
		return t('notifications.deliveries.channel.email');
	}
	const id = delivery.subscriptionId ?? '';
	return names.get(id) ?? id;
}

function columns(
	names: ReadonlyMap<string, string>,
): readonly TableColumn<DeliveryAttempt>[] {
	return [
		{
			key: 'subscription',
			header: t('notifications.deliveries.column.subscription'),
			width: '14%',
			value: (delivery) => targetLabel(delivery, names),
			cell: (delivery) => {
				/* An e-mail attempt is addressed to a member, not to a subscription,
   so the column names the channel rather than an empty cell. */
				if (delivery.channel === 'email') {
					return t('notifications.deliveries.channel.email');
				}
				const id = delivery.subscriptionId ?? '';
				return names.get(id) ?? <span class="ui-mono">{id}</span>;
			},
		},
		{
			key: 'kind',
			header: t('notifications.deliveries.column.kind'),
			width: '11%',
			value: (delivery) => kindLabel(delivery.kind),
			cell: (delivery) => kindLabel(delivery.kind),
		},
		{
			key: 'sourceRef',
			header: t('notifications.deliveries.column.sourceRef'),
			width: '12%',
			value: (delivery) => delivery.sourceRef,
			cell: (delivery) => <span class="ui-cell">
				<span
					class="ui-mono notifications-truncate"
					title={delivery.sourceRef}
				>{delivery.sourceRef}</span>
				<small class="ui-cell__muted">{delivery.sourceModule}</small>
			</span>,
		},
		{
			key: 'attemptNumber',
			header: t('notifications.deliveries.column.attempt'),
			width: '10%',
			numeric: true,
			value: (delivery) => delivery.attemptNumber,
			cell: (delivery) => delivery.attemptNumber,
		},
		{
			key: 'status',
			header: t('notifications.deliveries.column.status'),
			width: '12%',
			value: (delivery) => delivery.status,
			cell: (delivery) =>
				<Tag
					tone={deliveryStatusTone(delivery.status)}
					dot
				>{deliveryStatusLabel(delivery.status)}</Tag>,
		},
		{
			key: 'timing',
			header: t('notifications.deliveries.column.timing'),
			width: '15%',
			value: (delivery) => delivery.scheduledFor,
			cell: (delivery) => <span class="ui-cell">
				<b>{timestampLabel(delivery.scheduledFor)}</b>
				<small class="ui-cell__muted">{deliveryCompletedLabel(
					delivery.completedAt,
				)}</small>
			</span>,
		},
		{
			key: 'outcome',
			header: t('notifications.deliveries.column.outcome'),
			width: '11%',
			value: (delivery) => delivery.responseStatus ?? 0,
			cell: (delivery) => {
				const failure = errorClassLabel(delivery.errorClass);
				if (delivery.responseStatus === null) return failure;
				return <span class="ui-cell">
					<b>{delivery.responseStatus}</b>
					{failure === ''
						? ''
						: <small class="ui-cell__muted">{failure}</small>}
				</span>;
			},
		},
	];
}

export function DeliveriesView(props: DeliveriesViewProps) @{
	const client = useMemo(() => createDeliveriesClientState(), []);
	const [deliveries] = useValue(client.state.deliveries);
	const [subscriptions] = useValue(client.state.subscriptions);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [statusFilter, setStatusFilter] = useValue(client.state.statusFilter);
	const [subscriptionFilter, setSubscriptionFilter] = useValue(
		client.state.subscriptionFilter,
	);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [replayId, setReplayId] = useValue(client.state.replayId);
	const [pageIndex, setPageIndex] = useState(0);
	const [pageSize, setPageSize] = useState(25);
	const names = subscriptionNames(subscriptions);
	const locale = activeLocale();
	const term = query.trim().toLocaleLowerCase(locale);
	const visible =
		term === ''
			? deliveries
			: deliveries.filter(
					(delivery) =>
						delivery.sourceRef.toLocaleLowerCase(locale).includes(term) ||
							delivery.sourceModule.toLocaleLowerCase(locale).includes(term),
				);
	const filterCount =
		(statusFilter === '' ? 0 : 1) + (subscriptionFilter === '' ? 0 : 1);
	const filtered = filterCount > 0 || term !== '';
	/* Every subscription the ledger names, so the filter still works when the
   subscription list is not readable or a row outlived its subscription. */
	const filterOptions = [
		...new Set(deliveries.flatMap(
			(delivery) => delivery.subscriptionId === null
				? []
				: [delivery.subscriptionId],
		)),
	].map((id) => ({ value: id, label: names.get(id) ?? id }));

	const refresh = async (
		nextStatus: DeliveryStatus | '',
		nextSubscription: string,
	) => {
		setStatus('loading');
		setError('');
		try {
			const loaded = await loadDeliveries({
				status: nextStatus,
				subscriptionId: nextSubscription,
			});
			client.store.act((transaction) => {
				transaction.set(client.state.deliveries, loaded);
				transaction.set(client.state.status, 'idle');
			}, 'notifications/deliveries-loaded');
		} catch (loadError) {
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

	const loadSubscriptionNames = async () => {
		try {
			client.store.set(
				client.state.subscriptions,
				await loadWebhooks(),
				'notifications/deliveries-subscriptions',
			);
		} catch {
			/* Names are a convenience: the ledger reads fine with the ids alone, so
   a refused or failed subscription list never blocks this screen. */
		}
	};

	useEffect(() => {
		void refresh('', '');
		if (props.canReadWebhooks) void loadSubscriptionNames();
	}, []);

	const replay = async () => {
		const id = replayId;
		if (id === null) return;
		setReplayId(null);
		setStatus('submitting');
		setError('');
		try {
			await replayDelivery(id, props.csrfToken);
			await refresh(statusFilter, subscriptionFilter);
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
				onClick={() => void refresh(statusFilter, subscriptionFilter)}
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
					count={t('notifications.deliveries.table.count', {
						count: visible.length,
					})}
					search={<SearchField
						value={query}
						placeholder={t('notifications.deliveries.search.placeholder')}
						label={t('notifications.deliveries.search.label')}
						onInput={(value) => {
							setQuery(value);
							setPageIndex(0);
						}}
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
							onChange={(value) => {
								const next = value as DeliveryStatus | '';
								setStatusFilter(next);
								setPageIndex(0);
								void refresh(next, subscriptionFilter);
							}}
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
							onChange={(value) => {
								setSubscriptionFilter(value);
								setPageIndex(0);
								void refresh(statusFilter, value);
							}}
						/>
					</Filters>}
					caption={t('notifications.deliveries.table.caption')}
					columns={columns(names)}
					rows={visible}
					rowKey={(delivery) => delivery.id}
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
