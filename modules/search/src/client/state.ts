import { cell, createStore } from 'segment-state';
import {
	SEARCH_LIMITS,
	type RecentQuery,
	type SearchProviderSummary,
	type SearchResultHit,
} from '../domain/types.ts';
import type { SearchPage } from './api.ts';

/** `denied` is a 403 the shell could not hide; `error` is everything else. */
export type ScreenStatus =
	| 'idle'
	| 'loading'
	| 'submitting'
	| 'denied'
	| 'error';

export function createSearchClientState() {
	const store = createStore({
		hits: cell<readonly SearchResultHit[]>([]),
		providers: cell<readonly SearchProviderSummary[]>([]),
		unavailable: cell<readonly string[]>([]),
		recent: cell<readonly RecentQuery[]>([]),
		status: cell<ScreenStatus>('idle'),
		error: '',
		query: '',
		/* '' searches every provider the member may see. */
		providerFilter: '',
		filtersOpen: false,
		nextCursor: cell<string | null>(null),
		/** True once a query has been run, so "no hits" is not shown before one. */
		searched: false,
	});
	return { store, state: store.state };
}

export type SearchClientState = ReturnType<typeof createSearchClientState>;

/**
 * One answered page on the screen. `append` is the load-more path: the hits
 * that arrived under a cursor extend the list instead of replacing it, and the
 * new cursor is what a further page resumes from.
 */
export function applyPage(
	client: SearchClientState,
	page: SearchPage,
	options: { readonly term: string; readonly append: boolean },
): void {
	client.store.act((transaction) => {
		transaction.set(
			client.state.hits,
			options.append
				? [...transaction.get(client.state.hits), ...page.hits]
				: page.hits,
		);
		transaction.set(client.state.providers, page.providers);
		transaction.set(client.state.unavailable, page.unavailable);
		transaction.set(client.state.nextCursor, page.nextCursor);
		transaction.set(client.state.status, 'idle');
		/* The first load asks with an empty query to get the provider list, and
		   that must not turn the empty table into "nothing matched". */
		transaction.set(
			client.state.searched,
			options.term.length >= SEARCH_LIMITS.queryMinimum,
		);
	}, 'search/loaded');
}

/**
 * Whether an answer that has just arrived may still be written. Two things move
 * while a request is in flight and each one alone invalidates it: a newer
 * request was dispatched, and only the newest may write; and the member changed
 * the term, which no answer to the old term describes, including back under the
 * minimum where the screen shows nothing at all.
 *
 * The term is compared against the box rather than counted out by a ticket
 * because the screen's one provider-list load asks with no term: retiring every
 * request on a term under the minimum would retire that load at mount, before
 * the member has typed anything, and leave the provider filter empty for good.
 */
export function answerIsCurrent(
	client: SearchClientState,
	term: string,
	ticket: number,
	requests: { readonly current: number },
): boolean {
	return (
		requests.current === ticket &&
		client.store.get(client.state.query).trim() === term
	);
}

/**
 * Back below the minimum query length. The hits of the longer term are gone,
 * so they are dropped with the page position rather than left on screen under
 * a term that never produced them.
 */
export function clearResults(client: SearchClientState): void {
	client.store.act((transaction) => {
		transaction.set(client.state.hits, []);
		transaction.set(client.state.unavailable, []);
		transaction.set(client.state.nextCursor, null);
		transaction.set(client.state.searched, false);
		transaction.set(client.state.status, 'idle');
	}, 'search/cleared');
}

/** The provider label behind a hit, or its key when the provider is unknown. */
export function providerLabels(
	providers: readonly SearchProviderSummary[],
): ReadonlyMap<string, string> {
	return new Map(providers.map((provider) => [provider.key, provider.label]));
}
