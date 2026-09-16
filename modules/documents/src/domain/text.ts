/**
 * The public text surface. A module that owns a record resolves it with
 * `context.capabilities.get<DocumentTextExtraction>(DOCUMENTS_TEXT_CAPABILITY)`
 * and reads the text of its own attachments by reference, or hands over bytes
 * it holds without storing them.
 */
export const DOCUMENTS_TEXT_CAPABILITY = 'documents.text.v1';

/**
 * `pending` is answered only by `extract`: the stored document is extracted on
 * the job runner and a later read answers the settled status.
 */
export const DOCUMENT_TEXT_STATUSES = [
	'ok',
	'unscanned',
	'unsupported',
	'too-large',
	'pending',
] as const;
export type DocumentTextStatus = (typeof DOCUMENT_TEXT_STATUSES)[number];

export const DOCUMENT_TEXT_REASONS = [
	'DOCUMENT_TEXT_FORMAT',
	'DOCUMENT_TEXT_UNREADABLE',
	'DOCUMENT_TEXT_ENCRYPTED',
	'DOCUMENT_TEXT_TOO_LARGE',
	'DOCUMENT_TEXT_FAILED',
	'DOCUMENT_OCR_UNCONFIGURED',
	'DOCUMENT_OCR_FAILED',
] as const;
export type DocumentTextReason = (typeof DOCUMENT_TEXT_REASONS)[number];

/** The separator between two pages of an answered text. */
export const DOCUMENT_TEXT_PAGE_BREAK = '\f';

export const DOCUMENT_TEXT_LIMITS = {
	/** Pages read and kept, and the widest range one answer covers. */
	pages: 200,
	/** Input a parser is handed at most: the default storage object ceiling. */
	inputBytes: 25 * 1024 * 1024,
	/** UTF-8 bytes of text read and kept. */
	textBytes: 2 * 1024 * 1024,
	/** Characters of one page of a format without pages of its own. */
	flowPageCharacters: 10_000,
	/** A stored document larger than this is extracted on the job runner. */
	inlineBytes: 2 * 1024 * 1024,
	/** Bytes one package may inflate across every part it reads. */
	inflatedBytes: 32 * 1024 * 1024,
	/** Entries a package's central directory may list. */
	zipEntries: 4_096,
	/** UTF-8 bytes of text the agent tool answers in one call. */
	toolTextBytes: 20_000,
} as const;

/** Whole pages from 1, `from` not past `to`. */
export interface DocumentTextPageRange {
	readonly from: number;
	readonly to: number;
}

export interface DocumentText {
	readonly status: DocumentTextStatus;
	/** Null for `ok` and `pending`. */
	readonly reason: DocumentTextReason | null;
	/** The answered pages, separated by `DOCUMENT_TEXT_PAGE_BREAK`. */
	readonly text: string;
	/** Pages the document holds as its format counts them; 0 when not known. */
	readonly pages: number;
	/** The first page asked for. */
	readonly from: number;
	/** The last page the text covers; `from - 1` when it covers none. */
	readonly to: number;
	readonly truncated: boolean;
	/** Hex sha256 of the bytes the text was read from. */
	readonly contentSha256: string;
}

export interface DocumentTextOptions {
	readonly pages?: DocumentTextPageRange | undefined;
}

export interface DocumentTextBytesInput extends DocumentTextOptions {
	readonly contentType: string;
	readonly bytes: Uint8Array;
	/** Stops a parse or an OCR call the caller no longer waits for. */
	readonly signal?: AbortSignal | undefined;
}

export interface DocumentTextExtraction {
	/**
	 * The text of one document of the caller's reference pair. Null for every
	 * reference `documents.attachments.v1` `open` answers null for.
	 */
	extract(
		tenantId: string,
		ownerModule: string,
		recordRef: string,
		id: string,
		options?: DocumentTextOptions,
	): Promise<DocumentText | null>;
	/** The text of bytes that are not stored, always read within the call. */
	extractBytes(input: DocumentTextBytesInput): Promise<DocumentText>;
}
