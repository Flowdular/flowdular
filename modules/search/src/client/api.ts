import { t } from '@flowdular/client/i18n';
import type {
	RecentQuery,
	SearchProviderSummary,
	SearchResultHit,
} from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: {
		readonly code?: string;
		readonly message?: string;
	};
}

/** A failed request with the server's stable code, so a screen can translate it. */
export class SearchApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'SearchApiError';
		this.status = status;
		this.code = code;
	}
}

/**
 * The server message is English and written for an operator. A code this module
 * knows becomes translated copy; anything else keeps the server's own sentence
 * rather than hiding what went wrong behind a generic line.
 */
export function searchErrorMessage(
	error: unknown,
	fallbackKey: string,
): string {
	if (error instanceof SearchApiError) {
		const key = 'search.error.code.' + error.code;
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
		throw new SearchApiError(
			response.status,
			value.error?.code ?? 'REQUEST_FAILED',
			value.error?.message ?? t('search.error.request'),
		);
	}
	return value;
}

export interface SearchPage {
	readonly hits: readonly SearchResultHit[];
	readonly nextCursor: string | null;
	readonly providers: readonly SearchProviderSummary[];
	readonly unavailable: readonly string[];
}

export interface SearchRequest {
	readonly query: string;
	readonly provider?: string;
	readonly cursor?: string | null;
	readonly limit?: number;
	/** Keeps the query in recall. Sent only for a submit the member meant. */
	readonly remember?: boolean;
	/** Aborted by the palette when the member types on. */
	readonly signal?: AbortSignal;
}

interface SearchResponse {
	readonly items: readonly SearchResultHit[];
	readonly page: { readonly nextCursor: string | null };
	readonly providers: readonly SearchProviderSummary[];
	readonly unavailable: readonly string[];
}

export async function searchRecords(input: SearchRequest): Promise<SearchPage> {
	const parameters = new URLSearchParams({ q: input.query });
	if (input.provider) parameters.set('provider', input.provider);
	if (input.cursor) parameters.set('cursor', input.cursor);
	if (input.limit) parameters.set('limit', String(input.limit));
	if (input.remember) parameters.set('remember', '1');
	const response = await payload<SearchResponse>(
		await fetch('/api/search?' + parameters.toString(), {
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
			...(input.signal ? { signal: input.signal } : {}),
		}),
	);
	return {
		hits: response.items,
		nextCursor: response.page.nextCursor,
		providers: response.providers,
		unavailable: response.unavailable,
	};
}

export async function loadRecentQueries(): Promise<readonly RecentQuery[]> {
	return (
		await payload<{ readonly items: readonly RecentQuery[] }>(
			await fetch('/api/search/recent', {
				headers: { accept: 'application/json' },
				credentials: 'same-origin',
			}),
		)
	).items;
}

/**
 * Keeps a query in recall without searching again. It is sent while the screen
 * is already navigating to the record the member opened, so `keepalive` is what
 * makes the browser finish the request after the view is gone.
 */
export async function rememberQuery(
	query: string,
	csrfToken: string,
): Promise<boolean> {
	return (
		await payload<{ readonly recorded: boolean }>(
			await fetch('/api/search/recent', {
				method: 'POST',
				headers: {
					accept: 'application/json',
					'content-type': 'application/json',
					'x-csrf-token': csrfToken,
				},
				credentials: 'same-origin',
				keepalive: true,
				body: JSON.stringify({ q: query }),
			}),
		)
	).recorded;
}

export async function clearRecentQueries(csrfToken: string): Promise<number> {
	return (
		await payload<{ readonly cleared: number }>(
			await fetch('/api/search/recent/clear', {
				method: 'POST',
				headers: {
					accept: 'application/json',
					'content-type': 'application/json',
					'x-csrf-token': csrfToken,
				},
				credentials: 'same-origin',
				body: '{}',
			}),
		)
	).cleared;
}
