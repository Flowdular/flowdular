import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	EmptyState,
	Icon,
	PageHeader,
	SearchField,
	TableCard,
	type TableColumn,
} from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client';
import { useValue } from 'segment-state';
import type { MeterLimit } from '../domain/types.ts';
import {
	loadLimits,
	loadMeters,
	MeteringApiError,
	meteringErrorMessage,
} from './api.ts';
import { numberLabel, screenSurface, timestampLabel } from './presentation.ts';
import { createLimitsClientState } from './state.ts';

export interface LimitsViewProps {
	readonly csrfToken: string;
}

function columns(
	used: ReadonlyMap<string, number>,
): readonly TableColumn<MeterLimit>[] {
	return [
		{
			key: 'meter',
			header: t('metering.limits.column.meter'),
			width: '34%',
			cell: (limit) => <span class="ui-mono">{limit.meter}</span>,
		},
		{
			key: 'monthlyLimit',
			header: t('metering.limits.column.monthlyLimit'),
			width: '20%',
			numeric: true,
			cell: (limit) => numberLabel(limit.monthlyLimit),
		},
		{
			key: 'used',
			header: t('metering.limits.column.used'),
			width: '16%',
			numeric: true,
			cell: (limit) => numberLabel(used.get(limit.meter) ?? 0),
		},
		{
			key: 'setBy',
			header: t('metering.limits.column.setBy'),
			width: '16%',
			cell: (limit) => limit.setBy,
		},
		{
			key: 'updatedAt',
			header: t('metering.limits.column.updatedAt'),
			width: '14%',
			cell: (limit) => timestampLabel(limit.updatedAt),
		},
	];
}

export function LimitsView(_props: LimitsViewProps) @{
	const client = useMemo(() => createLimitsClientState(), []);
	const [limits] = useValue(client.state.limits);
	const [meters] = useValue(client.state.meters);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const locale = activeLocale();
	const term = query.trim().toLocaleLowerCase(locale);
	const visible =
		term === ''
			? limits
			: limits.filter(
					(limit) => limit.meter.toLocaleLowerCase(locale).includes(term),
				);
	const used = new Map(meters.map((entry) => [entry.meter.key, entry.used]));
	const surface = screenSurface(status);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const [loaded, page] = await Promise.all([loadLimits(), loadMeters()]);
			client.store.act((transaction) => {
				transaction.set(client.state.limits, loaded);
				transaction.set(client.state.meters, page.meters);
				transaction.set(client.state.status, 'idle');
			}, 'metering/limits-loaded');
		} catch (loadError) {
			setError(meteringErrorMessage(loadError, 'metering.limits.error.load'));
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
			title={t('metering.limits.title')}
			description={t('metering.limits.description')}
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
					'metering.limits.denied',
				)}</EmptyState>
			</section>
		} @else if (surface === 'error') {
			<Alert>{error}</Alert>
		} @else {
			<>
				<TableCard
					title={t('metering.limits.table.title')}
					count={t('metering.limits.table.count', { count: visible.length })}
					search={<SearchField
						value={query}
						placeholder={t('metering.limits.search.placeholder')}
						label={t('metering.limits.search.label')}
						onInput={(value: string) => setQuery(value)}
					/>}
					caption={t('metering.limits.table.caption')}
					columns={columns(used)}
					rows={visible}
					rowKey={(limit) => limit.id}
					status={status === 'loading' && limits.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('metering.limits.table.loading')}
					filtered={term !== ''}
					empty={{
						icon: 'shield',
						title: t('metering.limits.empty.title'),
						hint: t('metering.limits.empty.hint'),
					}}
					emptyFiltered={{
						icon: 'search',
						title: t('metering.limits.emptyFiltered.title'),
						hint: t('metering.limits.emptyFiltered.hint'),
					}}
					noteIcon="shield"
					note={t('metering.limits.note')}
				/>
			</>
		}
	</div>
}
