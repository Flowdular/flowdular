import type { DocumentFilters, DocumentsFile } from '../domain/types.ts';

/** The row order an export walks: creation time, then id to break a tie. */
export interface DocumentPageCursor {
	readonly createdAt: number;
	readonly id: string;
}

/**
 * The async, database-agnostic port. Every read is bounded by a limit the
 * caller states, and every method carries the tenant id the transaction binds.
 */
export interface DocumentsRepository {
	/**
	 * Newest first: what the workspace still holds, plus its infected refusals.
	 * `after` is the keyset of the last row the caller saw, so a screen pages
	 * without an offset over rows another upload can move.
	 */
	list(
		tenantId: string,
		filters: DocumentFilters,
		limit: number,
		after?: DocumentPageCursor | null,
	): Promise<readonly DocumentsFile[]>;
	/**
	 * Every row of one workspace, oldest first, paged by the keyset of the last
	 * row a caller saw. Unlike `list` it hides nothing: an export of what the
	 * workspace holds includes the deleted rows that are its trail.
	 */
	listForExport(
		tenantId: string,
		after: DocumentPageCursor | null,
		limit: number,
	): Promise<readonly DocumentsFile[]>;
	find(tenantId: string, id: string): Promise<DocumentsFile | null>;
	/** The same row, reached only through the reference its owner module knows. */
	findAttached(
		tenantId: string,
		ownerModule: string,
		recordRef: string,
		id: string,
	): Promise<DocumentsFile | null>;
	create(record: DocumentsFile): Promise<DocumentsFile>;
	/** The updated row, or null when it was already deleted or never existed. */
	markDeleted(tenantId: string, id: string): Promise<DocumentsFile | null>;
	/** Bytes the workspace still stores; the quota is measured against it. */
	storedBytes(tenantId: string): Promise<number>;
}
