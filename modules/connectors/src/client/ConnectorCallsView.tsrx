import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	EmptyState,
	Filters,
	Icon,
	PageHeader,
	Pagination,
	SearchField,
	Select,
	TableCard,
	Tag,
	type TableColumn,
	type TableSort,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import { useValue } from 'segment-state';
import {
	CONNECTOR_CALL_OUTCOMES,
	type ConnectorCallListRow,
	type ConnectorCallOutcome,
} from '../domain/types.ts';
import {
	ConnectorsApiError,
	connectorsErrorMessage,
	loadConnectorCalls,
} from './api.ts';
import {
	durationLabel,
	outcomeLabel,
	outcomeTone,
	timestampLabel,
} from './presentation.ts';
import {
	beginLoad,
	createConnectorCallsClientState,
	FIRST_PAGE,
	instanceChoices,
	isLatestLoad,
	pageCursor,
	searchPending,
	sortRequest,
	walkTo,
	type PageWalk,
} from './state.ts';

export interface ConnectorCallsViewProps {
	readonly csrfToken: string;
}

const PAGE_SIZES = [25, 50, 100, 200];
const TIME_ORDER: TableSort = { key: 'occurredAt', desc: true };
const SEARCH_DEBOUNCE_MS = 300;

interface CallListing {
	readonly outcome: ConnectorCallOutcome | '';
	readonly instanceId: string;
	readonly q: string;
	readonly sorting: readonly TableSort[];
	readonly pageSize: number;
}

function columns(): readonly TableColumn<ConnectorCallListRow>[] {
	return [
		{
			key: 'occurredAt',
			header: t('connectors.calls.column.occurredAt'),
			width: '16%',
			value: (call) => call.occurredAt,
			cell: (call) => timestampLabel(call.occurredAt),
		},
		{
			key: 'instance',
			header: t('connectors.calls.column.instance'),
			width: '18%',
			cell: (call) =>
				<span>
					{call.instanceName ?? t('connectors.calls.deletedInstance')}
				</span>,
		},
		{
			key: 'operation',
			header: t('connectors.calls.column.operation'),
			width: '12%',
			cell: (call) => <span class="ui-mono">{call.operation}</span>,
		},
		{
			key: 'caller',
			header: t('connectors.calls.column.caller'),
			width: '10%',
			cell: (call) => <span>{t('connectors.caller.' + call.caller)}</span>,
		},
		{
			key: 'outcome',
			header: t('connectors.calls.column.outcome'),
			width: '12%',
			cell: (call) =>
				<Tag tone={outcomeTone(call.outcome)} dot>{outcomeLabel(
					call.outcome,
				)}</Tag>,
		},
		{
			key: 'status',
			header: t('connectors.calls.column.status'),
			width: '8%',
			numeric: true,
			cell: (call) =>
				<span class="num">{call.status ?? t('connectors.common.none')}</span>,
		},
		{
			key: 'errorClass',
			header: t('connectors.calls.column.errorClass'),
			width: '14%',
			cell: (call) =>
				<span class="ui-mono">
					{call.errorClass ?? t('connectors.common.none')}
				</span>,
		},
		{
			key: 'durationMs',
			header: t('connectors.calls.column.duration'),
			width: '10%',
			numeric: true,
			cell: (call) => <span class="num">{durationLabel(call.durationMs)}</span>,
		},
	];
}

export function ConnectorCallsView(_props: ConnectorCallsViewProps) @{
	const client = useMemo(() => createConnectorCallsClientState(), []);
	const [calls] = useValue(client.state.calls);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [appliedQuery] = useValue(client.state.appliedQuery);
	const [outcomeFilter, setOutcomeFilter] = useValue(
		client.state.outcomeFilter,
	);
	const [instanceFilter, setInstanceFilter] = useValue(
		client.state.instanceFilter,
	);
	const [sorting, setSorting] = useValue(client.state.sorting);
	const [pageSize, setPageSize] = useValue(client.state.pageSize);
	const [walk] = useValue(client.state.walk);
	const [nextCursor] = useValue(client.state.nextCursor);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const instanceOptions = useMemo(
		() => instanceChoices(calls, instanceFilter),
		[calls, instanceFilter],
	);
	const listing = (): CallListing => ({
		outcome: client.store.get(client.state.outcomeFilter),
		instanceId: client.store.get(client.state.instanceFilter),
		q: client.store.get(client.state.appliedQuery),
		sorting: client.store.get(client.state.sorting),
		pageSize: client.store.get(client.state.pageSize),
	});

	const load = async (target: PageWalk, request: CallListing = listing()) => {
		const ticket = beginLoad(client.store, client.state.loads);
		setStatus('loading');
		setError('');
		try {
			const page = await loadConnectorCalls({
				outcome: request.outcome,
				instanceId: request.instanceId,
				q: request.q,
				...sortRequest(request.sorting, TIME_ORDER),
				cursor: pageCursor(target),
				limit: request.pageSize,
			});
			if (!isLatestLoad(client.store, client.state.loads, ticket)) return;
			client.store.act((transaction) => {
				transaction.set(client.state.calls, page.items);
				transaction.set(client.state.nextCursor, page.page.nextCursor);
				transaction.set(client.state.walk, target);
				transaction.set(client.state.appliedQuery, request.q);
				transaction.set(client.state.status, 'idle');
			}, 'connectors/calls-loaded');
		} catch (loadError) {
			if (!isLatestLoad(client.store, client.state.loads, ticket)) return;
			setError(connectorsErrorMessage(loadError, 'connectors.calls.errorLoad'));
			setStatus(
				loadError instanceof ConnectorsApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	const refresh = () => load(client.store.get(client.state.walk));
	const restart = (change: Partial<CallListing>) => load(FIRST_PAGE, {
		...listing(),
		...change,
	});
	const turnTo = (index: number) => {
		const current = client.store.get(client.state.walk);
		const next = walkTo(
			current,
			index,
			client.store.get(client.state.nextCursor),
		);
		if (next !== current) void load(next);
	};

	useEffect(() => {
		void refresh();
	}, []);

	useEffect(() => {
		if (!searchPending(query, appliedQuery)) return;
		const timer = setTimeout(
			() => void restart({ q: client.store.get(client.state.query).trim() }),
			SEARCH_DEBOUNCE_MS,
		);
		return () => clearTimeout(timer);
	}, [query]);

	<div class="ui-view">
		<PageHeader
			eyebrow={t('connectors.common.administration')}
			title={t('connectors.calls.title')}
			description={t('connectors.calls.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => void refresh()}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('connectors.common.refreshing')
					: t('connectors.common.refresh')}
			</Button>
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState
					icon="shield"
					title={t('connectors.common.accessDenied')}
				>{t('connectors.calls.denied')}</EmptyState>
			</section>
		} @else {
			<>
				@if (error) {
					<Alert>{error}</Alert>
				}
				<TableCard
					title={t('connectors.calls.tableTitle')}
					count={t('connectors.calls.count', { count: calls.length })}
					search={<SearchField
						value={query}
						placeholder={t('connectors.calls.searchPlaceholder')}
						label={t('connectors.calls.searchLabel')}
						onInput={setQuery}
					/>}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={(outcomeFilter === '' ? 0 : 1) +
							(instanceFilter === '' ? 0 : 1)}
						label={t('connectors.common.filters')}
					>
						<Select
							id="connectors-calls-outcome"
							label={t('connectors.calls.filterOutcome')}
							value={outcomeFilter}
							options={[
								{ value: '', label: t('connectors.calls.allOutcomes') },
								...CONNECTOR_CALL_OUTCOMES.map(
									(entry) => ({
										value: entry,
										label: outcomeLabel(entry),
									}),
								),
							]}
							onChange={(value) => {
								const next = value as ConnectorCallOutcome | '';
								setOutcomeFilter(next);
								void restart({ outcome: next });
							}}
						/>
						<Select
							id="connectors-calls-instance"
							label={t('connectors.calls.filterInstance')}
							value={instanceFilter}
							options={[
								{ value: '', label: t('connectors.calls.allInstances') },
								...instanceOptions,
							]}
							onChange={(value) => {
								setInstanceFilter(value);
								void restart({ instanceId: value });
							}}
						/>
					</Filters>}
					caption={t('connectors.calls.caption')}
					columns={columns()}
					rows={calls}
					rowKey={(call) => call.id}
					mode="server"
					sorting
					sortingState={sorting}
					onSortingChange={(sorts) => {
						const next =
							sorts.length === 0 ? [TIME_ORDER] : sorts;
						setSorting(next);
						void restart({ sorting: next });
					}}
					pagination={{
						pageIndex: walk.pageIndex,
						pageSize,
						onPageChange: turnTo,
						hasMore: nextCursor !== null,
					}}
					after={<Pagination
						pageIndex={walk.pageIndex}
						pageSize={pageSize}
						hasMore={nextCursor !== null}
						pageSizes={PAGE_SIZES}
						onPageChange={turnTo}
						onPageSizeChange={(size) => {
							setPageSize(size);
							void restart({ pageSize: size });
						}}
						label={t('connectors.pagination.label')}
						previousLabel={t('connectors.pagination.previous')}
						nextLabel={t('connectors.pagination.next')}
						pageSizeLabel={t('connectors.pagination.size')}
						summary={(page) => t('connectors.pagination.page', {
							page: page.pageIndex + 1,
							from: page.from,
						})}
					/>}
					status={status === 'loading' && calls.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('connectors.calls.loading')}
					filtered={appliedQuery !== '' || outcomeFilter !== '' ||
						instanceFilter !== ''}
					empty={{
						icon: 'activity',
						title: t('connectors.calls.emptyTitle'),
						hint: t('connectors.calls.emptyHint'),
					}}
					emptyFiltered={{
						icon: 'search',
						title: t('connectors.calls.emptyFilteredTitle'),
						hint: t('connectors.calls.emptyFilteredHint'),
					}}
					noteIcon="shield"
					note={t('connectors.calls.note')}
				/>
			</>
		}
	</div>
}
