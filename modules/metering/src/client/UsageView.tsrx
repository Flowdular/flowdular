import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	CellTag,
	CellText,
	EmptyState,
	Filters,
	Icon,
	PageHeader,
	SearchField,
	Select,
	TableCard,
	type TableColumn,
} from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client';
import { useValue } from 'segment-state';
import type { MeterUsage } from '../domain/types.ts';
import { loadMeters, MeteringApiError, meteringErrorMessage } from './api.ts';
import {
	kindLabel,
	numberLabel,
	screenSurface,
	usageLabel,
	usageTone,
} from './presentation.ts';
import { createUsageClientState } from './state.ts';

export interface UsageViewProps {
	readonly csrfToken: string;
}

function columns(warningPercent: number): readonly TableColumn<MeterUsage>[] {
	return [
		{
			key: 'key',
			header: t('metering.usage.column.key'),
			width: 'auto',
			cell: (entry) => <CellText value={entry.meter.key} mono />,
		},
		{
			key: 'label',
			header: t('metering.usage.column.label'),
			width: '200px',
			priority: 2,
			cell: (entry) => <CellText value={entry.meter.label} />,
		},
		{
			key: 'unit',
			header: t('metering.usage.column.unit'),
			width: '110px',
			priority: 3,
			cell: (entry) => <CellText value={entry.meter.unit} />,
		},
		{
			key: 'kind',
			header: t('metering.usage.column.kind'),
			width: '120px',
			priority: 3,
			cell: (entry) => <CellText value={kindLabel(entry.meter.kind)} />,
		},
		{
			key: 'used',
			header: t('metering.usage.column.used'),
			width: '200px',
			numeric: true,
			cell: (entry) =>
				<CellTag
					tone={usageTone(entry, warningPercent)}
					dot
					label={usageLabel(entry)}
				/>,
		},
	];
}

export function UsageView(_props: UsageViewProps) @{
	const client = useMemo(() => createUsageClientState(), []);
	const [meters] = useValue(client.state.meters);
	const [warningPercent] = useValue(client.state.warningPercent);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [moduleFilter, setModuleFilter] = useValue(client.state.moduleFilter);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const locale = activeLocale();
	const term = query.trim().toLocaleLowerCase(locale);
	const visible = meters.filter(
		(entry) =>
			(term === '' ||
				entry.meter.key.toLocaleLowerCase(locale).includes(term) ||
				entry.meter.label.toLocaleLowerCase(locale).includes(term)) &&
				(moduleFilter === '' || entry.meter.moduleId === moduleFilter),
	);
	const modules = [
		...new Set(meters.map((entry) => entry.meter.moduleId)),
	].sort();
	const filterCount =
		moduleFilter === '' ? 0 : 1;
	const surface = screenSurface(status);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const page = await loadMeters();
			client.store.act((transaction) => {
				transaction.set(client.state.meters, page.meters);
				transaction.set(client.state.warningPercent, page.warningPercent);
				transaction.set(client.state.status, 'idle');
			}, 'metering/usage-loaded');
		} catch (loadError) {
			setError(meteringErrorMessage(loadError, 'metering.usage.error.load'));
			setStatus(
				loadError instanceof MeteringApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	<div class="ui-view">
		<PageHeader
			eyebrow={t('metering.common.administration')}
			title={t('metering.usage.title')}
			description={t('metering.usage.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => void refresh()}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('metering.common.refreshing')
					: t('metering.common.refresh')}
			</Button>
		</PageHeader>
		@if (surface === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('metering.common.accessDenied')}>{t(
					'metering.usage.denied',
				)}</EmptyState>
			</section>
		} @else if (surface === 'error') {
			<Alert>{error}</Alert>
		} @else {
			<>
				<TableCard
					title={t('metering.usage.table.title')}
					count={t('metering.usage.table.count', { count: visible.length })}
					search={<SearchField
						value={query}
						placeholder={t('metering.usage.search.placeholder')}
						label={t('metering.usage.search.label')}
						onInput={(value: string) => setQuery(value)}
					/>}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={filterCount}
						label={t('metering.common.filters')}
					>
						<Select
							id="metering-usage-module"
							label={t('metering.usage.filter.module')}
							value={moduleFilter}
							options={[
								{
									value: '',
									label: t('metering.usage.filter.allModules'),
								},
								...modules.map(
									(moduleId) => ({ value: moduleId, label: moduleId }),
								),
							]}
							onChange={(value: string) => setModuleFilter(value)}
						/>
					</Filters>}
					caption={t('metering.usage.table.caption')}
					columns={columns(warningPercent)}
					rows={visible}
					rowKey={(entry) => entry.meter.key}
					status={status === 'loading' && meters.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('metering.usage.table.loading')}
					filtered={filterCount > 0 || term !== ''}
					empty={{
						icon: 'activity',
						title: t('metering.usage.empty.title'),
						hint: t('metering.usage.empty.hint'),
					}}
					emptyFiltered={{
						icon: 'search',
						title: t('metering.usage.emptyFiltered.title'),
						hint: t('metering.usage.emptyFiltered.hint'),
					}}
					noteIcon="shield"
					note={t('metering.usage.note', {
						percent: numberLabel(warningPercent),
					})}
				/>
			</>
		}
	</div>
}
