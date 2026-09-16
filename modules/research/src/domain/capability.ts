/*
 * The cross-module contract. A module resolves these through
 * `context.capabilities.get<T>(id)` and declares the id under `requires`.
 */
export const RESEARCH_SEARCH_CAPABILITY = 'research.search.v1';
export const RESEARCH_FETCH_CAPABILITY = 'research.fetch.v1';
export const RESEARCH_EVIDENCE_CAPABILITY = 'research.evidence.v1';

export const RESEARCH_CALLERS = ['agent', 'workflow', 'member'] as const;
export type ResearchCaller = (typeof RESEARCH_CALLERS)[number];

export const RESEARCH_FRESHNESS = ['day', 'week', 'month', 'year'] as const;
export type ResearchFreshness = (typeof RESEARCH_FRESHNESS)[number];

export interface ResearchResult {
	readonly url: string;
	readonly title: string;
	readonly snippet: string;
	readonly publishedAt?: string;
	readonly source: string;
	/** The evidence row this kept result became. */
	readonly evidenceId?: string;
}

export interface ResearchSearchInput {
	readonly tenantId: string;
	readonly query: string;
	readonly limit?: number;
	readonly freshness?: ResearchFreshness;
	/** A host name the results are narrowed to, subdomains included. */
	readonly site?: string;
	readonly caller: ResearchCaller;
	/** The run of an agent or a workflow, or the account of a member. */
	readonly callerRef?: string;
	readonly signal?: AbortSignal;
}

export interface ResearchSearch {
	search(input: ResearchSearchInput): Promise<{
		readonly results: readonly ResearchResult[];
		readonly adapter: string;
	}>;
}

export interface ResearchFetchInput {
	readonly tenantId: string;
	readonly url: string;
	readonly caller: ResearchCaller;
	readonly callerRef?: string;
	readonly signal?: AbortSignal;
}

export interface ResearchFetchResult {
	readonly evidenceId: string;
	readonly title: string;
	readonly text: string;
	readonly truncated: boolean;
	readonly contentSha256: string;
	readonly retrievedAt: number;
}

export interface ResearchFetch {
	fetch(input: ResearchFetchInput): Promise<ResearchFetchResult>;
}

export interface EvidenceEntry {
	readonly id: string;
	readonly url: string;
	readonly title: string;
	readonly excerpt: string;
	readonly contentSha256: string;
	readonly retrievedAt: number;
	readonly runId: string | null;
	readonly documentId: string | null;
}

export interface ResearchEvidence {
	/**
	 * Links evidence of the workspace to a record of the owner module. Every id
	 * is checked before anything is written, and a repeat link is a no-op.
	 */
	attach(
		tenantId: string,
		ownerModule: string,
		recordRef: string,
		evidenceIds: readonly string[],
	): Promise<void>;
	/** The evidence attached to one record, newest first, at most 200 entries. */
	list(
		tenantId: string,
		ownerModule: string,
		recordRef: string,
	): Promise<EvidenceEntry[]>;
	get(tenantId: string, id: string): Promise<EvidenceEntry | null>;
}
