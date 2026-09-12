import type { Translate } from '@flowdular/client/i18n';
import type { ReportRange, ReportTile } from '../domain/providers.ts';
import { REPORT_LIMITS, type WorkspaceReport } from '../domain/types.ts';
import type { ScreenStatus } from './state.ts';

/** Which of the five states the screen renders. */
export type ScreenSurface = 'loading' | 'denied' | 'error' | 'empty' | 'ready';

export function screenSurface(
	status: ScreenStatus,
	reports: readonly WorkspaceReport[],
): ScreenSurface {
	if (status === 'denied') return 'denied';
	if (status === 'error') return 'error';
	if (status === 'loading' && reports.length === 0) return 'loading';
	/* A provider may answer lines without a single number, and that report is
	   something to render rather than an empty screen. */
	return reports.some(
		(report) => report.tiles.length > 0 || report.series.length > 0,
	)
		? 'ready'
		: 'empty';
}

const DAY_MS = 86_400_000;

/**
 * Whether the picked range is wider than one request may ask for. The server
 * refuses the same width with a stable code; the screen checks it first so a
 * reader sees the bound without spending a request on it.
 */
export function rangeTooWide(from: string, to: string): boolean {
	const start = Date.parse(from + 'T00:00:00Z');
	const end = Date.parse(to + 'T00:00:00Z');
	if (Number.isNaN(start) || Number.isNaN(end)) return false;
	return end - start > (REPORT_LIMITS.rangeDays - 1) * DAY_MS;
}

/**
 * A label as the reader should see it. A provider module names its copy with a
 * key into its own bundle; `translate` answers the key itself when that bundle
 * has no such entry, which is when the provider's own literal is used.
 */
export function resolvedLabel(
	translate: Translate,
	label: string,
	key: string | undefined,
): string {
	if (key === undefined || key === '') return label;
	const translated = translate(key);
	return translated === key ? label : translated;
}

/**
 * What one report card says under its name: the period the provider answered
 * for when it named one, and otherwise the range the request asked for.
 */
export function reportCaption(
	translate: Translate,
	day: (value: string) => string,
	report: WorkspaceReport,
	range: ReportRange | null,
): string {
	const period = report.period ?? range;
	if (period === null) return report.moduleId;
	return translate('reports.report.range', {
		module: report.moduleId,
		from: day(period.from),
		to: day(period.to),
	});
}

/** One tile with the report it came from, for a view that flattens them. */
export interface RankedTile {
	readonly report: WorkspaceReport;
	readonly tile: ReportTile;
}

/**
 * The largest tiles of a whole report, biggest first. The dashboard shows a
 * fixed few of these, so the comparison is across providers and the tie-break
 * is the provider key and then the tile key, which keeps the order stable when
 * two providers answer the same number.
 */
export function largestTiles(
	reports: readonly WorkspaceReport[],
	count: number,
): readonly RankedTile[] {
	const ranked: RankedTile[] = [];
	for (const report of reports) {
		for (const tile of report.tiles) ranked.push({ report, tile });
	}
	ranked.sort(
		(left, right) =>
			right.tile.value - left.tile.value ||
			left.report.key.localeCompare(right.report.key) ||
			left.tile.key.localeCompare(right.tile.key),
	);
	return ranked.slice(0, Math.max(0, count));
}

export function numberLabel(locale: string, value: number): string {
	return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
		value,
	);
}

export function deltaLabel(locale: string, value: number): string {
	return new Intl.NumberFormat(locale, {
		maximumFractionDigits: 2,
		signDisplay: 'exceptZero',
	}).format(value);
}

export function dayLabel(locale: string, day: string): string {
	const parsed = Date.parse(day + 'T00:00:00Z');
	if (Number.isNaN(parsed)) return day;
	return new Intl.DateTimeFormat(locale, {
		month: 'numeric',
		day: 'numeric',
		timeZone: 'UTC',
	}).format(new Date(parsed));
}
