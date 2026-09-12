import type {
	ReportLabelKey,
	ReportRange,
	ReportSeries,
	ReportTile,
} from './providers.ts';

/** Bounds reports.core enforces on a request, independent of any provider. */
export const REPORT_LIMITS = {
	tenantId: 128,
	/**
	 * Widest range one request may ask for. It equals the point bound, so a
	 * daily series over the widest range still fits inside one provider answer.
	 */
	rangeDays: 400,
	defaultRangeDays: 30,
} as const;

/** A provider as the reader sees it, without its read operation. */
export interface ReportProviderSummary {
	readonly key: string;
	readonly moduleId: string;
	readonly label: string;
	readonly labelKey?: ReportLabelKey;
	readonly permission: string;
}

/** One provider's answer, read and bounded, as the screen renders it. */
export interface WorkspaceReport extends ReportProviderSummary {
	readonly tiles: readonly ReportTile[];
	readonly series: readonly ReportSeries[];
	/** The period this provider answered for, when it is not the request range. */
	readonly period?: ReportRange;
}

export interface WorkspaceReportPage {
	readonly range: ReportRange;
	readonly reports: readonly WorkspaceReport[];
	/**
	 * Providers that were asked and could not answer, by key. A provider whose
	 * permission the reader lacks is never asked and never named here.
	 */
	readonly unavailable: readonly string[];
}
