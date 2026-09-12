import { randomUUID } from 'node:crypto';
import { serverLogger } from '@flowdular/server';
import {
	SEARCH_PROVIDER_LIMITS,
	type SearchHit,
	type SearchPrincipal,
	type SearchProviderPage,
} from '../domain/providers.ts';
import {
	SEARCH_LIMITS,
	type RecentQuery,
	type SearchCursor,
	type SearchProviderSummary,
	type SearchResultHit,
	type SearchResultPage,
} from '../domain/types.ts';
import type { RegisteredSearchProvider } from './provider-registry.ts';
import type { MutableSearchProviderRegistry } from './provider-registry.ts';
import type { SearchRepository } from './repository.ts';
import { bounded, SearchServiceError } from './service-error.ts';

/** A workspace-relative path and nothing else: no scheme, no host, no `//`. */
const ROUTE = /^\/(?!\/)[\w\-./~%!$&'()*+,;=:@?#[\]]*$/;
const VIEW_ID = /^[a-z][a-z0-9-]*$/;

export interface SearchBudget {
	/** Time one provider gets for one query. */
	readonly providerTimeoutMs: number;
	/** Hits one provider may answer with per page. */
	readonly hitsPerProvider: number;
}

export interface SearchQueryInput {
	readonly principal: SearchPrincipal;
	readonly query: string;
	readonly limit: number;
	/** Narrows the fan-out to one provider key. */
	readonly provider?: string | undefined;
	readonly cursor?: SearchCursor | null;
	/**
	 * Keeps the query in the member's recall list. Off by default: a debounced
	 * prefix is a keystroke, not a search the member meant to run, so only a
	 * deliberate submit or opening a hit asks for it.
	 */
	readonly remember?: boolean;
}

export interface SearchServiceOptions {
	readonly registry: MutableSearchProviderRegistry;
	readonly repository: SearchRepository;
	/** Read live, so a settings change applies to the next query. */
	readonly budget: () => SearchBudget;
	readonly now?: () => number;
}

function summary(provider: RegisteredSearchProvider): SearchProviderSummary {
	return {
		key: provider.key,
		moduleId: provider.moduleId,
		label: provider.label,
		permission: provider.permission,
	};
}

/**
 * Collapses runs of whitespace so the same words always produce the same recent
 * query row and the same provider input. Over the bound is a refusal; under the
 * minimum is not an error, it just asks nobody.
 */
export function normalizeQuery(raw: unknown): string {
	if (typeof raw !== 'string') {
		throw new SearchServiceError('INVALID_INPUT', 'q must be text.');
	}
	if (raw.length > SEARCH_LIMITS.queryMaximum * 4) {
		throw new SearchServiceError(
			'QUERY_TOO_LONG',
			`q must contain at most ${SEARCH_LIMITS.queryMaximum} characters.`,
		);
	}
	const normalized = raw.replace(/\s+/gu, ' ').trim();
	if (normalized.length > SEARCH_LIMITS.queryMaximum) {
		throw new SearchServiceError(
			'QUERY_TOO_LONG',
			`q must contain at most ${SEARCH_LIMITS.queryMaximum} characters.`,
		);
	}
	if (normalized.includes('\u0000')) {
		throw new SearchServiceError(
			'INVALID_INPUT',
			'q contains an unsupported character.',
		);
	}
	return normalized;
}

function readHit(value: SearchHit, providerKey: string): SearchResultHit {
	const route = String(value?.route ?? '');
	if (
		route.length > SEARCH_PROVIDER_LIMITS.route ||
		!ROUTE.test(route) ||
		!VIEW_ID.test(String(value?.viewId ?? ''))
	) {
		throw new SearchServiceError(
			'PROVIDER_HIT_INVALID',
			`Search provider "${providerKey}" returned a hit with an unusable destination.`,
			502,
		);
	}
	const score = Number(value.score);
	if (!Number.isFinite(score)) {
		throw new SearchServiceError(
			'PROVIDER_HIT_INVALID',
			`Search provider "${providerKey}" returned a hit without a score.`,
			502,
		);
	}
	return {
		provider: providerKey,
		ref: bounded(value.ref, 'ref', 1, SEARCH_PROVIDER_LIMITS.ref),
		title: bounded(value.title, 'title', 1, SEARCH_PROVIDER_LIMITS.title),
		snippet:
			value.snippet === undefined || value.snippet === null
				? ''
				: bounded(value.snippet, 'snippet', 0, SEARCH_PROVIDER_LIMITS.snippet),
		viewId: value.viewId,
		route,
		score,
	};
}

/**
 * What a provider answered, checked and ordered. A provider is foreign code on
 * a request path: nothing it returns reaches a response before it is read here,
 * and anything unreadable makes that provider unavailable rather than failing
 * the search.
 */
function readPage(
	page: SearchProviderPage,
	provider: RegisteredSearchProvider,
	limit: number,
): { readonly hits: readonly SearchResultHit[]; readonly nextCursor: string } {
	if (!page || !Array.isArray(page.hits) || page.hits.length > limit) {
		throw new SearchServiceError(
			'PROVIDER_PAGE_INVALID',
			`Search provider "${provider.key}" answered with more than ${limit} hits.`,
			502,
		);
	}
	const cursor = page.nextCursor ?? '';
	if (
		typeof cursor !== 'string' ||
		cursor.length > SEARCH_PROVIDER_LIMITS.cursor
	) {
		throw new SearchServiceError(
			'PROVIDER_PAGE_INVALID',
			`Search provider "${provider.key}" answered with an oversized cursor.`,
			502,
		);
	}
	const hits = page.hits.map((hit) => readHit(hit, provider.key));
	/* Sorted here, not trusted from the provider: the resume offset counts into
	   this order, so it has to be the same for the same batch every time. */
	hits.sort(
		(left, right) =>
			right.score - left.score || left.ref.localeCompare(right.ref),
	);
	return { hits, nextCursor: cursor };
}

/**
 * One provider call, bounded by the time budget. The losing side of the race is
 * always settled, so an abandoned provider cannot surface later as an unhandled
 * rejection, and the abort listener is removed either way.
 */
async function runProvider(
	provider: RegisteredSearchProvider,
	input: Omit<Parameters<RegisteredSearchProvider['search']>[0], 'signal'>,
	timeoutMs: number,
): Promise<SearchProviderPage> {
	const signal = AbortSignal.timeout(timeoutMs);
	let onAbort: (() => void) | undefined;
	const expiry = new Promise<never>((_resolve, reject) => {
		onAbort = () =>
			reject(
				new SearchServiceError(
					'PROVIDER_TIMEOUT',
					`Search provider "${provider.key}" exceeded its ${timeoutMs} ms budget.`,
					504,
				),
			);
		signal.addEventListener('abort', onAbort, { once: true });
	});
	expiry.catch(() => undefined);
	try {
		return await Promise.race([provider.search({ ...input, signal }), expiry]);
	} finally {
		if (onAbort) signal.removeEventListener('abort', onAbort);
	}
}

export class SearchService {
	readonly #registry: MutableSearchProviderRegistry;
	readonly #repository: SearchRepository;
	readonly #budget: () => SearchBudget;
	readonly #now: () => number;

	constructor(options: SearchServiceOptions) {
		this.#registry = options.registry;
		this.#repository = options.repository;
		this.#budget = options.budget;
		this.#now = options.now ?? Date.now;
	}

	/** Every provider whose permission this principal holds, in merge order. */
	providers(principal: SearchPrincipal): readonly SearchProviderSummary[] {
		return this.#permitted(principal).map(summary);
	}

	async search(input: SearchQueryInput): Promise<SearchResultPage> {
		const principal = input.principal;
		const permitted = this.#permitted(principal, input.provider);
		const providers = permitted.map(summary);
		if (input.query.length < SEARCH_LIMITS.queryMinimum) {
			return { hits: [], nextCursor: null, providers, unavailable: [] };
		}
		const budget = this.#readBudget();
		const start = this.#resumeIndex(permitted, input.cursor ?? null);
		const targets = permitted.slice(start.index);
		const settled = await Promise.allSettled(
			targets.map((provider, offset) =>
				runProvider(
					provider,
					{
						tenantId: principal.tenantId,
						principal,
						query: input.query,
						limit: budget.hitsPerProvider,
						...(offset === 0 && start.cursor !== ''
							? { cursor: start.cursor }
							: {}),
					},
					budget.providerTimeoutMs,
				),
			),
		);

		const unavailable: string[] = [];
		const pages = settled.map((result, offset) => {
			const provider = targets[offset]!;
			if (result.status !== 'fulfilled') {
				unavailable.push(provider.key);
				return null;
			}
			try {
				return readPage(result.value, provider, budget.hitsPerProvider);
			} catch {
				/* A provider that answers nonsense is unavailable for this query; it
				   never turns the member's whole search into an error. */
				unavailable.push(provider.key);
				return null;
			}
		});

		const page = this.#merge(targets, pages, start, input.limit);
		if (input.cursor == null && input.remember === true) {
			await this.#remember(principal, input.query);
		}
		return { ...page, providers, unavailable };
	}

	/**
	 * Keeps one query in the member's own recall list without searching. The
	 * screen uses it when the member opens a hit: the view is already navigating
	 * away, so re-running the whole search only to set the flag would race the
	 * page it is leaving. A query under the minimum is not a search and is not
	 * kept; the answer says whether a row was written.
	 */
	async remember(principal: SearchPrincipal, query: string): Promise<boolean> {
		if (query.length < SEARCH_LIMITS.queryMinimum) return false;
		return this.#remember(principal, query);
	}

	recent(tenantId: string, accountId: string): Promise<readonly RecentQuery[]> {
		return this.#repository.listRecent(
			bounded(tenantId, 'tenantId', 1, SEARCH_LIMITS.tenantId),
			bounded(accountId, 'accountId', 1, SEARCH_LIMITS.accountId),
			SEARCH_LIMITS.recentPerMember,
		);
	}

	clearRecent(tenantId: string, accountId: string): Promise<number> {
		return this.#repository.clearRecent(
			bounded(tenantId, 'tenantId', 1, SEARCH_LIMITS.tenantId),
			bounded(accountId, 'accountId', 1, SEARCH_LIMITS.accountId),
		);
	}

	#permitted(
		principal: SearchPrincipal,
		key?: string | undefined,
	): readonly RegisteredSearchProvider[] {
		const granted = new Set(principal.scopes);
		return this.#registry
			.list()
			.filter(
				(provider) =>
					granted.has(provider.permission) &&
					(key === undefined || provider.key === key),
			);
	}

	#readBudget(): SearchBudget {
		const budget = this.#budget();
		return {
			providerTimeoutMs: Math.min(
				10_000,
				Math.max(200, Math.trunc(budget.providerTimeoutMs)),
			),
			hitsPerProvider: Math.min(
				100,
				Math.max(5, Math.trunc(budget.hitsPerProvider)),
			),
		};
	}

	#resumeIndex(
		permitted: readonly RegisteredSearchProvider[],
		cursor: SearchCursor | null,
	): {
		readonly index: number;
		readonly cursor: string;
		readonly skip: number;
	} {
		if (!cursor) return { index: 0, cursor: '', skip: 0 };
		const index = permitted.findIndex(
			(provider) => provider.key === cursor.provider,
		);
		if (index === -1) {
			throw new SearchServiceError(
				'CURSOR_INVALID',
				'The page cursor does not belong to this search.',
			);
		}
		return { index, cursor: cursor.cursor, skip: cursor.skip };
	}

	/**
	 * Provider-major merge: everything the first provider still has, then the
	 * next. That keeps the resume position to one provider key, one provider
	 * cursor and one offset, whatever the number of providers.
	 *
	 * A cursor is never emitted past a provider that was unavailable on this
	 * request: it would move the position beyond records the member never saw
	 * and can no longer page to. The page ends instead, with the provider named
	 * in `unavailable`, and searching again asks it from the start.
	 */
	#merge(
		targets: readonly RegisteredSearchProvider[],
		pages: readonly ({
			readonly hits: readonly SearchResultHit[];
			readonly nextCursor: string;
		} | null)[],
		start: { readonly cursor: string; readonly skip: number },
		limit: number,
	): {
		readonly hits: readonly SearchResultHit[];
		readonly nextCursor: SearchCursor | null;
	} {
		const hits: SearchResultHit[] = [];
		let skipped = false;
		for (let index = 0; index < targets.length; index += 1) {
			const page = pages[index];
			if (!page) {
				skipped = true;
				continue;
			}
			const provider = targets[index]!;
			const consumed = index === 0 ? start.skip : 0;
			const available = page.hits.slice(consumed);
			const room = limit - hits.length;
			if (available.length > room) {
				hits.push(...available.slice(0, room));
				return {
					hits,
					nextCursor: skipped
						? null
						: {
								provider: provider.key,
								cursor: index === 0 ? start.cursor : '',
								skip: consumed + room,
							},
				};
			}
			hits.push(...available);
			if (hits.length < limit) continue;
			if (skipped) return { hits, nextCursor: null };
			if (page.nextCursor !== '') {
				return {
					hits,
					nextCursor: {
						provider: provider.key,
						cursor: page.nextCursor,
						skip: 0,
					},
				};
			}
			const following = targets[index + 1];
			return {
				hits,
				nextCursor: following
					? { provider: following.key, cursor: '', skip: 0 }
					: null,
			};
		}
		return { hits, nextCursor: null };
	}

	/**
	 * Recall is a convenience, so a failed write is logged and the member still
	 * gets the hits; it is never allowed to turn a working search into an error.
	 * The answer is what was written, for the caller that has only this to report.
	 */
	async #remember(principal: SearchPrincipal, query: string): Promise<boolean> {
		try {
			await this.#repository.recordQuery({
				id: randomUUID(),
				tenantId: principal.tenantId,
				accountId: principal.accountId,
				query,
				ranAt: this.#now(),
				keep: SEARCH_LIMITS.recentPerMember,
			});
			return true;
		} catch (error) {
			serverLogger().warn('recent query not recorded', {
				module: 'search.core',
				err: error,
			});
			return false;
		}
	}
}
