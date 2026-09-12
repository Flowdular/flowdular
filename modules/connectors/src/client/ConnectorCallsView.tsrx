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
	CONNECTOR_CALL_OUTCOMES,
	type ConnectorCall,
	type ConnectorCallOutcome,
} from '../domain/types.ts';
import {
	ConnectorsApiError,
	connectorsErrorMessage,
	loadConnectorCalls,
	loadConnectorInstances,
} from './api.ts';
import {
	durationLabel,
	outcomeLabel,
	outcomeTone,
	timestampLabel,
} from './presentation.ts';
import { createConnectorCallsClientState } from './state.ts';

export interface ConnectorCallsViewProps {
	readonly csrfToken: string;
}

const PAGE_SIZES = [25, 50, 100, 200];

function columns(
	instanceName: (id: string) => string,
): readonly TableColumn<ConnectorCall>[] {
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
			value: (call) => instanceName(call.instanceId),
			cell: (call) => <span>{instanceName(call.instanceId)}</span>,
		},
		{
			key: 'operation',
			header: t('connectors.calls.column.operation'),
			width: '12%',
			value: (call) => call.operation,
			cell: (call) => <span class="ui-mono">{call.operation}</span>,
		},
		{
			key: 'caller',
			header: t('connectors.calls.column.caller'),
			width: '10%',
			value: (call) => call.caller,
			cell: (call) => <span>{t('connectors.caller.' + call.caller)}</span>,
		},
		{
			key: 'outcome',
			header: t('connectors.calls.column.outcome'),
			width: '12%',
			value: (call) => call.outcome,
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
			value: (call) => call.status ?? 0,
			cell: (call) =>
				<span class="num">{call.status ?? t('connectors.common.none')}</span>,
		},
		{
			key: 'errorClass',
			header: t('connectors.calls.column.errorClass'),
			width: '14%',
			value: (call) => call.errorClass ?? '',
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
			value: (call) => call.durationMs,
			cell: (call) => <span class="num">{durationLabel(call.durationMs)}</span>,
		},
	];
}

export function ConnectorCallsView(_props: ConnectorCallsViewProps) @{
	const client = useMemo(() => createConnectorCallsClientState(), []);
	const [calls] = useValue(client.state.calls);
	const [instances] = useValue(client.state.instances);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [outcomeFilter, setOutcomeFilter] = useValue(
		client.state.outcomeFilter,
	);
	const [instanceFilter, setInstanceFilter] = useValue(
		client.state.instanceFilter,
	);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [pageIndex, setPageIndex] = useState(0);
	const [pageSize, setPageSize] = useState(50);
	const locale = activeLocale();
	const names = useMemo(
		() => new Map(instances.map((instance) => [instance.id, instance.name])),
		[instances],
	);
	const instanceName = (id: string) =>
		names.get(id) ?? t('connectors.calls.deletedInstance');
	const term = query.trim().toLocaleLowerCase(locale);
	const visible = calls.filter(
		(call) =>
			term === '' || call.operation.toLocaleLowerCase(locale).includes(term) ||
				instanceName(call.instanceId).toLocaleLowerCase(locale).includes(term),
	);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const [loaded, owners] = await Promise.all([
				loadConnectorCalls({
					outcome: outcomeFilter,
					instanceId: instanceFilter,
				}),
				loadConnectorInstances(),
			]);
			client.store.act((transaction) => {
				transaction.set(client.state.calls, loaded);
				transaction.set(client.state.instances, owners);
				transaction.set(client.state.status, 'idle');
			}, 'connectors/calls-loaded');
		} catch (loadError) {
			setError(connectorsErrorMessage(loadError, 'connectors.calls.errorLoad'));
			setStatus(
				loadError instanceof ConnectorsApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void refresh();
	}, [outcomeFilter, instanceFilter]);

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
					count={t('connectors.calls.count', { count: visible.length })}
					search={<SearchField
						value={query}
						placeholder={t('connectors.calls.searchPlaceholder')}
						label={t('connectors.calls.searchLabel')}
						onInput={(value) => {
							setQuery(value);
							setPageIndex(0);
						}}
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
								setOutcomeFilter(value as ConnectorCallOutcome | '');
								setPageIndex(0);
							}}
						/>
						<Select
							id="connectors-calls-instance"
							label={t('connectors.calls.filterInstance')}
							value={instanceFilter}
							options={[
								{ value: '', label: t('connectors.calls.allInstances') },
								...instances.map(
									(instance) => ({
										value: instance.id,
										label: instance.name,
									}),
								),
							]}
							onChange={(value) => {
								setInstanceFilter(value);
								setPageIndex(0);
							}}
						/>
					</Filters>}
					caption={t('connectors.calls.caption')}
					columns={columns(instanceName)}
					rows={visible}
					rowKey={(call) => call.id}
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
						label={t('connectors.pagination.label')}
						previousLabel={t('connectors.pagination.previous')}
						nextLabel={t('connectors.pagination.next')}
						pageSizeLabel={t('connectors.pagination.size')}
						summary={(range) => t('connectors.pagination.summary', {
							page: range.pageIndex + 1,
							pages: range.pageCount,
							from: range.from,
							to: range.to,
							total: range.totalRows,
						})}
					/>}
					status={status === 'loading' && calls.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('connectors.calls.loading')}
					filtered={term !== '' || outcomeFilter !== '' ||
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
