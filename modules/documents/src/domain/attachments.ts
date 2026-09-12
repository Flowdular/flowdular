import type { DocumentScan, DocumentStatus } from './types.ts';

/**
 * The public cross-module surface. A module that owns a record resolves it with
 * `context.capabilities.get<DocumentAttachments>(DOCUMENTS_ATTACHMENTS_CAPABILITY)`
 * and reaches its own attachments by reference: its module id plus the record
 * reference it chose. There is no attach call, because bytes only ever enter
 * through `POST /api/documents/upload`, where the session, the CSRF proof, the
 * workspace quota and the storage port's limits are applied; a capability that
 * took bytes would be a second upload path with none of them.
 */
export const DOCUMENTS_ATTACHMENTS_CAPABILITY = 'documents.attachments.v1';

/**
 * One document as another module sees it. The storage key is documents.core's
 * own bookkeeping and stays out: bytes are reached through `open` or a read
 * URL, never by addressing the object store.
 */
export interface DocumentAttachment {
	readonly id: string;
	readonly ownerModule: string;
	readonly recordRef: string;
	readonly filename: string;
	readonly contentType: string;
	readonly bytes: number;
	readonly checksum: string | null;
	readonly scan: DocumentScan;
	readonly status: DocumentStatus;
	readonly uploaderAccountId: string;
	readonly description: string | null;
	readonly createdAt: number;
}

/**
 * The bytes of one document as another module reads them. The storage key is
 * absent here too: documents.core opens the object and hands over the stream,
 * so a caller never addresses the store.
 */
export interface DocumentAttachmentBody {
	readonly contentType: string;
	readonly bytes: number;
	readonly filename: string;
	readonly body: ReadableStream<Uint8Array>;
}

export interface DocumentAttachments {
	/**
	 * Documents of one record, newest first. The tenant id comes from the
	 * caller's principal; a caller naming another module's id sees that module's
	 * attachments, so the reference pair is a scope, not an authorization.
	 */
	list(
		tenantId: string,
		ownerModule: string,
		recordRef: string,
	): Promise<readonly DocumentAttachment[]>;
	/**
	 * The decrypted body of one document of that reference, streamed from the
	 * same storage access the read URL route serves. Null is every reference
	 * that has no readable object: an unknown id, another module's or another
	 * record's pair, another workspace's document, a deleted row, an infected
	 * one, or a row whose object is gone. A caller that has to tell those apart
	 * reads `list`, which carries the scan verdict and the status of each row.
	 *
	 * The stream is the caller's: nothing else reads it, cancels it or closes
	 * it, and the whole object is held in memory while it is open.
	 */
	open(
		tenantId: string,
		ownerModule: string,
		recordRef: string,
		id: string,
	): Promise<DocumentAttachmentBody | null>;
	/**
	 * Deletes the object, then marks the row deleted. Idempotent: false means the
	 * reference matched no stored document, including a second delete of one.
	 */
	delete(
		tenantId: string,
		ownerModule: string,
		recordRef: string,
		id: string,
	): Promise<boolean>;
}
