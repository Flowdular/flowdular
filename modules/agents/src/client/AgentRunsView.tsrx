import { useEffect, useMemo } from 'octane';
import { activeLocale, t } from '@coreloom/client';
import {
	Alert,
	Button,
	EmptyState,
	Filters,
	Icon,
	PageHeader,
	SearchField,
	TableCard,
	Tag,
	type TableColumn,
} from '@coreloom/ui';
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
import { createAgentRunClientState } from './state.ts';

export interface AgentRunsViewProps {
	readonly csrfToken: string;
	readonly canCancel: boolean;
}

function date(value: number): string {
	return new Intl.DateTimeFormat(activeLocale(), {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(value);
}

function columns(now: number): readonly TableColumn<AgentRun>[] {
	return [
		{
			key: 'agent',
			header: t('agents.runs.column.agent'),
			width: '25%',
			cell: (run) => <span class="ui-cell">
				<b>{run.agentName}</b>
				<small class="ui-mono">{t('agents.runs.revision', {
					revision: run.agentRevision,
				})}</small>
			</span>,
		},
		{
			key: 'trigger',
			header: t('agents.runs.column.trigger'),
			width: '15%',
			cell: (run) => triggerLabel(run.trigger),
		},
		{
			key: 'queued',
			header: t('agents.runs.column.queued'),
			width: '25%',
			cell: (run) => date(run.queuedAt),
		},
		{
			key: 'duration',
			header: t('agents.runs.column.duration'),
			width: '15%',
			numeric: true,
			cell: (run) => durationLabel(run, now) || '—',
		},
		{
			key: 'status',
			header: t('agents.runs.column.status'),
			width: '20%',
			cell: (run) =>
				<Tag tone={stateTone(run.status)} dot>{t(
					'agents.runStatus.' + run.status,
				)}</Tag>,
		},
	];
}

export function AgentRunsView(props: AgentRunsViewProps) @{
	const client = useMemo(() => createAgentRunClientState(), []);
	const [runs] = useValue(client.state.runs);
	const [selectedRun, setSelectedRun] = useValue(client.state.selectedRun);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [statusFilter, setStatusFilter] = useValue(client.state.statusFilter);
	const [agentFilter, setAgentFilter] = useValue(client.state.agentFilter);
	const [triggerFilter, setTriggerFilter] = useValue(
		client.state.triggerFilter,
	);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);

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

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const records = await loadAgentRuns();
			client.store.act(
				(transaction) => transaction.set(client.state.runs, records),
				'agents/runs-loaded',
			);
			if (selectedRun) {
				setSelectedRun(await loadAgentRun(selectedRun.id));
			}
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: t('agents.runs.error.load'),
			);
		} finally {
			setStatus('idle');
		}
	};

	useEffect(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), 2_500);
		return () => clearInterval(timer);
	}, []);

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
	const locale = activeLocale();
	const term = query.trim().toLocaleLowerCase(locale);
	const agentNames = [...new Set(runs.map((run) => run.agentName))].sort(
		(a, b) => a.localeCompare(b),
	);
	const visible = runs.filter(
		(run) =>
			(term === '' || run.agentName.toLocaleLowerCase(locale).includes(term) ||
				run.input.toLocaleLowerCase(locale).includes(term) ||
				run.id.toLocaleLowerCase(locale).includes(term)) &&
				(statusFilter === '' || run.status === statusFilter) &&
				(agentFilter === '' || run.agentName === agentFilter) &&
				(triggerFilter === '' || run.trigger === triggerFilter),
	);
	const activeFilters = [statusFilter, agentFilter, triggerFilter].filter(
		Boolean,
	).length;

	<div class="ui-view">
		<PageHeader
			eyebrow={t('agents.runs.eyebrow')}
			title={t('agents.runs.title')}
			description={t('agents.runs.description')}
		>
			<Button size="sm" onClick={() => void refresh()}>
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
								@for (const name of agentNames; key name) {
									<option value={name}>{name}</option>
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
				columns={columns(now)}
				rows={visible}
				rowKey={(run) => run.id}
				status={status === 'loading' && runs.length === 0 ? 'loading' : 'idle'}
				loadingLabel={t('agents.runs.loading')}
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
