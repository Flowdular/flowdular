import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	EmptyState,
	Filters,
	Icon,
	PageHeader,
	Select,
	TableCard,
	Tag,
	type TableColumn,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import { useValue } from 'segment-state';
import {
	PROVISIONING_OPERATIONS,
	PROVISIONING_OUTCOMES,
	type ProvisioningEvent,
	type ProvisioningOperation,
	type ProvisioningOutcome,
} from '../domain/types.ts';
import {
	directoryErrorMessage,
	DirectoryApiError,
	loadProvisioningEvents,
} from './api.ts';
import {
	operationLabel,
	outcomeLabel,
	outcomeTone,
	reasonLabel,
	tableEmpty,
	timestampLabel,
} from './presentation.ts';
import { createProvisioningLogClientState } from './state.ts';

function columns(): readonly TableColumn<ProvisioningEvent>[] {
	return [
		{
			key: 'occurredAt',
			header: t('directory.log.column.time'),
			width: '20%',
			value: (event) => event.occurredAt,
			cell: (event) => timestampLabel(event.occurredAt),
		},
		{
			key: 'operation',
			header: t('directory.log.column.operation'),
			width: '20%',
			value: (event) => event.operation,
			cell: (event) => operationLabel(event.operation),
		},
		{
			key: 'subject',
			header: t('directory.log.column.subject'),
			width: '26%',
			value: (event) => event.subject,
			cell: (event) => <span class="ui-mono">{event.subject}</span>,
		},
		{
			key: 'outcome',
			header: t('directory.log.column.outcome'),
			width: '16%',
			value: (event) => event.outcome,
			cell: (event) =>
				<Tag tone={outcomeTone(event.outcome)} dot>{outcomeLabel(
					event.outcome,
				)}</Tag>,
		},
		{
			key: 'reason',
			header: t('directory.log.column.reason'),
			width: '18%',
			value: (event) => event.reason ?? '',
			cell: (event) => reasonLabel(event.reason),
		},
	];
}

export function ProvisioningLogView() @{
	const client = useMemo(() => createProvisioningLogClientState(), []);
	const [events] = useValue(client.state.events);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [operationFilter, setOperationFilter] = useValue(
		client.state.operationFilter,
	);
	const [outcomeFilter, setOutcomeFilter] = useValue(
		client.state.outcomeFilter,
	);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [nextCursor] = useValue(client.state.nextCursor);
	const activeFilters =
		(operationFilter === '' ? 0 : 1) + (outcomeFilter === '' ? 0 : 1);

	/* `append` continues the open listing; anything else starts a new one, so a
   changed filter can never mix two result sets. The filters travel as an
   argument because a select change and the load it starts happen in one
   render, where the state hook still reads the value before the change. */
	const load = async (
		append: boolean,
		filters: {
			readonly operation: ProvisioningOperation | '';
			readonly outcome: ProvisioningOutcome | '';
		} = { operation: operationFilter, outcome: outcomeFilter },
	) => {
		setStatus('loading');
		setError('');
		try {
			const page = await loadProvisioningEvents({
				operation: filters.operation,
				outcome: filters.outcome,
				cursor: append ? nextCursor : null,
			});
			client.store.act((transaction) => {
				transaction.set(
					client.state.events,
					append ? [...events, ...page.items] : page.items,
				);
				transaction.set(client.state.nextCursor, page.page.nextCursor);
				transaction.set(client.state.status, 'idle');
			}, 'directory/log-loaded');
		} catch (loadError) {
			setError(directoryErrorMessage(loadError, 'directory.log.error.load'));
			setStatus(
				loadError instanceof DirectoryApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void load(false);
	}, []);

	<div class="ui-view">
		<PageHeader
			eyebrow={t('directory.common.administration')}
			title={t('directory.log.title')}
			description={t('directory.log.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => void load(false)}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('directory.common.refreshing')
					: t('directory.common.refresh')}
			</Button>
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('directory.common.accessDenied')}>{t(
					'directory.log.denied',
				)}</EmptyState>
			</section>
		} @else {
			<>
				@if (error) {
					<Alert>{error}</Alert>
				}
				<TableCard
					title={t('directory.log.table.title')}
					count={t('directory.log.table.count', { count: events.length })}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={activeFilters}
						label={t('directory.common.filters')}
					>
						<Select
							id="directory-log-operation"
							label={t('directory.log.filter.operation')}
							value={operationFilter}
							options={[
								{ value: '', label: t('directory.log.filter.allOperations') },
								...PROVISIONING_OPERATIONS.map(
									(entry) => ({
										value: entry,
										label: operationLabel(entry),
									}),
								),
							]}
							onChange={(value) => {
								const operation = value as ProvisioningOperation | '';
								setOperationFilter(operation);
								void load(false, { operation, outcome: outcomeFilter });
							}}
						/>
						<Select
							id="directory-log-outcome"
							label={t('directory.log.filter.outcome')}
							value={outcomeFilter}
							options={[
								{ value: '', label: t('directory.log.filter.allOutcomes') },
								...PROVISIONING_OUTCOMES.map(
									(entry) => ({
										value: entry,
										label: outcomeLabel(entry),
									}),
								),
							]}
							onChange={(value) => {
								const outcome = value as ProvisioningOutcome | '';
								setOutcomeFilter(outcome);
								void load(false, { operation: operationFilter, outcome });
							}}
						/>
					</Filters>}
					caption={t('directory.log.table.caption')}
					columns={columns()}
					rows={events}
					rowKey={(event) => event.id}
					status={status === 'loading' && events.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('directory.log.table.loading')}
					filtered={activeFilters > 0}
					empty={tableEmpty(status, {
						icon: 'activity',
						title: t('directory.log.empty.title'),
						hint: t('directory.log.empty.hint'),
					})}
					emptyFiltered={tableEmpty(status, {
						icon: 'search',
						title: t('directory.log.emptyFiltered.title'),
						hint: t('directory.log.emptyFiltered.hint'),
					})}
					after={nextCursor === null
						? null
						: <div class="ui-form__actions">
								<Button
									size="sm"
									disabled={status === 'loading'}
									onClick={() => void load(true)}
								>{t('directory.log.action.more')}</Button>
							</div>}
					noteIcon="shield"
					note={t('directory.log.note')}
				/>
			</>
		}
	</div>
}
