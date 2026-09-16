import type { DocumentTextReason, DocumentTextStatus } from '../domain/text.ts';
import type { DocumentFilters, DocumentsFile } from '../domain/types.ts';

/** The row order an export walks: creation time, then id to break a tie. */
export interface DocumentPageCursor {
	readonly createdAt: number;
	readonly id: string;
}

/** One row of documents_text. */
export interface DocumentTextRecord {
	readonly tenantId: string;
	readonly documentId: string;
	readonly contentSha256: string;
	readonly status: DocumentTextStatus;
	readonly reason: DocumentTextReason | null;
	/** The pages kept, separated by a form feed. */
	readonly text: string;
	readonly pages: number;
	readonly truncated: boolean;
	readonly attempts: number;
	readonly requestedAt: number;
	readonly extractedAt: number | null;
}

/** A settled extraction, as the row keeps it. */
export interface SettledDocumentText {
	readonly status: Exclude<DocumentTextStatus, 'pending'>;
	readonly reason: DocumentTextReason | null;
	readonly text: string;
	readonly pages: number;
	readonly truncated: boolean;
}

/** What the runner's cross-tenant routing read may see of a pending row. */
export interface DocumentTextRouting {
	readonly tenantId: string;
	readonly documentId: string;
	readonly requestedAt: number;
}

export interface ClaimedDocumentText {
	readonly tenantId: string;
	readonly documentId: string;
	readonly contentSha256: string;
	/** Claims taken of this row so far, this one included. */
	readonly attempts: number;
	/** The token of this claim, which every renewal and settle is fenced on. */
	readonly claimedBy: string;
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
	/**
	 * Locks the stored row, runs `discard` while it is held, then marks the row
	 * deleted. Null when it was already deleted or never existed, in which case
	 * `discard` does not run. The lock orders the delete against a pass that
	 * rewrites the object under the same lock, so neither can leave an object
	 * the other does not see. The document's text row goes in the same
	 * transaction.
	 */
	markDeleted(
		tenantId: string,
		id: string,
		discard: () => Promise<void>,
	): Promise<DocumentsFile | null>;
	/** Bytes the workspace still stores; the quota is measured against it. */
	storedBytes(tenantId: string): Promise<number>;
	findText(
		tenantId: string,
		documentId: string,
	): Promise<DocumentTextRecord | null>;
	/**
	 * Gives a document without a row a copy of a settled row of the same bytes.
	 * Null when no such row exists or the document already has one.
	 */
	copyTextByChecksum(
		tenantId: string,
		documentId: string,
		contentSha256: string,
		at: number,
	): Promise<DocumentTextRecord | null>;
	/** Writes a settled row unless one exists, and answers the row kept. */
	saveText(
		tenantId: string,
		documentId: string,
		contentSha256: string,
		settled: SettledDocumentText,
		at: number,
	): Promise<DocumentTextRecord>;
	/** Writes a pending row unless one exists, and answers the row kept. */
	enqueueText(
		tenantId: string,
		documentId: string,
		contentSha256: string,
		at: number,
	): Promise<DocumentTextRecord>;
	/** Puts an unscanned row back to pending; null for any other row. */
	retryText(
		tenantId: string,
		documentId: string,
		at: number,
	): Promise<DocumentTextRecord | null>;
	/** Pending rows of every workspace, oldest request first, on the background role. */
	listPendingText(limit: number): Promise<readonly DocumentTextRouting[]>;
	claimText(input: {
		readonly tenantId: string;
		readonly documentId: string;
		readonly claimedBy: string;
		readonly claimedAt: number;
		readonly staleBefore: number;
	}): Promise<ClaimedDocumentText | null>;
	heartbeatText(
		tenantId: string,
		documentId: string,
		claimedBy: string,
		at: number,
	): Promise<boolean>;
	/** Settles a pending row only while the claim named still holds it. */
	settleText(
		tenantId: string,
		documentId: string,
		claimedBy: string,
		settled: SettledDocumentText,
		at: number,
	): Promise<boolean>;
	releaseText(
		tenantId: string,
		documentId: string,
		claimedBy: string,
	): Promise<boolean>;
	removeClaimedText(
		tenantId: string,
		documentId: string,
		claimedBy: string,
	): Promise<boolean>;
}
