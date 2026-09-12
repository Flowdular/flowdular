import { t } from '@flowdular/client/i18n';
import type {
	ExportJobStatus,
	ExportJobView,
	ExportListView,
} from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: {
		readonly code?: string;
		readonly message?: string;
	};
}

/** A failed request with the server's stable code, so a screen can translate it. */
export class ExportApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'ExportApiError';
		this.status = status;
		this.code = code;
	}
}

/**
 * The server message is English and written for an operator. A code this module
 * knows becomes translated copy; anything else keeps the server's own sentence
 * rather than hiding what went wrong behind a generic line.
 */
export function exportErrorMessage(
	error: unknown,
	fallbackKey: string,
): string {
	if (error instanceof ExportApiError) {
		const key = 'exports.error.code.' + error.code;
		const translated = t(key);
		if (translated !== key) return translated;
		return error.message;
	}
	if (error instanceof Error && error.message !== '') return error.message;
	return t(fallbackKey);
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new ExportApiError(
			response.status,
			value.error?.code ?? 'REQUEST_FAILED',
			value.error?.message ?? t('exports.error.request'),
		);
	}
	return value;
}

export interface ExportJobPageView {
	readonly items: readonly ExportJobView[];
	readonly nextCursor: string | null;
}

export async function loadExportJobs(
	options: {
		readonly status?: ExportJobStatus | '';
		readonly cursor?: string | null;
	} = {},
): Promise<ExportJobPageView> {
	const query = new URLSearchParams();
	if (options.status) query.set('status', options.status);
	if (options.cursor) query.set('cursor', options.cursor);
	const search = query.toString();
	const response = await fetch(
		'/api/exports/jobs' + (search === '' ? '' : `?${search}`),
		{
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
		},
	);
	const page = await payload<{
		readonly items: readonly ExportJobView[];
		readonly page: { readonly nextCursor: string | null };
	}>(response);
	return { items: page.items, nextCursor: page.page.nextCursor };
}

/** The lists this workspace offers, each marked with whether the reader may export it. */
export async function loadExportLists(): Promise<readonly ExportListView[]> {
	const response = await fetch('/api/exports/lists', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return (
		await payload<{ readonly lists: readonly ExportListView[] }>(response)
	).lists;
}

/** Starts one export. The server decides the permission on the live principal. */
export async function startExport(
	csrfToken: string,
	listId: string,
): Promise<ExportJobView> {
	const response = await fetch('/api/exports/start', {
		method: 'POST',
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify({ list: listId }),
	});
	return (await payload<{ readonly job: ExportJobView }>(response)).job;
}

/** The signed route is minted per click and never kept by the screen. */
export async function exportReadUrl(
	csrfToken: string,
	id: string,
): Promise<string> {
	const response = await fetch('/api/exports/jobs/read-url', {
		method: 'POST',
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify({ id }),
	});
	return (await payload<{ readonly url: string }>(response)).url;
}
