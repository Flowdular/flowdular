import {
	REPORT_PROVIDER_LIMITS,
	type ReportProvider,
	type ReportProviderAnswer,
	type ReportRange,
	type ReportTile,
} from '@flowdular/module-reports';
import { METERING_PERMISSIONS } from '../acl/permissions.ts';
import type { MeterUsage } from '../domain/types.ts';
import type { MeteringService } from './metering-service.ts';

export const METERING_REPORT_PROVIDER_KEY = 'metering.usage';

/**
 * The label states the period because the tiles are this calendar month's
 * rollup whatever range the reader picked: metering counts per month against
 * the operator's monthly limit, and a slice of a month would not compare with
 * that limit.
 */
export const METERING_REPORT_PROVIDER_LABEL = 'Usage this month';

/** This module's own bundle names the period; the literal above is the fallback. */
export const METERING_REPORT_PROVIDER_LABEL_KEY = 'metering.report.usage.label';

/**
 * The calendar month a `YYYY-MM` rollup covers, both days included. Day zero of
 * the next month is the last day of this one, so February and a 30 day month
 * are captioned with the day they actually end on.
 */
export function monthPeriod(month: string): ReportRange {
	const year = Number(month.slice(0, 4));
	const ordinal = Number(month.slice(5, 7));
	return {
		from: `${month}-01`,
		to: new Date(Date.UTC(year, ordinal, 0)).toISOString().slice(0, 10),
	};
}

/**
 * The limit carried as the unit's context, so a tile reads "412 requests of
 * 1000" without the contract growing a field only this provider would use. A
 * composed unit past the contract's bound would make the whole provider
 * unavailable, so an unusually long meter unit keeps its bare form instead.
 */
export function unitWithLimit(unit: string, limit: number | null): string {
	if (limit === null) return unit.slice(0, REPORT_PROVIDER_LIMITS.unit);
	const composed = `${unit} of ${limit}`;
	return composed.length > REPORT_PROVIDER_LIMITS.unit
		? unit.slice(0, REPORT_PROVIDER_LIMITS.unit)
		: composed;
}

/**
 * One tile per meter, busiest first, bounded to what a provider answer carries.
 * A workspace with more meters than that shows the ones it spends on; the Usage
 * screen still lists every one.
 */
export function usageTiles(
	usage: readonly MeterUsage[],
): readonly ReportTile[] {
	return [...usage]
		.sort(
			(left, right) =>
				right.used - left.used || left.meter.key.localeCompare(right.meter.key),
		)
		.slice(0, REPORT_PROVIDER_LIMITS.tiles)
		.map((entry) => ({
			key: entry.meter.key,
			label: entry.meter.label,
			value: entry.used,
			unit: unitWithLimit(entry.meter.unit, entry.limit),
		}));
}

function aborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

/**
 * This workspace's metered usage as a report provider. The read goes through
 * this module's own service under its own tenant transaction, with the tenant
 * reports.core resolved from the principal, so no table crosses a module line.
 */
export function createUsageReportProvider(
	service: () => Promise<MeteringService>,
): ReportProvider {
	return {
		key: METERING_REPORT_PROVIDER_KEY,
		label: METERING_REPORT_PROVIDER_LABEL,
		labelKey: METERING_REPORT_PROVIDER_LABEL_KEY,
		permission: METERING_PERMISSIONS.read,
		async read({ tenantId, signal }): Promise<ReportProviderAnswer> {
			if (aborted(signal)) return { tiles: [] };
			const metering = await service();
			const usage = await metering.usage(tenantId, { signal });
			if (aborted(signal)) return { tiles: [] };
			/* The tiles are one calendar month whatever range was asked for, so
			   the answer names that month. It is taken from the rows, which carry
			   the month the read itself used, so a read that crosses a month
			   boundary still captions the numbers it actually got. */
			const month = usage[0]?.month ?? metering.currentMonth();
			return { tiles: usageTiles(usage), period: monthPeriod(month) };
		},
	};
}
