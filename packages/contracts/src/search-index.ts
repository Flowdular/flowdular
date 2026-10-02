/**
 * Optional candidate retrieval behind a module-owned search.providers.v1
 * provider. The index never authorizes a result or supplies response content.
 */
export interface SearchIndexOperationOptions {
	readonly signal?: AbortSignal;
}

/** Created by the host from the owning module and a trusted tenant context. */
export interface SearchIndexScope {
	readonly deploymentId: string;
	readonly moduleId: string;
	readonly tenantId: string;
	readonly projectionId: string;
	/** The schema version of the module-owned projection. */
	readonly projectionVersion: number;
	/** A rebuild uses a new generation, leaving earlier tasks in the old one. */
	readonly generation: string;
}

export interface SearchCandidateQuery extends SearchIndexOperationOptions {
	readonly query: string;
	readonly limit: number;
	readonly cursor?: string;
}

export interface SearchCandidatePage {
	/** Ranked, opaque owner record references. The owner rechecks each one. */
	readonly refs: readonly string[];
	readonly nextCursor: string | null;
}

export type SearchIndexChange =
	| {
			readonly kind: 'upsert';
			readonly ref: string;
			readonly text: string;
			/** Owner revision; replaying the same change must converge. */
			readonly revision: string;
	  }
	| {
			readonly kind: 'delete';
			readonly ref: string;
			readonly revision: string;
	  };

export interface SearchIndexWrite extends SearchIndexOperationOptions {
	readonly changes: readonly SearchIndexChange[];
	/** Stable across retries; reusing it with different changes must reject. */
	readonly idempotencyKey: string;
}

export interface SearchIndexReceipt {
	readonly id: string;
}

export type SearchIndexWriteStatus =
	| { readonly state: 'pending' }
	| { readonly state: 'applied' }
	| { readonly state: 'failed'; readonly reason: string }
	/** The engine cannot prove the receipt's outcome; rebuild or prove ordering. */
	| { readonly state: 'unknown' };

/** A handle already bound to one module-owned tenant projection. */
export interface SearchCandidateIndex {
	search(input: SearchCandidateQuery): Promise<SearchCandidatePage>;
	/** Submission is not an acknowledgement that the index applied the batch. */
	submit(input: SearchIndexWrite): Promise<SearchIndexReceipt>;
	status(
		receipt: SearchIndexReceipt,
		options?: SearchIndexOperationOptions,
	): Promise<SearchIndexWriteStatus>;
}

/** Host-only adapter seam. A future Meilisearch adapter implements this. */
export interface SearchIndexAdapter {
	readonly id: string;
	/** Confined to this scope; a destroyed scope must never reopen. */
	openScope(scope: SearchIndexScope): SearchCandidateIndex;
	/**
	 * Host-only cleanup. Fence new work, drain accepted writes, and remove all
	 * indexed data in this exact scope before resolving. The fence survives
	 * restarts; safe to repeat.
	 */
	destroyScope(scope: SearchIndexScope): Promise<void>;
	/** Drains in-flight work and closes connections; safe to call twice. */
	close(): Promise<void>;
}
