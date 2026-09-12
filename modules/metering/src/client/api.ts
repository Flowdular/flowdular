import { t } from '@flowdular/client/i18n';
import type { MeterLimit, MeterUsage, UsageBucket } from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: {
		readonly code?: string;
		readonly message?: string;
	};
}

/** A failed request with the server's stable code, so a screen can translate it. */
export class MeteringApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'MeteringApiError';
		this.status = status;
		this.code = code;
	}
}

/**
 * The server message is English and written for an operator. A code this module
 * knows becomes translated copy; anything else keeps the server's own sentence
 * rather than hiding what went wrong behind a generic line.
 */
export function meteringErrorMessage(
	error: unknown,
	fallbackKey: string,
): string {
	if (error instanceof MeteringApiError) {
		const key = 'metering.error.code.' + error.code;
		const translated = t(key);
		if (translated !== key) return translated;
		return error.message;
	}
	if (error instanceof Error && error.message !== '') return error.message;
	return t(fallbackKey);
}

async function get<T>(path: string): Promise<T> {
	const response = await fetch(path, {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new MeteringApiError(
			response.status,
			value.error?.code ?? 'REQUEST_FAILED',
			value.error?.message ?? t('metering.error.request'),
		);
	}
	return value;
}

export interface MetersPage {
	readonly meters: readonly MeterUsage[];
	/** The share of a limit the server notifies the owners at. */
	readonly warningPercent: number;
}

export async function loadMeters(): Promise<MetersPage> {
	const page = await get<MetersPage>('/api/metering/meters');
	return { meters: page.meters, warningPercent: page.warningPercent };
}

export async function loadBuckets(query: {
	readonly meter: string;
	readonly from?: string;
	readonly to?: string;
}): Promise<readonly UsageBucket[]> {
	const parameters = new URLSearchParams({ meter: query.meter });
	if (query.from) parameters.set('from', query.from);
	if (query.to) parameters.set('to', query.to);
	return (
		await get<{ readonly buckets: readonly UsageBucket[] }>(
			'/api/metering/buckets?' + parameters.toString(),
		)
	).buckets;
}

export async function loadLimits(): Promise<readonly MeterLimit[]> {
	return (
		await get<{ readonly limits: readonly MeterLimit[] }>(
			'/api/metering/limits',
		)
	).limits;
}
