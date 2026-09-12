import { useEffect, useMemo } from 'octane';
import { Kpi } from '@flowdular/ui';
import { activeLocale, t, workspaceViewHref } from '@flowdular/client';
import { useValue } from 'segment-state';
import { loadMeters } from './api.ts';
import { METERING_VIEWS } from './navigation.ts';
import { numberLabel, usageLabel, usageShare } from './presentation.ts';
import { createUsageClientState } from './state.ts';

/** Tiles the dashboard shows; the busiest meters of the month come first. */
const TILES = 3;

const REFRESH_INTERVAL_MS = 300_000;

export function UsageSummaryWidget() @{
	const client = useMemo(() => createUsageClientState(), []);
	const [meters] = useValue(client.state.meters);
	const [warningPercent] = useValue(client.state.warningPercent);
	const locale = activeLocale();

	useEffect(() => {
		const refresh = async () => {
			try {
				const page = await loadMeters();
				client.store.act((transaction) => {
					transaction.set(client.state.meters, page.meters);
					transaction.set(client.state.warningPercent, page.warningPercent);
				}, 'metering/widget-loaded');
			} catch {
				/* The dashboard shows the tiles it has. A workspace without the
   scope, or a metering module that is briefly unreachable, leaves
   the row as it was rather than pushing an error into it. */
			}
		};
		void refresh();
		const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
		return () => clearInterval(timer);
	}, []);

	const busiest = [...meters].sort(
		(left, right) => right.used - left.used,
	).slice(0, TILES).filter((entry) => entry.used > 0);
	const usageHref = workspaceViewHref(METERING_VIEWS.usage);

	@for (const entry of busiest; key entry.meter.key) {
		<Kpi
			label={entry.meter.label}
			value={new Intl.NumberFormat(locale).format(entry.used)}
			unit={entry.meter.unit}
			note={entry.limit === null
				? t('metering.widget.unlimited')
				: t('metering.widget.share', {
						percent: numberLabel(usageShare(entry) ?? 0),
						usage: usageLabel(entry),
					})}
			badge={(usageShare(entry) ?? 0) >= warningPercent
				? t('metering.widget.attention')
				: ''}
			href={usageHref}
			linkLabel={t('metering.widget.link')}
		/>
	}
}
