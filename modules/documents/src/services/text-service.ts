import { createHash } from 'node:crypto';
import type { StoragePort } from '@flowdular/storage';
import {
	DOCUMENT_TEXT_LIMITS,
	DOCUMENT_TEXT_PAGE_BREAK,
	type DocumentText,
	type DocumentTextBytesInput,
	type DocumentTextExtraction,
	type DocumentTextOptions,
	type DocumentTextPageRange,
} from '../domain/text.ts';
import { DOCUMENT_LIMITS, type DocumentsFile } from '../domain/types.ts';
import {
	bounded,
	DocumentsServiceError,
	DOCUMENTS_STORAGE_MODULE,
} from './documents-service.ts';
import type {
	ClaimedDocumentText,
	DocumentsRepository,
	DocumentTextRecord,
	SettledDocumentText,
} from './repository.ts';
import {
	isImageType,
	ocrPages,
	readDocumentText,
	type DocumentTextLimits,
	type ReadOutcome,
} from './text/extract.ts';
import { DocumentOcrFailed, type DocumentOcr } from './text/ocr.ts';
import { joinPages } from './text/pages.ts';

/** Claims a pending row may take before it settles as failed. */
export const DOCUMENT_TEXT_MAX_ATTEMPTS = 3;

export interface DocumentTextServiceOptions {
	readonly repository: DocumentsRepository;
	readonly storage: StoragePort;
	readonly ocr: DocumentOcr | null;
	/** Asks the text runner for a pass that sees a row enqueued now. */
	readonly wake: () => void;
	readonly now?: (() => number) | undefined;
	/** Test seam: narrower bounds than a deployment runs. */
	readonly limits?: Partial<DocumentTextLimits> | undefined;
}

/** A read answer plus whether a retry through OCR could change it. */
export interface DocumentTextAnswer extends DocumentText {
	readonly ocrAvailable: boolean;
}

function invalid(message: string): DocumentsServiceError {
	return new DocumentsServiceError('INVALID_INPUT', message);
}

export function documentTextRange(
	value: unknown,
): DocumentTextPageRange | undefined {
	if (value === undefined || value === null) return undefined;
	const range = value as { from?: unknown; to?: unknown };
	if (
		typeof value !== 'object' ||
		!Number.isSafeInteger(range.from) ||
		!Number.isSafeInteger(range.to) ||
		(range.from as number) < 1 ||
		(range.to as number) < (range.from as number)
	) {
		throw invalid('pages must name whole pages from 1, from not past to.');
	}
	return { from: range.from as number, to: range.to as number };
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/* The storage port names its digest `sha256:<hex>`; the row keeps the hex. */
function checksumHex(record: DocumentsFile): string | null {
	const match = /^sha256:([0-9a-f]{64})$/.exec(record.checksum ?? '');
	return match?.[1] ?? null;
}

async function bytesOf(body: ReadableStream<Uint8Array>): Promise<Buffer> {
	const chunks: Uint8Array[] = [];
	const reader = body.getReader();
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) chunks.push(value);
	}
	return Buffer.concat(chunks);
}

function storedPages(
	text: string,
	pages: number,
	limit: number,
): readonly string[] {
	if (text !== '') return text.split(DOCUMENT_TEXT_PAGE_BREAK);
	return Array.from({ length: Math.min(pages, limit) }, () => '');
}

/**
 * The answer for a range over the pages kept, which are never more than the
 * page bound. A text cut when it was read stays cut for any range that reaches
 * the end of what was kept.
 */
function answer(
	settled: {
		readonly status: DocumentText['status'];
		readonly reason: DocumentText['reason'];
		readonly text: string;
		readonly pages: number;
		readonly truncated: boolean;
		readonly contentSha256: string;
	},
	range: DocumentTextPageRange | undefined,
	limit: number,
): DocumentText {
	const from = range?.from ?? 1;
	if (settled.status !== 'ok') {
		return {
			status: settled.status,
			reason: settled.reason,
			text: '',
			pages: settled.pages,
			from,
			to: from - 1,
			truncated: false,
			contentSha256: settled.contentSha256,
		};
	}
	const kept = storedPages(settled.text, settled.pages, limit);
	const requestedTo = range?.to ?? Math.max(kept.length, from - 1);
	const to = Math.max(from - 1, Math.min(requestedTo, kept.length));
	return {
		status: 'ok',
		reason: null,
		text:
			to >= from ? kept.slice(from - 1, to).join(DOCUMENT_TEXT_PAGE_BREAK) : '',
		pages: settled.pages,
		from,
		to,
		truncated: settled.truncated && requestedTo >= kept.length,
		contentSha256: settled.contentSha256,
	};
}

function settledFrom(outcome: ReadOutcome): SettledDocumentText {
	if (outcome.kind === 'refused') {
		return {
			status: outcome.status,
			reason: outcome.reason,
			text: '',
			pages: 0,
			truncated: false,
		};
	}
	if (outcome.kind === 'scan') {
		return {
			status: 'unscanned',
			reason: 'DOCUMENT_OCR_UNCONFIGURED',
			text: '',
			pages: outcome.pageCount,
			truncated: false,
		};
	}
	return {
		status: 'ok',
		reason: null,
		text: joinPages(outcome.pages),
		pages: outcome.pageCount,
		truncated: outcome.truncated,
	};
}

/**
 * Reads, keeps and answers the text of documents. A stored document is read
 * once and kept by its row; one too large to read within a request, or one
 * that needs OCR while OCR is configured, is left pending for the text runner.
 */
export class DocumentTextService {
	readonly #repository: DocumentsRepository;
	readonly #storage: StoragePort;
	readonly #ocr: DocumentOcr | null;
	readonly #wake: () => void;
	readonly #now: () => number;
	readonly #limits: DocumentTextLimits;

	constructor(options: DocumentTextServiceOptions) {
		this.#repository = options.repository;
		this.#storage = options.storage;
		this.#ocr = options.ocr;
		this.#wake = options.wake;
		this.#now = options.now ?? Date.now;
		this.#limits = { ...DOCUMENT_TEXT_LIMITS, ...options.limits };
	}

	ocrAvailable(): boolean {
		return this.#ocr?.available() ?? false;
	}

	async extract(
		tenantId: string,
		ownerModule: string,
		recordRef: string,
		id: string,
		options: DocumentTextOptions = {},
	): Promise<DocumentText | null> {
		const range = documentTextRange(options.pages);
		const record = await this.#repository.findAttached(
			this.#tenant(tenantId),
			bounded(ownerModule, 'ownerModule', 1, DOCUMENT_LIMITS.ownerModule),
			bounded(recordRef, 'recordRef', 1, DOCUMENT_LIMITS.recordRef),
			bounded(id, 'id', 1, DOCUMENT_LIMITS.id),
		);
		if (!record || record.status === 'deleted' || record.scan === 'infected') {
			return null;
		}
		return this.#answerFor(record, range);
	}

	/** The workspace screen's read: any document of the workspace by id. */
	async read(
		tenantId: string,
		id: string,
		pages?: DocumentTextPageRange,
	): Promise<DocumentTextAnswer> {
		const range = documentTextRange(pages);
		const record = await this.#readable(tenantId, id);
		const text = await this.#answerFor(record, range);
		if (!text) throw notFound();
		return { ...text, ocrAvailable: this.ocrAvailable() };
	}

	async retry(tenantId: string, id: string): Promise<DocumentTextAnswer> {
		const record = await this.#readable(tenantId, id);
		const row = this.ocrAvailable()
			? await this.#repository.retryText(
					record.tenantId,
					record.id,
					this.#now(),
				)
			: null;
		if (!row) {
			throw new DocumentsServiceError(
				'DOCUMENT_TEXT_NOT_RETRYABLE',
				'Only unscanned text is sent to OCR again, and only while OCR is available.',
				409,
			);
		}
		this.#wake();
		return {
			...answer(row, undefined, this.#limits.pages),
			ocrAvailable: true,
		};
	}

	async extractBytes(input: DocumentTextBytesInput): Promise<DocumentText> {
		const range = documentTextRange(input.pages);
		if (!(input.bytes instanceof Uint8Array)) {
			throw invalid('bytes must be a Uint8Array.');
		}
		const contentType = bounded(
			String(input.contentType ?? ''),
			'contentType',
			1,
			DOCUMENT_LIMITS.contentType,
		);
		const settled = await this.#settle(contentType, input.bytes, input.signal);
		return answer(
			{ ...settled, contentSha256: sha256Hex(input.bytes) },
			range,
			this.#limits.pages,
		);
	}

	/** One claimed row of the text runner. Settles nothing once the claim is lost. */
	async perform(job: ClaimedDocumentText, signal: AbortSignal): Promise<void> {
		const record = await this.#repository.find(job.tenantId, job.documentId);
		if (!record || record.status === 'deleted' || record.scan === 'infected') {
			await this.#repository.removeClaimedText(
				job.tenantId,
				job.documentId,
				job.claimedBy,
			);
			return;
		}
		if (job.attempts > DOCUMENT_TEXT_MAX_ATTEMPTS) {
			await this.#repository.settleText(
				job.tenantId,
				job.documentId,
				job.claimedBy,
				{
					status: 'unsupported',
					reason: 'DOCUMENT_TEXT_FAILED',
					text: '',
					pages: 0,
					truncated: false,
				},
				this.#now(),
			);
			return;
		}
		try {
			let settled: SettledDocumentText;
			if (record.bytes > this.#limits.inputBytes) {
				settled = settledFrom({
					kind: 'refused',
					status: 'too-large',
					reason: 'DOCUMENT_TEXT_TOO_LARGE',
				});
			} else {
				const bytes = await this.#bytes(record);
				if (!bytes) {
					await this.#repository.removeClaimedText(
						job.tenantId,
						job.documentId,
						job.claimedBy,
					);
					return;
				}
				settled = await this.#settle(record.contentType, bytes, signal);
			}
			signal.throwIfAborted();
			await this.#repository.settleText(
				job.tenantId,
				job.documentId,
				job.claimedBy,
				settled,
				this.#now(),
			);
		} catch (error) {
			if (signal.aborted) throw error;
			/* A failure that is not the document's own (the store or the database
			   refusing) hands the row back, so the next pass tries again within the
			   attempts rather than after the stale window. */
			await this.#repository
				.releaseText(job.tenantId, job.documentId, job.claimedBy)
				.catch(() => false);
			throw error;
		}
	}

	async #answerFor(
		record: DocumentsFile,
		range: DocumentTextPageRange | undefined,
	): Promise<DocumentText | null> {
		const tenant = record.tenantId;
		const pages = this.#limits.pages;
		const kept =
			(await this.#repository.findText(tenant, record.id)) ??
			(await this.#copy(record));
		if (kept) return answer(kept, range, pages);
		const checksum = checksumHex(record);
		if (checksum === null) return null;
		const now = this.#now();
		const save = async (settled: SettledDocumentText) =>
			answer(
				await this.#repository.saveText(
					tenant,
					record.id,
					checksum,
					settled,
					now,
				),
				range,
				pages,
			);
		const enqueue = async () => {
			const row = await this.#repository.enqueueText(
				tenant,
				record.id,
				checksum,
				now,
			);
			this.#wake();
			return answer(row, range, pages);
		};
		if (record.bytes > this.#limits.inputBytes) {
			return save(
				settledFrom({
					kind: 'refused',
					status: 'too-large',
					reason: 'DOCUMENT_TEXT_TOO_LARGE',
				}),
			);
		}
		if (
			record.bytes > this.#limits.inlineBytes ||
			(isImageType(record.contentType) && this.ocrAvailable())
		) {
			return enqueue();
		}
		const bytes = await this.#bytes(record);
		if (!bytes) return null;
		const outcome = await readDocumentText({
			contentType: record.contentType,
			bytes,
			limits: this.#limits,
		});
		if (outcome.kind === 'scan' && this.ocrAvailable()) return enqueue();
		return save(settledFrom(outcome));
	}

	async #copy(record: DocumentsFile): Promise<DocumentTextRecord | null> {
		const checksum = checksumHex(record);
		if (checksum === null) return null;
		return this.#repository.copyTextByChecksum(
			record.tenantId,
			record.id,
			checksum,
			this.#now(),
		);
	}

	/* A text layer first; OCR only for what has none, and only when available. */
	async #settle(
		contentType: string,
		bytes: Uint8Array,
		signal: AbortSignal | undefined,
	): Promise<SettledDocumentText> {
		const outcome = await readDocumentText({
			contentType,
			bytes,
			signal,
			limits: this.#limits,
		});
		if (outcome.kind !== 'scan' || !this.#ocr?.available()) {
			return settledFrom(outcome);
		}
		try {
			const pages = await this.#ocr.read({ contentType, bytes, signal });
			return settledFrom(ocrPages(pages, outcome.pageCount, this.#limits));
		} catch (error) {
			signal?.throwIfAborted();
			if (!(error instanceof DocumentOcrFailed)) throw error;
			return {
				status: 'unscanned',
				reason: 'DOCUMENT_OCR_FAILED',
				text: '',
				pages: outcome.pageCount,
				truncated: false,
			};
		}
	}

	async #bytes(record: DocumentsFile): Promise<Buffer | null> {
		const read = await this.#storage.get({
			tenantId: record.tenantId,
			moduleId: DOCUMENTS_STORAGE_MODULE,
			objectId: record.id,
		});
		return read ? bytesOf(read.body) : null;
	}

	async #readable(tenantId: string, id: string): Promise<DocumentsFile> {
		const record = await this.#repository.find(
			this.#tenant(tenantId),
			bounded(id, 'id', 1, DOCUMENT_LIMITS.id),
		);
		if (!record) throw notFound();
		if (record.scan === 'infected') {
			throw new DocumentsServiceError(
				'DOCUMENT_INFECTED',
				'An infected document has no text to read.',
				409,
			);
		}
		if (record.status === 'deleted') {
			throw new DocumentsServiceError(
				'DOCUMENT_DELETED',
				'The document was deleted.',
				409,
			);
		}
		return record;
	}

	#tenant(tenantId: string): string {
		return bounded(tenantId, 'tenantId', 1, DOCUMENT_LIMITS.accountId);
	}
}

function notFound(): DocumentsServiceError {
	return new DocumentsServiceError(
		'DOCUMENT_NOT_FOUND',
		'The document does not exist in this workspace.',
		404,
	);
}

/**
 * The implementation behind `documents.text.v1`. It resolves the service per
 * call, so the capability is registered while the platform composes.
 */
export function createDocumentTextExtraction(
	service: () => Promise<DocumentTextService>,
): DocumentTextExtraction {
	return {
		async extract(tenantId, ownerModule, recordRef, id, options) {
			return (await service()).extract(
				tenantId,
				ownerModule,
				recordRef,
				id,
				options,
			);
		},
		async extractBytes(input) {
			return (await service()).extractBytes(input);
		},
	};
}
