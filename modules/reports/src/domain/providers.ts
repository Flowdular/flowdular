/**
 * The public cross-module surface. A module that owns a rollup resolves it
 * while it composes through
 * `context.capabilities.get<ReportProviderRegistry>(REPORTS_PROVIDERS_CAPABILITY)`
 * and continues without registering when it is absent, so a deployment without
 * reports.core still boots. Registration closes when reports.core starts.
 */
export const REPORTS_PROVIDERS_CAPABILITY = 'reports.v1';

/** Who is asking. The provider reads it; it never comes from the request. */
export interface ReportPrincipal {
	readonly accountId: string;
	readonly tenantId: string;
	readonly scopes: readonly string[];
}

/** Two UTC days, both inclusive, already validated and bounded by reports.core. */
export interface ReportRange {
	/** `YYYY-MM-DD`. */
	readonly from: string;
	/** `YYYY-MM-DD`, never earlier than `from`. */
	readonly to: string;
}

export interface ReportProviderQuery {
	readonly tenantId: string;
	readonly principal: ReportPrincipal;
	readonly range: ReportRange;
	/**
	 * Aborted when the provider's time budget expires. A provider that passes it
	 * to its own statements stops working for an answer nobody waits for; one
	 * that ignores it is still abandoned, it just keeps running.
	 */
	readonly signal?: AbortSignal;
}

/**
 * A key in the provider module's own translation bundle, fully qualified the
 * way `t()` takes it. reports.core renders the translation when that bundle
 * carries the key in the reader's locale and the literal label beside it when
 * it does not, so a provider that ships no bundle still names itself.
 */
export type ReportLabelKey = string;

/** One number of a report. The unit carries whatever context the owner wants. */
export interface ReportTile {
	/** Unique inside the provider; `^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$`. */
	readonly key: string;
	readonly label: string;
	readonly tileLabelKey?: ReportLabelKey;
	readonly value: number;
	readonly unit?: string;
	/** Change against the provider's own comparison period, when it states one. */
	readonly delta?: number;
}

export interface ReportSeriesPoint {
	/** The position on the range axis; a UTC day for the shipped providers. */
	readonly at: string;
	readonly value: number;
}

export interface ReportSeries {
	readonly key: string;
	readonly label: string;
	readonly seriesLabelKey?: ReportLabelKey;
	readonly points: readonly ReportSeriesPoint[];
}

export interface ReportProviderAnswer {
	readonly tiles: readonly ReportTile[];
	readonly series?: readonly ReportSeries[];
	/**
	 * The period these numbers actually cover, when it is not the range that
	 * was asked for. A provider that rolls up by its own period answers that
	 * period here, so the screen captions the card with what it is showing
	 * rather than with what it asked for.
	 */
	readonly period?: ReportRange;
}

export interface ReportProvider {
	/** `^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$`, unique across every module. */
	readonly key: string;
	readonly label: string;
	readonly labelKey?: ReportLabelKey;
	/** The scope a reader needs before this provider is asked at all. */
	readonly permission: string;
	read(input: ReportProviderQuery): Promise<ReportProviderAnswer>;
}

export interface ReportProviderRegistry {
	/**
	 * Adds the module's providers in the order given. Provider order is the
	 * order the screen renders in, and the order modules compose in is the order
	 * they register in. Throws a `ReportsServiceError` with a stable code for a
	 * malformed provider, a duplicate key, or a call made after reports.core
	 * started.
	 */
	register(moduleId: string, providers: readonly ReportProvider[]): void;
}

/** Largest values the registry and the answer reader accept. */
export const REPORT_PROVIDER_LIMITS = {
	moduleId: 64,
	key: 96,
	label: 120,
	permission: 96,
	unit: 32,
	at: 32,
	providers: 64,
	tiles: 16,
	series: 8,
	points: 400,
} as const;
