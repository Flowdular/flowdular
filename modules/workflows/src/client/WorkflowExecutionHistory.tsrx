import { t } from '@flowdular/client';
import {
	CellMuted,
	CellStack,
	CellTag,
	CellText,
	CellTime,
	Filters,
	Pagination,
	SearchField,
	TableCard,
	type TableColumn,
	type TableSort,
} from '@flowdular/ui';
import type { WorkflowRunSummary } from '../domain/types.ts';
import {
	costLabel,
	duration,
	RUN_STATUSES,
	workflowStatusTone,
} from './presentation.ts';

export interface WorkflowExecutionHistoryProps {
	/** The page the server returned, already narrowed and ordered. */
	readonly runs: readonly WorkflowRunSummary[];
	readonly query: string;
	readonly appliedQuery: string;
	readonly statusFilter: string;
	readonly filtersOpen: boolean;
	readonly loading: boolean;
	readonly sorting: readonly TableSort[];
	readonly pageIndex: number;
	readonly pageSize: number;
	readonly hasMore: boolean;
	readonly selectedRunId: string;
	readonly onQuery: (value: string) => void;
	readonly onStatusFilter: (value: string) => void;
	readonly onToggleFilters: () => void;
	readonly onSorting: (sorts: readonly TableSort[]) => void;
	readonly onPage: (pageIndex: number) => void;
	readonly onSelect: (run: WorkflowRunSummary) => void;
}

function columns(): readonly TableColumn<WorkflowRunSummary>[] {
	return [
		{
			key: 'workflow',
			header: t('workflows.history.column.workflow'),
			width: 'auto',
			cell: (run) =>
				<CellStack
					primary={run.workflowName}
					secondary={run.workflowKey + ' · r' +
						(run.workflowRevision ?? t('workflows.history.draft'))}
					secondaryMono
				/>,
		},
		{
			key: 'origin',
			header: t('workflows.history.column.origin'),
			width: '180px',
			priority: 3,
			cell: (run) =>
				<CellStack
					primary={run.actor.label}
					secondary={t('workflows.origin.' + run.origin.kind)}
				/>,
		},
		{
			key: 'queued',
			header: t('workflows.history.column.queued'),
			width: '170px',
			priority: 2,
			value: (run) => run.queuedAt,
			cell: (run) => <CellTime value={run.queuedAt} />,
		},
		{
			key: 'progress',
			header: t('workflows.history.column.progress'),
			width: '110px',
			numeric: true,
			priority: 2,
			cell: (run) =>
				<CellText value={`${run.completedNodes}/${run.totalNodes}`} />,
		},
		{
			key: 'duration',
			header: t('workflows.history.column.duration'),
			width: '110px',
			numeric: true,
			priority: 3,
			cell: (run) => run.durationMs === null
				? <CellMuted>{t('workflows.common.notAvailable')}</CellMuted>
				: <CellText value={duration(run.durationMs)} />,
		},
		{
			key: 'cost',
			header: t('workflows.history.column.cost'),
			width: '120px',
			numeric: true,
			priority: 3,
			cell: (run) => run.cost.state === 'not-applicable'
				? <CellMuted>{costLabel(run.cost)}</CellMuted>
				: <CellText value={costLabel(run.cost)} />,
		},
		{
			key: 'status',
			header: t('workflows.history.column.status'),
			width: '160px',
			cell: (run) =>
				<CellTag
					tone={workflowStatusTone(run.status)}
					dot
					label={t('workflows.runStatus.' + run.status)}
				/>,
		},
	];
}

export function WorkflowExecutionHistory(
	props: WorkflowExecutionHistoryProps,
) @{
	<TableCard
		title={t('workflows.history.title')}
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
		rows={props.runs}
		rowKey={(run) => run.id}
		mode="server"
		sorting
		sortingState={props.sorting}
		onSortingChange={props.onSorting}
		pagination={{
			pageIndex: props.pageIndex,
			pageSize: props.pageSize,
			onPageChange: props.onPage,
			hasMore: props.hasMore,
		}}
		after={<Pagination
			pageIndex={props.pageIndex}
			pageSize={props.pageSize}
			hasMore={props.hasMore}
			onPageChange={props.onPage}
			label={t('workflows.pagination.label')}
			previousLabel={t('workflows.pagination.previous')}
			nextLabel={t('workflows.pagination.next')}
			summary={(page) => t('workflows.pagination.summary', {
				page: page.pageIndex + 1,
				from: page.from,
			})}
		/>}
		status={props.loading ? 'loading' : 'idle'}
		loadingLabel={t('workflows.history.loading')}
		filtered={props.appliedQuery !== '' || props.statusFilter !== ''}
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
	/>
}
