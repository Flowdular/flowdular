import { useEffect, useMemo } from 'octane';
import { t } from '@flowdular/client';
import {
	Alert,
	Button,
	CellMuted,
	CellStack,
	CellTag,
	CellText,
	CellTime,
	EmptyState,
	Filters,
	Icon,
	PageHeader,
	Pagination,
	SearchField,
	TableCard,
	type TableColumn,
	type TableSort,
} from '@flowdular/ui';
import { useValue } from 'segment-state';
import type { AgentRun } from '../domain/types.ts';
import {
	cancelAgentRun,
	loadAgentRun,
	loadAgentRuns,
	observeAgentRun,
} from './api.ts';
import {
	durationLabel,
	RUN_STATUSES,
	RUN_TRIGGERS,
	stateTone,
	triggerLabel,
} from './presentation.ts';
import { RunTimeline } from './RunTimeline.tsrx';
import {
	createAgentRunClientState,
	FIRST_PAGE,
	hasMorePages,
	mergeAgentOptions,
	moveToPage,
	PAGE_SIZE,
	pageCursor,
	pageLoaded,
	runDirection,
} from './state.ts';

export interface AgentRunsViewProps {
	readonly csrfToken: string;
	readonly canCancel: boolean;
}

const SEARCH_DEBOUNCE_MS = 250;
const POLL_MS = 2_500;

function columns(now: number): readonly TableColumn<AgentRun>[] {
	return [
		{
			key: 'agent',
			header: t('agents.runs.column.agent'),
			width: 'auto',
			cell: (run) => <CellStack
				primary={run.agentName}
				secondary={t('agents.runs.revision', {
					revision: run.agentRevision,
				})}
				secondaryMono
			/>,
		},
		{
			key: 'trigger',
			header: t('agents.runs.column.trigger'),
			width: '120px',
			priority: 3,
			cell: (run) => <CellText value={triggerLabel(run.trigger)} />,
		},
		{
			key: 'queuedAt',
			header: t('agents.runs.column.queued'),
			width: '170px',
			value: (run) => run.queuedAt,
			cell: (run) => <CellTime value={run.queuedAt} />,
		},
		{
			key: 'duration',
			header: t('agents.runs.column.duration'),
			width: '120px',
			numeric: true,
			priority: 2,
			cell: (run) => {
				const duration = durationLabel(run, now);
				return duration
					? <CellText value={duration} />
					: <CellMuted>{t('agents.usage.none')}</CellMuted>;
			},
		},
		{
			key: 'status',
			header: t('agents.runs.column.status'),
			width: '130px',
			cell: (run) =>
				<CellTag
					tone={stateTone(run.status)}
					dot
					label={t('agents.runStatus.' + run.status)}
				/>,
		},
	];
}

export function AgentRunsView(props: AgentRunsViewProps) @{
	const client = useMemo(() => createAgentRunClientState(), []);
	const [runs] = useValue(client.state.runs);
	const [page] = useValue(client.state.page);
	const [direction] = useValue(client.state.direction);
	const [agentOptions] = useValue(client.state.agentOptions);
	const [selectedRun, setSelectedRun] = useValue(client.state.selectedRun);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query] = useValue(client.state.query);
	const [statusFilter] = useValue(client.state.statusFilter);
	const [agentFilter] = useValue(client.state.agentFilter);
	const [triggerFilter] = useValue(client.state.triggerFilter);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const term = query.trim();

	/* Every filter, the sort and the page are request parameters; a change of
   any but the page starts the list over from its first page. */
	const narrow = (
		key: | typeof client.state.query
		| typeof client.state.statusFilter
		| typeof client.state.agentFilter
		| typeof client.state.triggerFilter,
		value: string,
	) => client.store.act((transaction) => {
		transaction.set(key, value);
		transaction.set(client.state.page, FIRST_PAGE);
	}, 'agents/runs-narrowed');
	const setQuery = (value: string) => narrow(client.state.query, value);
	const setStatusFilter = (value: string) => narrow(
		client.state.statusFilter,
		value,
	);
	const setAgentFilter = (value: string) => narrow(
		client.state.agentFilter,
		value,
	);
	const setTriggerFilter = (value: string) => narrow(
		client.state.triggerFilter,
		value,
	);
	const setSorting = (sorts: readonly TableSort[]) => client.store.act((
		transaction,
	) => {
		transaction.set(client.state.direction, runDirection(sorts));
		transaction.set(client.state.page, FIRST_PAGE);
	}, 'agents/runs-sorted');
	const setPage = (pageIndex: number) => client.store.act(
		(transaction) => transaction.set(
			client.state.page,
			moveToPage(page, pageIndex),
		),
		'agents/runs-page',
	);

	const open = async (run: AgentRun) => {
		try {
			setSelectedRun(await loadAgentRun(run.id));
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: t('agents.runs.error.loadOne'),
			);
		}
	};

	const cancel = async () => {
		if (!selectedRun) return;
		setStatus('submitting');
		setError('');
		try {
			setSelectedRun(await cancelAgentRun(selectedRun.id, props.csrfToken));
		} catch (cancelError) {
			setError(
				cancelError instanceof Error
					? cancelError.message
					: t('agents.runs.error.cancel'),
			);
		} finally {
			setStatus('idle');
		}
	};

	/* A poll keeps the rows on screen while it reads; only a request the
   reader asked for replaces them with the loading row. */
	const loadPage = async (
		isCurrent: () => boolean = () => true,
		poll = false,
	) => {
		if (!poll) {
			setStatus('loading');
			setError('');
		}
		try {
			const result = await loadAgentRuns({
				limit: PAGE_SIZE,
				cursor: pageCursor(page),
				direction,
				status: statusFilter,
				agentId: agentFilter,
				trigger: triggerFilter,
				q: term,
			});
			if (!isCurrent()) return;
			client.store.act((transaction) => {
				transaction.set(client.state.runs, result.items);
				transaction.set(
					client.state.page,
					pageLoaded(page, result.page.nextCursor),
				);
				transaction.set(
					client.state.agentOptions,
					mergeAgentOptions(
						client.store.get(client.state.agentOptions),
						result.items,
					),
				);
			}, 'agents/runs-loaded');
			if (selectedRun && !poll) {
				setSelectedRun(await loadAgentRun(selectedRun.id));
			}
		} catch (loadError) {
			if (!isCurrent()) return;
			setError(
				loadError instanceof Error
					? loadError.message
					: t('agents.runs.error.load'),
			);
		} finally {
			if (isCurrent() && !poll) setStatus('idle');
		}
	};

	useEffect(() => {
		let current = true;
		const timer = setTimeout(
			() => void loadPage(() => current),
			term === '' ? 0 : SEARCH_DEBOUNCE_MS,
		);
		const poll = setInterval(() => void loadPage(() => current, true), POLL_MS);
		return () => {
			current = false;
			clearTimeout(timer);
			clearInterval(poll);
		};
	}, [term, statusFilter, agentFilter, triggerFilter, direction, page.pageIndex]);

	useEffect(() => {
		if (
			!selectedRun ||
				['succeeded', 'failed', 'cancelled'].includes(selectedRun.status)
		) {
			return;
		}
		return observeAgentRun(
			selectedRun.id,
			setSelectedRun,
			selectedRun.timeline,
		);
	}, [selectedRun?.id, selectedRun?.status]);

	const now = Date.now();
	const activeFilters = [statusFilter, agentFilter, triggerFilter].filter(
		Boolean,
	).length;

	<div class="ui-view">
		<PageHeader
			eyebrow={t('agents.runs.eyebrow')}
			title={t('agents.runs.title')}
			description={t('agents.runs.description')}
		>
			<Button size="sm" onClick={() => void loadPage()}>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('agents.common.refreshing')
					: t('agents.common.refresh')}
			</Button>
		</PageHeader>
		@if (error) {
			<Alert>{error}</Alert>
		}
		<div class="ui-two-col ui-two-col--wide-aside">
			<TableCard
				title={t('agents.runs.table.title')}
				count={t('agents.runs.table.count', { count: runs.length })}
				search={<SearchField
					value={query}
					placeholder={t('agents.runs.search.placeholder')}
					label={t('agents.runs.search.label')}
					onInput={setQuery}
				/>}
				filters={<Filters
					open={filtersOpen}
					onToggle={() => setFiltersOpen(!filtersOpen)}
					activeCount={activeFilters}
					label={t('agents.runs.filter.label')}
				>
					<div class="run-filters">
						<label>
							<span class="ui-label">{t('agents.runs.filter.status')}</span>
							<select
								class="ui-select"
								value={statusFilter}
								onInput={(event) => setStatusFilter(event.currentTarget.value)}
							>
								<option value="">{t('agents.runs.filter.allStatuses')}</option>
								@for (const value of RUN_STATUSES; key value) {
									<option value={value}>{t(
										'agents.runStatus.' + value,
									)}</option>
								}
							</select>
						</label>
						<label>
							<span class="ui-label">{t('agents.runs.filter.agent')}</span>
							<select
								class="ui-select"
								value={agentFilter}
								onInput={(event) => setAgentFilter(event.currentTarget.value)}
							>
								<option value="">{t('agents.runs.filter.allAgents')}</option>
								@for (const agent of agentOptions; key agent.id) {
									<option value={agent.id}>{agent.name}</option>
								}
							</select>
						</label>
						<label>
							<span class="ui-label">{t('agents.runs.filter.trigger')}</span>
							<select
								class="ui-select"
								value={triggerFilter}
								onInput={(event) => setTriggerFilter(event.currentTarget.value)}
							>
								<option value="">{t('agents.runs.filter.allTriggers')}</option>
								@for (const value of RUN_TRIGGERS; key value) {
									<option value={value}>{triggerLabel(value)}</option>
								}
							</select>
						</label>
					</div>
				</Filters>}
				caption={t('agents.runs.table.caption')}
				mode="server"
				columns={columns(now)}
				rows={runs}
				rowKey={(run) => run.id}
				status={status === 'loading' ? 'loading' : 'idle'}
				loadingLabel={t('agents.runs.loading')}
				sorting
				sortingState={[
					{ key: 'queuedAt', desc: direction === 'desc' },
				]}
				onSortingChange={setSorting}
				pagination={{
					pageIndex: page.pageIndex,
					pageSize: PAGE_SIZE,
					hasMore: hasMorePages(page),
					onPageChange: setPage,
				}}
				after={<Pagination
					pageIndex={page.pageIndex}
					pageSize={PAGE_SIZE}
					hasMore={hasMorePages(page)}
					onPageChange={setPage}
					label={t('agents.common.page.label')}
					previousLabel={t('agents.common.page.previous')}
					nextLabel={t('agents.common.page.next')}
					summary={(keyset) => t('agents.common.page.summary', {
						page: keyset.pageIndex + 1,
						from: keyset.from,
					})}
				/>}
				filtered={term !== '' || activeFilters > 0}
				empty={{
					icon: 'play',
					title: t('agents.runs.empty.title'),
					hint: t('agents.runs.empty.hint'),
				}}
				emptyFiltered={{
					icon: 'search',
					title: t('agents.runs.empty.filteredTitle'),
					hint: t('agents.runs.empty.filteredHint'),
				}}
				onSelect={(run) => void open(run)}
				selectedKey={selectedRun?.id}
			/>
			@if (selectedRun) {
				<RunTimeline
					run={selectedRun}
					onCancel={props.canCancel ? () => void cancel() : undefined}
					cancelling={status === 'submitting'}
				/>
			} @else {
				<aside class="ui-card">
					<EmptyState icon="activity" title={t('agents.runs.trace.title')}>{t(
						'agents.runs.trace.hint',
					)}</EmptyState>
				</aside>
			}
		</div>
	</div>
}
