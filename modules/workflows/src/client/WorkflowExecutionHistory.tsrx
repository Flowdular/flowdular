import { t } from '@flowdular/client';
import {
	Button,
	Filters,
	SearchField,
	TableCard,
	Tag,
	type TableColumn,
} from '@flowdular/ui';
import type { WorkflowRunSummary } from '../domain/types.ts';
import {
	costLabel,
	dateTime,
	duration,
	RUN_STATUSES,
	workflowStatusTone,
} from './presentation.ts';

export interface WorkflowExecutionHistoryProps {
	readonly runs: readonly WorkflowRunSummary[];
	readonly query: string;
	readonly statusFilter: string;
	readonly filtersOpen: boolean;
	readonly loading: boolean;
	readonly hasMore: boolean;
	readonly selectedRunId: string;
	readonly onQuery: (value: string) => void;
	readonly onStatusFilter: (value: string) => void;
	readonly onToggleFilters: () => void;
	readonly onSelect: (run: WorkflowRunSummary) => void;
	readonly onLoadMore: () => void;
}

function columns(): readonly TableColumn<WorkflowRunSummary>[] {
	return [
		{
			key: 'workflow',
			header: t('workflows.history.column.workflow'),
			width: '24%',
			cell: (run) => <span class="ui-cell">
				<b>{run.workflowName}</b>
				<small class="ui-mono">
					{run.workflowKey + ' · r' +
						(run.workflowRevision ?? t('workflows.history.draft'))}
				</small>
			</span>,
		},
		{
			key: 'origin',
			header: t('workflows.history.column.origin'),
			width: '16%',
			cell: (run) => <span class="ui-cell">
				<b>{run.actor.label}</b>
				<small>{t('workflows.origin.' + run.origin.kind)}</small>
			</span>,
		},
		{
			key: 'queued',
			header: t('workflows.history.column.queued'),
			width: '18%',
			cell: (run) => dateTime(run.queuedAt),
		},
		{
			key: 'progress',
			header: t('workflows.history.column.progress'),
			width: '12%',
			numeric: true,
			cell: (run) => `${run.completedNodes}/${run.totalNodes}`,
		},
		{
			key: 'duration',
			header: t('workflows.history.column.duration'),
			width: '12%',
			numeric: true,
			cell: (run) => duration(run.durationMs),
		},
		{
			key: 'cost',
			header: t('workflows.history.column.cost'),
			width: '10%',
			numeric: true,
			cell: (run) => costLabel(run.cost),
		},
		{
			key: 'status',
			header: t('workflows.history.column.status'),
			width: '8%',
			cell: (run) =>
				<Tag tone={workflowStatusTone(run.status)} dot>{t(
					'workflows.runStatus.' + run.status,
				)}</Tag>,
		},
	];
}

export function WorkflowExecutionHistory(
	props: WorkflowExecutionHistoryProps,
) @{
	const term = props.query.trim().toLocaleLowerCase();
	const visible = props.runs.filter(
		(run) =>
			(term === '' || run.workflowName.toLocaleLowerCase().includes(term) ||
				run.workflowKey.toLocaleLowerCase().includes(term) ||
				run.actor.label.toLocaleLowerCase().includes(term) ||
				run.id.toLocaleLowerCase().includes(term)) &&
				(props.statusFilter === '' || run.status === props.statusFilter),
	);
	const after =
		props.hasMore
			? <div class="workflow-history-more">
					<Button disabled={props.loading} onClick={props.onLoadMore}>
						{props.loading
							? t('workflows.history.loadingMore')
							: t('workflows.history.loadMore')}
					</Button>
				</div>
			: null;

	<TableCard
		title={t('workflows.history.title')}
		count={t('workflows.history.count', { count: props.runs.length })}
		search={<SearchField
			value={props.query}
			placeholder={t('workflows.history.searchPlaceholder')}
			label={t('workflows.history.searchLabel')}
			onInput={props.onQuery}
		/>}
		filters={<Filters
			open={props.filtersOpen}
			onToggle={props.onToggleFilters}
			activeCount={props.statusFilter ? 1 : 0}
			label={t('workflows.common.filters')}
		>
			<label>
				<span class="ui-label">{t('workflows.history.statusFilter')}</span>
				<select
					class="ui-select"
					value={props.statusFilter}
					onInput={(event) => props.onStatusFilter(event.currentTarget.value)}
				>
					<option value="">{t('workflows.history.allStatuses')}</option>
					@for (const status of RUN_STATUSES; key status) {
						<option value={status}>{t('workflows.runStatus.' + status)}</option>
					}
				</select>
			</label>
		</Filters>}
		caption={t('workflows.history.caption')}
		columns={columns()}
		rows={visible}
		rowKey={(run) => run.id}
		status={props.loading && props.runs.length === 0 ? 'loading' : 'idle'}
		loadingLabel={t('workflows.history.loading')}
		filtered={term !== '' || props.statusFilter !== ''}
		empty={{
			icon: 'activity',
			title: t('workflows.history.emptyTitle'),
			hint: t('workflows.history.emptyHint'),
		}}
		emptyFiltered={{
			icon: 'search',
			title: t('workflows.history.filteredTitle'),
			hint: t('workflows.history.filteredHint'),
		}}
		onSelect={props.onSelect}
		selectedKey={props.selectedRunId}
		after={after}
	/>
}
