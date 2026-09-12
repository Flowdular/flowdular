import type { ReportRange } from '../domain/providers.ts';
import { REPORT_LIMITS } from '../domain/types.ts';
import { ReportsServiceError } from './service-error.ts';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/* UTC so a workspace report does not move when a reader's clock does, and the
   same unit every shipped rollup already buckets by. */
export function utcDay(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

function day(value: string, field: string): string {
	const normalized = value.trim();
	if (
		!DAY.test(normalized) ||
		Number.isNaN(Date.parse(`${normalized}T00:00:00Z`))
	) {
		throw new ReportsServiceError(
			'INVALID_RANGE',
			`${field} must be a UTC day in YYYY-MM-DD form.`,
		);
	}
	return normalized;
}

/**
 * The range a request asks for, refused before any provider is called. `to`
 * defaults to today and `from` to the 30 day window ending there, so a client
 * that names neither still gets a bounded answer. The width bound equals the
 * point bound, which is what lets a daily series stay inside one answer.
 */
export function readReportRange(
	input: { readonly from?: string | null; readonly to?: string | null },
	now: number,
): ReportRange {
	const to =
		input.to === undefined || input.to === null || input.to === ''
			? utcDay(now)
			: day(input.to, 'to');
	const from =
		input.from === undefined || input.from === null || input.from === ''
			? utcDay(
					Date.parse(`${to}T00:00:00Z`) -
						(REPORT_LIMITS.defaultRangeDays - 1) * DAY_MS,
				)
			: day(input.from, 'from');
	if (from > to) {
		throw new ReportsServiceError(
			'INVALID_RANGE',
			'from must not be later than to.',
		);
	}
	if (
		Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) >
		(REPORT_LIMITS.rangeDays - 1) * DAY_MS
	) {
		throw new ReportsServiceError(
			'INVALID_RANGE',
			`The range must cover at most ${REPORT_LIMITS.rangeDays} days.`,
		);
	}
	return { from, to };
}
