/**
 * The public cross-module surface. A module that owns searchable records
 * resolves it while it composes through
 * `context.capabilities.get<SearchProviderRegistry>(SEARCH_PROVIDERS_CAPABILITY)`
 * and continues without registering when it is absent, so a deployment without
 * search.core still boots. Registration closes when search.core starts.
 */
export const SEARCH_PROVIDERS_CAPABILITY = 'search.providers.v1';

/** Who is asking. The provider reads it; it never comes from the request. */
export interface SearchPrincipal {
	readonly accountId: string;
	readonly tenantId: string;
	readonly scopes: readonly string[];
}

export interface SearchProviderQuery {
	readonly tenantId: string;
	readonly principal: SearchPrincipal;
	/** Normalized and bounded by search.core: 2 to 200 characters, no NUL. */
	readonly query: string;
	/** Most hits this call may answer with; a longer page is refused. */
	readonly limit: number;
	/** The provider's own opaque cursor, exactly as it last returned it. */
	readonly cursor?: string;
	/**
	 * Aborted when the provider's time budget expires. A provider that passes it
	 * to its own statements stops working for an answer nobody waits for; one
	 * that ignores it is still abandoned, it just keeps running.
	 */
	readonly signal?: AbortSignal;
}

export interface SearchHit {
	/** Stable reference to the provider's record, unique inside the provider. */
	readonly ref: string;
	readonly title: string;
	readonly snippet: string;
	/** The client view the hit opens: a navigation contribution's view id. */
	readonly viewId: string;
	/** Workspace-relative path starting with "/", such as `/users?member=a1`. */
	readonly route: string;
	/**
	 * Orders hits inside one provider. search.core never compares it across
	 * providers, so a provider is free to score in whatever space it likes.
	 */
	readonly score: number;
}

export interface SearchProviderPage {
	readonly hits: readonly SearchHit[];
	/** Null when the provider has nothing further for this query. */
	readonly nextCursor: string | null;
}

export interface SearchProvider {
	/** `^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$`, unique across every module. */
	readonly key: string;
	readonly label: string;
	/** The scope a member needs before this provider is asked at all. */
	readonly permission: string;
	search(input: SearchProviderQuery): Promise<SearchProviderPage>;
}

export interface SearchProviderRegistry {
	/**
	 * Adds the module's providers in the order given. Provider order is merge
	 * order, and the order modules compose in is the order they register in.
	 * Throws a `SearchServiceError` with a stable code for a malformed provider,
	 * a duplicate key, or a call made after search.core started.
	 */
	register(moduleId: string, providers: readonly SearchProvider[]): void;
}

/** Longest values the registry and the hit reader accept. */
export const SEARCH_PROVIDER_LIMITS = {
	moduleId: 64,
	key: 96,
	label: 120,
	permission: 96,
	ref: 200,
	title: 200,
	snippet: 400,
	viewId: 64,
	route: 512,
	cursor: 256,
	providers: 64,
} as const;
