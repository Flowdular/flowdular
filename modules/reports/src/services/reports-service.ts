import {
	REPORT_PROVIDER_LIMITS,
	type ReportPrincipal,
	type ReportProviderAnswer,
	type ReportRange,
	type ReportSeries,
	type ReportTile,
} from '../domain/providers.ts';
import {
	REPORT_LIMITS,
	type ReportProviderSummary,
	type WorkspaceReport,
	type WorkspaceReportPage,
} from '../domain/types.ts';
import type {
	MutableReportProviderRegistry,
	RegisteredReportProvider,
} from './provider-registry.ts';
import { bounded, ReportsServiceError } from './service-error.ts';

/** Widest and narrowest time budget a setting may put on one provider. */
export const PROVIDER_TIMEOUT_RANGE = {
	minimum: 200,
	maximum: 30_000,
} as const;

export interface ReportsBudget {
	/** Time one provider gets for one request. */
	readonly providerTimeoutMs: number;
}

export interface ReportsQueryInput {
	readonly principal: ReportPrincipal;
	readonly range: ReportRange;
}

export interface ReportsServiceOptions {
	readonly registry: MutableReportProviderRegistry;
	/** Read live, so a settings change applies to the next request. */
	readonly budget: () => ReportsBudget;
}

function summary(provider: RegisteredReportProvider): ReportProviderSummary {
	return {
		key: provider.key,
		moduleId: provider.moduleId,
		label: provider.label,
		...(provider.labelKey === undefined ? {} : { labelKey: provider.labelKey }),
		permission: provider.permission,
	};
}

function finite(value: unknown, provider: string, field: string): number {
	const number = typeof value === 'number' ? value : Number.NaN;
	if (!Number.isFinite(number)) {
		throw new ReportsServiceError(
			'PROVIDER_ANSWER_INVALID',
			`Report provider "${provider}" answered with a ${field} that is not a number.`,
			502,
		);
	}
	return number;
}

function readTile(value: ReportTile, provider: string): ReportTile {
	const tile: {
		key: string;
		label: string;
		tileLabelKey?: string;
		value: number;
		unit?: string;
		delta?: number;
	} = {
		key: bounded(value?.key, 'tile key', 1, REPORT_PROVIDER_LIMITS.key),
		label: bounded(value.label, 'tile label', 1, REPORT_PROVIDER_LIMITS.label),
		value: finite(value.value, provider, 'tile value'),
	};
	if (value.tileLabelKey !== undefined && value.tileLabelKey !== null) {
		tile.tileLabelKey = bounded(
			value.tileLabelKey,
			'tile label key',
			1,
			REPORT_PROVIDER_LIMITS.key,
		);
	}
	if (value.unit !== undefined && value.unit !== null) {
		tile.unit = bounded(
			value.unit,
			'tile unit',
			0,
			REPORT_PROVIDER_LIMITS.unit,
		);
	}
	if (value.delta !== undefined && value.delta !== null) {
		tile.delta = finite(value.delta, provider, 'tile delta');
	}
	return tile;
}

function readSeries(value: ReportSeries, provider: string): ReportSeries {
	if (!Array.isArray(value?.points)) {
		throw new ReportsServiceError(
			'PROVIDER_ANSWER_INVALID',
			`Report provider "${provider}" answered with a series without points.`,
			502,
		);
	}
	if (value.points.length > REPORT_PROVIDER_LIMITS.points) {
		throw new ReportsServiceError(
			'PROVIDER_ANSWER_INVALID',
			`Report provider "${provider}" answered with more than ${REPORT_PROVIDER_LIMITS.points} points.`,
			502,
		);
	}
	return {
		key: bounded(value.key, 'series key', 1, REPORT_PROVIDER_LIMITS.key),
		label: bounded(
			value.label,
			'series label',
			1,
			REPORT_PROVIDER_LIMITS.label,
		),
		...(value.seriesLabelKey === undefined || value.seriesLabelKey === null
			? {}
			: {
					seriesLabelKey: bounded(
						value.seriesLabelKey,
						'series label key',
						1,
						REPORT_PROVIDER_LIMITS.key,
					),
				}),
		points: value.points.map((point) => ({
			at: bounded(point?.at, 'point position', 1, REPORT_PROVIDER_LIMITS.at),
			value: finite(point.value, provider, 'point value'),
		})),
	};
}

/**
 * What a provider answered, checked and bounded. A provider is foreign code on
 * a request path: nothing it returns reaches a response before it is read here,
 * and anything unreadable makes that provider unavailable rather than failing
 * the whole report.
 */
export function readAnswer(
	answer: ReportProviderAnswer,
	provider: RegisteredReportProvider,
): {
	readonly tiles: readonly ReportTile[];
	readonly series: readonly ReportSeries[];
	readonly period?: ReportRange;
} {
	if (!answer || !Array.isArray(answer.tiles)) {
		throw new ReportsServiceError(
			'PROVIDER_ANSWER_INVALID',
			`Report provider "${provider.key}" answered without tiles.`,
			502,
		);
	}
	if (answer.tiles.length > REPORT_PROVIDER_LIMITS.tiles) {
		throw new ReportsServiceError(
			'PROVIDER_ANSWER_INVALID',
			`Report provider "${provider.key}" answered with more than ${REPORT_PROVIDER_LIMITS.tiles} tiles.`,
			502,
		);
	}
	const series = answer.series ?? [];
	if (!Array.isArray(series) || series.length > REPORT_PROVIDER_LIMITS.series) {
		throw new ReportsServiceError(
			'PROVIDER_ANSWER_INVALID',
			`Report provider "${provider.key}" answered with more than ${REPORT_PROVIDER_LIMITS.series} series.`,
			502,
		);
	}
	return {
		tiles: answer.tiles.map((tile) => readTile(tile, provider.key)),
		series: series.map((entry) => readSeries(entry, provider.key)),
		/* Bounded like a point position and not checked for shape: a period the
		   screen cannot parse is captioned as the text it is, which costs a
		   caption, while refusing it would cost the reader the numbers. */
		...(answer.period === undefined || answer.period === null
			? {}
			: {
					period: {
						from: bounded(
							answer.period.from,
							'period start',
							1,
							REPORT_PROVIDER_LIMITS.at,
						),
						to: bounded(
							answer.period.to,
							'period end',
							1,
							REPORT_PROVIDER_LIMITS.at,
						),
					},
				}),
	};
}

/**
 * One provider call, bounded by the time budget. The losing side of the race is
 * always settled, so an abandoned provider cannot surface later as an unhandled
 * rejection, and the abort listener is removed either way.
 */
async function runProvider(
	provider: RegisteredReportProvider,
	input: Omit<Parameters<RegisteredReportProvider['read']>[0], 'signal'>,
	timeoutMs: number,
): Promise<ReportProviderAnswer> {
	const signal = AbortSignal.timeout(timeoutMs);
	let onAbort: (() => void) | undefined;
	const expiry = new Promise<never>((_resolve, reject) => {
		onAbort = () =>
			reject(
				new ReportsServiceError(
					'PROVIDER_TIMEOUT',
					`Report provider "${provider.key}" exceeded its ${timeoutMs} ms budget.`,
					504,
				),
			);
		signal.addEventListener('abort', onAbort, { once: true });
	});
	expiry.catch(() => undefined);
	try {
		return await Promise.race([provider.read({ ...input, signal }), expiry]);
	} finally {
		if (onAbort) signal.removeEventListener('abort', onAbort);
	}
}

export class ReportsService {
	readonly #registry: MutableReportProviderRegistry;
	readonly #budget: () => ReportsBudget;

	constructor(options: ReportsServiceOptions) {
		this.#registry = options.registry;
		this.#budget = options.budget;
	}

	/** Every provider whose permission this principal holds, in merge order. */
	providers(principal: ReportPrincipal): readonly ReportProviderSummary[] {
		return this.#permitted(principal).map(summary);
	}

	/**
	 * The workspace report for one range. Every permitted provider is asked in
	 * parallel under the same budget; one that fails, times out or answers
	 * something unreadable is named in `unavailable` and costs the reader that
	 * provider's numbers, never the report.
	 */
	async read(input: ReportsQueryInput): Promise<WorkspaceReportPage> {
		const permitted = this.#permitted(input.principal);
		const timeoutMs = this.#timeout();
		/* The only tenant a provider ever sees, taken from the principal the
		   endpoint resolved and never from anything the request carried. */
		const tenantId = bounded(
			input.principal.tenantId,
			'tenantId',
			1,
			REPORT_LIMITS.tenantId,
		);
		const settled = await Promise.allSettled(
			permitted.map((provider) =>
				runProvider(
					provider,
					{ tenantId, principal: input.principal, range: input.range },
					timeoutMs,
				),
			),
		);

		const reports: WorkspaceReport[] = [];
		const unavailable: string[] = [];
		for (let index = 0; index < permitted.length; index += 1) {
			const provider = permitted[index]!;
			const result = settled[index]!;
			if (result.status !== 'fulfilled') {
				unavailable.push(provider.key);
				continue;
			}
			try {
				reports.push({
					...summary(provider),
					...readAnswer(result.value, provider),
				});
			} catch {
				/* A provider that answers nonsense is unavailable for this request;
				   it never turns the reader's whole report into an error. */
				unavailable.push(provider.key);
			}
		}
		return { range: input.range, reports, unavailable };
	}

	/* Filtering happens here, before any call: a provider the reader may not
	   see is never asked, never listed and never named as unavailable, so the
	   report does not reveal that it exists. */
	#permitted(principal: ReportPrincipal): readonly RegisteredReportProvider[] {
		const granted = new Set(principal.scopes);
		return this.#registry
			.list()
			.filter((provider) => granted.has(provider.permission));
	}

	#timeout(): number {
		const value = this.#budget().providerTimeoutMs;
		if (!Number.isFinite(value)) return PROVIDER_TIMEOUT_RANGE.minimum;
		return Math.min(
			PROVIDER_TIMEOUT_RANGE.maximum,
			Math.max(PROVIDER_TIMEOUT_RANGE.minimum, Math.trunc(value)),
		);
	}
}
