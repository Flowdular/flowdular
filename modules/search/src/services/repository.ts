import type { RecentQuery } from '../domain/types.ts';

export interface RecordQueryInput {
	readonly id: string;
	readonly tenantId: string;
	readonly accountId: string;
	readonly query: string;
	readonly ranAt: number;
	/** Newest rows a member keeps; older ones go in the same transaction. */
	readonly keep: number;
}

export interface ExportedRecentQuery extends RecentQuery {
	readonly accountId: string;
}

/**
 * The module's own rows. Provider tables belong to the modules that own them
 * and are never reachable from here.
 */
export interface SearchRepository {
	/** Moves an existing row to the top instead of adding a duplicate. */
	recordQuery(input: RecordQueryInput): Promise<void>;
	listRecent(
		tenantId: string,
		accountId: string,
		limit: number,
	): Promise<readonly RecentQuery[]>;
	/** Answers how many of the member's own rows were removed. */
	clearRecent(tenantId: string, accountId: string): Promise<number>;
	/** Removes at most `limit` rows of the workspace older than `cutoff`. */
	sweepRecent(tenantId: string, cutoff: number, limit: number): Promise<number>;
	/**
	 * One page of the workspace's rows, walked by id. Re-running a query
	 * rewrites its `ran_at`, so only the immutable key makes the walk stable:
	 * a keyset on the timestamp would return a rewritten row a second time.
	 */
	exportRecent(
		tenantId: string,
		afterId: string,
		limit: number,
	): Promise<readonly (ExportedRecentQuery & { readonly id: string })[]>;
}
