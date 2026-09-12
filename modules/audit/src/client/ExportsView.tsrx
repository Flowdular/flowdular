import { useEffect, useMemo, useState } from 'octane';
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
} from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client';
import { useValue } from 'segment-state';
import {
	EXPORT_STATUSES,
	type AuditExportRun,
	type ExportStatus,
} from '../domain/types.ts';
import { AuditApiError, auditErrorMessage, loadExports } from './api.ts';
import {
	digestLabel,
	exportStatusLabel,
	exportStatusTone,
	timestampLabel,
} from './presentation.ts';
import { createExportsClientState } from './state.ts';

export interface ExportsViewProps {
	readonly csrfToken: string;
}

const PAGE_SIZES = [10, 25, 50, 100];

function columns(): readonly TableColumn<AuditExportRun>[] {
	return [
		{
			key: 'startedAt',
			header: t('audit.exports.column.startedAt'),
			width: '20%',
			value: (run) => run.startedAt,
			cell: (run) => <span class="ui-cell">
				<b>{timestampLabel(run.startedAt)}</b>
				<small class="ui-cell__muted">{timestampLabel(run.completedAt)}</small>
			</span>,
		},
		{
			key: 'status',
			header: t('audit.exports.column.status'),
			width: '14%',
			value: (run) => run.status,
			cell: (run) =>
				<Tag tone={exportStatusTone(run.status)} dot>{exportStatusLabel(
					run.status,
				)}</Tag>,
		},
		{
			key: 'classes',
			header: t('audit.exports.column.classes'),
			width: '10%',
			numeric: true,
			value: (run) => run.classes,
			cell: (run) => run.classes,
		},
		{
			key: 'rows',
			header: t('audit.exports.column.rows'),
			width: '12%',
			numeric: true,
			value: (run) => run.rows,
			cell: (run) => run.rows,
		},
		{
			key: 'archiveDigest',
			header: t('audit.exports.column.archiveDigest'),
			width: '22%',
			value: (run) => run.archiveDigest ?? '',
			cell: (run) =>
				<span class="ui-mono">{digestLabel(run.archiveDigest)}</span>,
		},
		{
			key: 'requestedBy',
			header: t('audit.exports.column.requestedBy'),
			width: '18%',
			value: (run) => run.requestedBy,
			cell: (run) => run.requestedBy,
		},
	];
}

export function ExportsView(_props: ExportsViewProps) @{
	const client = useMemo(() => createExportsClientState(), []);
	const [runs] = useValue(client.state.exports);
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
			? runs
			: runs.filter(
					(run) => run.requestedBy.toLocaleLowerCase(locale).includes(term),
				);
	const filterCount =
		statusFilter === '' ? 0 : 1;
	const filtered = filterCount > 0 || term !== '';

	const refresh = async (nextStatus: ExportStatus | '') => {
		setStatus('loading');
		setError('');
		try {
			const loaded = await loadExports(nextStatus);
			client.store.act((transaction) => {
				transaction.set(client.state.exports, loaded);
				transaction.set(client.state.status, 'idle');
			}, 'audit/exports-loaded');
		} catch (loadError) {
			setError(auditErrorMessage(loadError, 'audit.exports.error.load'));
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
			title={t('audit.exports.title')}
			description={t('audit.exports.description')}
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
					'audit.exports.denied',
				)}</EmptyState>
			</section>
		} @else {
			<>
				@if (error) {
					<Alert>{error}</Alert>
				}
				<TableCard
					title={t('audit.exports.table.title')}
					count={t('audit.exports.table.count', { count: visible.length })}
					search={<SearchField
						value={query}
						placeholder={t('audit.exports.search.placeholder')}
						label={t('audit.exports.search.label')}
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
							id="audit-exports-status"
							label={t('audit.exports.filter.status')}
							value={statusFilter}
							options={[
								{ value: '', label: t('audit.exports.filter.allStatuses') },
								...EXPORT_STATUSES.map(
									(entry) => ({
										value: entry,
										label: exportStatusLabel(entry),
									}),
								),
							]}
							onChange={(value) => {
								const next = value as ExportStatus | '';
								setStatusFilter(next);
								setPageIndex(0);
								void refresh(next);
							}}
						/>
					</Filters>}
					caption={t('audit.exports.table.caption')}
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
					status={status === 'loading' && runs.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('audit.exports.table.loading')}
					filtered={filtered}
					empty={{
						icon: 'download',
						title: t('audit.exports.empty.title'),
						hint: t('audit.exports.empty.hint'),
					}}
					emptyFiltered={{
						icon: 'search',
						title: t('audit.exports.emptyFiltered.title'),
						hint: t('audit.exports.emptyFiltered.hint'),
					}}
					noteIcon="shield"
					note={t('audit.exports.note')}
				/>
			</>
		}
	</div>
}
