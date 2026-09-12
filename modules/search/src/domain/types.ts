/** A registered provider as the workspace sees it. */
export interface SearchProviderSummary {
	readonly key: string;
	readonly moduleId: string;
	readonly label: string;
	readonly permission: string;
}

/** A hit as the API answers with it: what the provider returned, plus its key. */
export interface SearchResultHit {
	readonly provider: string;
	readonly ref: string;
	readonly title: string;
	readonly snippet: string;
	readonly viewId: string;
	readonly route: string;
	readonly score: number;
}

/**
 * Where the next page resumes. The merge is provider-major, so one provider
 * key, that provider's own cursor and an offset inside its current batch are
 * the whole position: the cursor never grows with the number of providers.
 */
export interface SearchCursor {
	readonly provider: string;
	readonly cursor: string;
	readonly skip: number;
}

export interface SearchResultPage {
	readonly hits: readonly SearchResultHit[];
	readonly nextCursor: SearchCursor | null;
	/** The providers this principal may see, in merge order. */
	readonly providers: readonly SearchProviderSummary[];
	/** Keys of providers that failed or ran out of time on this request. */
	readonly unavailable: readonly string[];
}

export interface RecentQuery {
	readonly query: string;
	readonly ranAt: number;
}

/** Bounds search.core enforces on its own data and input. */
export const SEARCH_LIMITS = {
	/** Shorter than this answers navigation entries only, and asks no provider. */
	queryMinimum: 2,
	queryMaximum: 200,
	/** Recent queries kept per member and workspace. */
	recentPerMember: 50,
	accountId: 128,
	tenantId: 128,
	pageLimit: 50,
	pageMaximum: 100,
} as const;
