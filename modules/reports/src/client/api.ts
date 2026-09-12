import { t } from '@flowdular/client/i18n';
import type { WorkspaceReportPage } from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: {
		readonly code?: string;
		readonly message?: string;
	};
}

/** A failed request with the server's stable code, so a screen can translate it. */
export class ReportsApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'ReportsApiError';
		this.status = status;
		this.code = code;
	}
}

/**
 * The server message is English and written for an operator. A code this module
 * knows becomes translated copy; anything else keeps the server's own sentence
 * rather than hiding what went wrong behind a generic line.
 */
export function reportsErrorMessage(
	error: unknown,
	fallbackKey: string,
): string {
	if (error instanceof ReportsApiError) {
		const key = 'reports.error.code.' + error.code;
		const translated = t(key);
		if (translated !== key) return translated;
		return error.message;
	}
	if (error instanceof Error && error.message !== '') return error.message;
	return t(fallbackKey);
}

/** A read, so it carries no CSRF token and no body. */
export async function loadReport(range?: {
	readonly from?: string;
	readonly to?: string;
}): Promise<WorkspaceReportPage> {
	const parameters = new URLSearchParams();
	if (range?.from) parameters.set('from', range.from);
	if (range?.to) parameters.set('to', range.to);
	const query = parameters.toString();
	const response = await fetch('/api/reports' + (query ? '?' + query : ''), {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	const value = (await response.json()) as WorkspaceReportPage & ErrorEnvelope;
	if (!response.ok) {
		throw new ReportsApiError(
			response.status,
			value.error?.code ?? 'REQUEST_FAILED',
			value.error?.message ?? t('reports.error.request'),
		);
	}
	return value;
}
