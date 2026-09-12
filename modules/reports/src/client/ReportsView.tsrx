import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	Chart,
	DateRangeField,
	EmptyState,
	Icon,
	Kpi,
	PageHeader,
} from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client';
import { useValue } from 'segment-state';
import { REPORT_LIMITS } from '../domain/types.ts';
import { loadReport, ReportsApiError, reportsErrorMessage } from './api.ts';
import {
	dayLabel,
	deltaLabel,
	numberLabel,
	rangeTooWide,
	reportCaption,
	resolvedLabel,
	screenSurface,
} from './presentation.ts';
import { createReportsClientState } from './state.ts';

export interface ReportsViewProps {
	readonly csrfToken: string;
}

const CHART_HEIGHT = 220;

export function ReportsView(_props: ReportsViewProps) @{
	const client = useMemo(() => createReportsClientState(), []);
	const [reports] = useValue(client.state.reports);
	const [range] = useValue(client.state.range);
	const [unavailable] = useValue(client.state.unavailable);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [from, setFrom] = useValue(client.state.from);
	const [to, setTo] = useValue(client.state.to);
	const locale = activeLocale();

	const refresh = async (asked: { from: string; to: string }) => {
		setStatus('loading');
		setError('');
		try {
			const page = await loadReport(asked);
			client.store.act((transaction) => {
				transaction.set(client.state.reports, page.reports);
				transaction.set(client.state.range, page.range);
				transaction.set(client.state.unavailable, page.unavailable);
				transaction.set(client.state.from, page.range.from);
				transaction.set(client.state.to, page.range.to);
				transaction.set(client.state.status, 'idle');
			}, 'reports/loaded');
		} catch (loadError) {
			setError(reportsErrorMessage(loadError, 'reports.error.load'));
			setStatus(
				loadError instanceof ReportsApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	/* The server refuses a range past the same bound, so the screen keeps the
   reader's dates and says so instead of spending a request on the answer. */
	const ask = (asked: { from: string; to: string }) => {
		if (!rangeTooWide(asked.from, asked.to)) {
			void refresh(asked);
			return;
		}
		client.store.act((transaction) => {
			transaction.set(
				client.state.error,
				t('reports.range.tooWide', { days: REPORT_LIMITS.rangeDays }),
			);
			transaction.set(client.state.status, 'error');
		}, 'reports/range-too-wide');
	};

	useEffect(() => {
		void refresh({ from: '', to: '' });
	}, []);

	const surface = screenSurface(status, reports);

	<div class="ui-view">
		<PageHeader
			eyebrow={t('reports.page.eyebrow')}
			title={t('reports.page.title')}
			description={t('reports.page.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => ask({ from, to })}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('reports.action.refreshing')
					: t('reports.action.refresh')}
			</Button>
		</PageHeader>
		@if (surface === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('reports.denied.title')}>{t(
					'reports.denied.hint',
				)}</EmptyState>
			</section>
		} @else {
			<>
				@if (surface === 'error') {
					<Alert>{error}</Alert>
				}
				<section class="ui-card">
					<div class="ui-card__body">
						<DateRangeField
							id="reports-range"
							legend={t('reports.range.legend')}
							fromLabel={t('reports.range.from')}
							toLabel={t('reports.range.to')}
							value={{ from, to }}
							locale={locale}
							reversedMessage={t('reports.range.reversed')}
							help={t('reports.range.help')}
							error={surface === 'error' ? error : ''}
							disabled={status === 'loading'}
							onChange={(value: { from: string; to: string }) => {
								setFrom(value.from);
								setTo(value.to);
								if (
									value.from !== '' && value.to !== '' && value.from <= value.to
								) {
									ask(value);
								}
							}}
						/>
					</div>
				</section>
			</>
		}
		@if (surface !== 'denied' && surface !== 'error') {
			<>
				@if (unavailable.length > 0) {
					<Alert tone="warning">{t('reports.unavailable', {
						providers: unavailable.join(', '),
					})}</Alert>
				}
				@if (surface === 'loading') {
					<section class="ui-card">
						<EmptyState icon="activity" title={t('reports.loading.title')}>{t(
							'reports.loading.hint',
						)}</EmptyState>
					</section>
				} @else if (surface === 'empty') {
					<section class="ui-card">
						<EmptyState icon="activity" title={t('reports.empty.title')}>{t(
							'reports.empty.hint',
						)}</EmptyState>
					</section>
				} @else {
					<>
						@for (const report of reports; key report.key) {
							<section class="ui-card">
								<div class="ui-card__head">
									<span class="ui-card__title">
										{resolvedLabel(t, report.label, report.labelKey)}
										<small>{reportCaption(
											t,
											(value: string) => dayLabel(locale, value),
											report,
											range,
										)}</small>
									</span>
								</div>
								<div class="ui-card__body">
									@if (report.tiles.length === 0) {
										<EmptyState
											icon="activity"
											title={t('reports.report.emptyTitle')}
										>{t('reports.report.emptyHint')}</EmptyState>
									} @else {
										<div class="ui-kpi-grid">
											@for (const tile of report.tiles; key tile.key) {
												<Kpi
													label={resolvedLabel(
														t,
														tile.label,
														tile.tileLabelKey,
													)}
													value={numberLabel(locale, tile.value)}
													unit={tile.unit ?? ''}
													note={tile.delta === undefined
														? ''
														: t('reports.tile.delta', {
																delta: deltaLabel(locale, tile.delta),
															})}
												/>
											}
										</div>
									}
									@for (const series of report.series; key series.key) {
										<Chart
											type="area"
											xKey="at"
											height={CHART_HEIGHT}
											title={resolvedLabel(
												t,
												series.label,
												series.seriesLabelKey,
											)}
											data={series.points}
											series={[
												{
													key: 'value',
													label: resolvedLabel(
														t,
														series.label,
														series.seriesLabelKey,
													),
												},
											]}
											xTickFormatter={(value: string) => dayLabel(
												locale,
												value,
											)}
											valueFormatter={(value: number) => numberLabel(
												locale,
												value,
											)}
											emptyIcon="activity"
											emptyTitle={t('reports.series.emptyTitle')}
											emptyHint={t('reports.series.emptyHint')}
										/>
									}
								</div>
							</section>
						}
					</>
				}
			</>
		}
	</div>
}
