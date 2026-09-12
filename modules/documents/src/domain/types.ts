/** The storage port's verdict, carried on the row it produced. */
export const DOCUMENT_SCANS = ['unscanned', 'clean', 'infected'] as const;
export type DocumentScan = (typeof DOCUMENT_SCANS)[number];

/** Whether the object behind the row is still in the store. */
export const DOCUMENT_STATUSES = ['stored', 'deleted'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Longest values the module accepts; over any of them is a rejection. */
export const DOCUMENT_LIMITS = {
	id: 64,
	ownerModule: 64,
	recordRef: 200,
	filename: 255,
	contentType: 128,
	storageKey: 512,
	accountId: 128,
	description: 1_000,
	/** Longest search term the list accepts; a longer one is refused. */
	search: 200,
	/** Rows one list answer may carry; the platform page ceiling. */
	page: 200,
} as const;

export interface DocumentsFile {
	readonly id: string;
	readonly tenantId: string;
	readonly ownerModule: string;
	readonly recordRef: string;
	readonly filename: string;
	readonly contentType: string;
	/** Plaintext bytes the object carried; zero when none was ever stored. */
	readonly bytes: number;
	/**
	 * The port's `sha256:<hex>` digest of the plaintext, so it is 71 characters
	 * rather than the 64 the specification names. Null on an infected row: the
	 * port refuses the object before it hashes it.
	 */
	readonly checksum: string | null;
	readonly storageKey: string;
	readonly uploaderAccountId: string;
	readonly scan: DocumentScan;
	readonly status: DocumentStatus;
	readonly description: string | null;
	readonly createdAt: number;
}

export interface UploadDocumentInput {
	readonly ownerModule: string;
	readonly recordRef: string;
	readonly filename: string;
	readonly contentType: string;
	readonly description?: string | null;
	/** `content-length`, so an oversized body is refused before it is read. */
	readonly declaredBytes?: number | undefined;
	readonly body: ReadableStream<Uint8Array> | Uint8Array;
}

export interface DocumentFilters {
	readonly ownerModule?: string | undefined;
	readonly recordRef?: string | undefined;
	readonly scan?: DocumentScan | undefined;
	/** The screen's `q`: a substring of the filename or the description. */
	readonly search?: string | undefined;
}

export interface DocumentReadUrl {
	readonly url: string;
	readonly expiresInSeconds: number;
}
