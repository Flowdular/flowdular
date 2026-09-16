import { useEffect, useMemo, useState } from 'octane';
import {
	Alert,
	Button,
	CellNumber,
	CellTag,
	CellText,
	CellTime,
	EmptyState,
	Filters,
	Icon,
	PageHeader,
	Pagination,
	SearchField,
	Select,
	TableCard,
	type TableColumn,
} from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client';
import { useValue } from 'segment-state';
import {
	SWEEP_STATUSES,
	type AuditSweepRun,
	type SweepStatus,
} from '../domain/types.ts';
import { AuditApiError, auditErrorMessage, loadSweeps } from './api.ts';
import {
	reasonLabel,
	sweepStatusLabel,
	sweepStatusTone,
} from './presentation.ts';
import { createSweepsClientState } from './state.ts';

export interface SweepsViewProps {
	readonly csrfToken: string;
}

const PAGE_SIZES = [10, 25, 50, 100];

function columns(): readonly TableColumn<AuditSweepRun>[] {
	return [
		{
			key: 'occurredAt',
			header: t('audit.sweeps.column.occurredAt'),
			width: '170px',
			value: (run) => run.occurredAt,
			cell: (run) => <CellTime value={run.occurredAt} />,
		},
		{
			key: 'dataClass',
			header: t('audit.sweeps.column.dataClass'),
			width: 'auto',
			value: (run) => run.classId,
			cell: (run) => <CellText value={run.classId} mono />,
		},
		{
			key: 'cutoff',
			header: t('audit.sweeps.column.cutoff'),
			width: '170px',
			priority: 2,
			value: (run) => run.cutoff,
			cell: (run) => <CellTime value={run.cutoff} />,
		},
		{
			key: 'removed',
			header: t('audit.sweeps.column.removed'),
			width: '110px',
			numeric: true,
			priority: 2,
			value: (run) => run.removed,
			cell: (run) => <CellNumber value={run.removed} />,
		},
		{
			key: 'status',
			header: t('audit.sweeps.column.status'),
			width: '130px',
			value: (run) => run.status,
			cell: (run) =>
				<CellTag
					tone={sweepStatusTone(run.status)}
					dot
					label={sweepStatusLabel(run.status)}
				/>,
		},
		{
			key: 'reason',
			header: t('audit.sweeps.column.reason'),
			width: '200px',
			priority: 3,
			value: (run) => run.reason ?? '',
			cell: (run) => run.reason === null
				? null
				: <CellText value={reasonLabel(run.reason)} wrap />,
		},
	];
}

export function SweepsView(_props: SweepsViewProps) @{
	const client = useMemo(() => createSweepsClientState(), []);
	const [sweeps] = useValue(client.state.sweeps);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [statusFilter, setStatusFilter] = useValue(client.state.statusFilter);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [pageIndex, setPageIndex] = useState(0);
	const [pageSize, setPageSize] = useState(25);
	const locale = activeLocale();
	const term = query.trim().toLocaleLowerCase(locale);
	const visible =
		term === ''
			? sweeps
			: sweeps.filter(
					(run) => run.classId.toLocaleLowerCase(locale).includes(term),
				);
	const filterCount =
		statusFilter === '' ? 0 : 1;
	const filtered = filterCount > 0 || term !== '';

	const refresh = async (nextStatus: SweepStatus | '') => {
		setStatus('loading');
		setError('');
		try {
			const loaded = await loadSweeps(nextStatus);
			client.store.act((transaction) => {
				transaction.set(client.state.sweeps, loaded);
				transaction.set(client.state.status, 'idle');
			}, 'audit/sweeps-loaded');
		} catch (loadError) {
			setError(auditErrorMessage(loadError, 'audit.sweeps.error.load'));
			setStatus(
				loadError instanceof AuditApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void refresh('');
	}, []);

	<div class="ui-view">
		<PageHeader
			eyebrow={t('audit.common.administration')}
			title={t('audit.sweeps.title')}
			description={t('audit.sweeps.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => void refresh(statusFilter)}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('audit.common.refreshing')
					: t('audit.common.refresh')}
			</Button>
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('audit.common.accessDenied')}>{t(
					'audit.sweeps.denied',
				)}</EmptyState>
			</section>
		} @else {
			<>
				@if (error) {
					<Alert>{error}</Alert>
				}
				<TableCard
					title={t('audit.sweeps.table.title')}
					count={t('audit.sweeps.table.count', { count: visible.length })}
					search={<SearchField
						value={query}
						placeholder={t('audit.sweeps.search.placeholder')}
						label={t('audit.sweeps.search.label')}
						onInput={(value) => {
							setQuery(value);
							setPageIndex(0);
						}}
					/>}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={filterCount}
						label={t('audit.common.filters')}
					>
						<Select
							id="audit-sweeps-status"
							label={t('audit.sweeps.filter.status')}
							value={statusFilter}
							options={[
								{ value: '', label: t('audit.sweeps.filter.allStatuses') },
								...SWEEP_STATUSES.map(
									(entry) => ({
										value: entry,
										label: sweepStatusLabel(entry),
									}),
								),
							]}
							onChange={(value) => {
								const next = value as SweepStatus | '';
								setStatusFilter(next);
								setPageIndex(0);
								void refresh(next);
							}}
						/>
					</Filters>}
					caption={t('audit.sweeps.table.caption')}
					columns={columns()}
					rows={visible}
					rowKey={(run) => run.id}
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
						label={t('audit.pagination.label')}
						previousLabel={t('audit.pagination.previous')}
						nextLabel={t('audit.pagination.next')}
						pageSizeLabel={t('audit.pagination.size')}
						summary={(range) => t('audit.pagination.summary', {
							page: range.pageIndex + 1,
							pages: range.pageCount,
							from: range.from,
							to: range.to,
							total: range.totalRows,
						})}
					/>}
					status={status === 'loading' && sweeps.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('audit.sweeps.table.loading')}
					filtered={filtered}
					empty={{
						icon: 'refresh',
						title: t('audit.sweeps.empty.title'),
						hint: t('audit.sweeps.empty.hint'),
					}}
					emptyFiltered={{
						icon: 'search',
						title: t('audit.sweeps.emptyFiltered.title'),
						hint: t('audit.sweeps.emptyFiltered.hint'),
					}}
					noteIcon="shield"
					note={t('audit.sweeps.note')}
				/>
			</>
		}
	</div>
}
