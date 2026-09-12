import { useEffect, useMemo } from 'octane';
import { Kpi } from '@flowdular/ui';
import { activeLocale, t, workspaceViewHref } from '@flowdular/client';
import { useValue } from 'segment-state';
import { loadReport } from './api.ts';
import { REPORTS_VIEWS } from './navigation.ts';
import { largestTiles, numberLabel, resolvedLabel } from './presentation.ts';
import { createReportsWidgetState } from './state.ts';

/** Tiles the dashboard shows; the largest of the whole report come first. */
const TILES = 3;

const REFRESH_INTERVAL_MS = 300_000;

export function ReportsSummaryWidget() @{
	const client = useMemo(() => createReportsWidgetState(), []);
	const [reports] = useValue(client.state.reports);
	const locale = activeLocale();

	useEffect(() => {
		const refresh = async () => {
			try {
				const page = await loadReport();
				client.store.act(
					(transaction) => transaction.set(client.state.reports, page.reports),
					'reports/widget-loaded',
				);
			} catch {
				/* The dashboard shows the tiles it has. A workspace without the
   scope, or a provider that is briefly unreachable, leaves the row
   as it was rather than pushing an error into it. */
			}
		};
		void refresh();
		const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
		return () => clearInterval(timer);
	}, []);

	const largest = largestTiles(reports, TILES);
	const reportsHref = workspaceViewHref(REPORTS_VIEWS.reports);

	@for (const entry of largest; key entry.report.key + '/' + entry.tile.key) {
		<Kpi
			label={resolvedLabel(t, entry.tile.label, entry.tile.tileLabelKey)}
			value={numberLabel(locale, entry.tile.value)}
			unit={entry.tile.unit ?? ''}
			note={resolvedLabel(t, entry.report.label, entry.report.labelKey)}
			href={reportsHref}
			linkLabel={t('reports.widget.link')}
		/>
	}
}
