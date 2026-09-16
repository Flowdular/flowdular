import {
	contentMatchesType,
	contentTypeAllowed,
	normalizeContentType,
} from '@flowdular/storage';
import {
	DOCUMENT_TEXT_LIMITS,
	type DocumentTextReason,
} from '../../domain/text.ts';
import { readDocx, readPptx, readXlsx } from './ooxml.ts';
import { PageWriter, type PageBounds } from './pages.ts';
import { PdfEncrypted, PdfUnreadable, readPdf } from './pdf.ts';
import { XmlUnreadable } from './xml.ts';
import { ZipPackage, ZipUnreadable } from './zip.ts';

export type DocumentTextLimits = {
	readonly [Key in keyof typeof DOCUMENT_TEXT_LIMITS]: number;
};

export type ReadOutcome =
	| {
			readonly kind: 'text';
			readonly pages: readonly string[];
			readonly pageCount: number;
			readonly truncated: boolean;
	  }
	/** No text layer: the pages can only be read by OCR. */
	| { readonly kind: 'scan'; readonly pageCount: number }
	| {
			readonly kind: 'refused';
			readonly status: 'unsupported' | 'too-large';
			readonly reason: DocumentTextReason;
	  };

const DOCX =
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX =
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX =
	'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const IMAGES: ReadonlySet<string> = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
]);
const LEGACY: ReadonlySet<string> = new Set([
	'application/msword',
	'application/vnd.ms-excel',
]);
const TEXT_CHUNK = 64 * 1024;

function refused(
	status: 'unsupported' | 'too-large',
	reason: DocumentTextReason,
): ReadOutcome {
	return { kind: 'refused', status, reason };
}

function bounds(limits: DocumentTextLimits): PageBounds {
	return {
		pages: limits.pages,
		textBytes: limits.textBytes,
		flowPageCharacters: limits.flowPageCharacters,
	};
}

function written(writer: PageWriter, pageCount?: number): ReadOutcome {
	const result = writer.finish();
	return {
		kind: 'text',
		pages: result.pages,
		pageCount: Math.max(pageCount ?? 0, result.pages.length),
		truncated: result.truncated,
	};
}

/** Whether a stored document of this type can only be read through OCR. */
export function isImageType(contentType: string): boolean {
	return IMAGES.has(normalizeContentType(contentType) ?? '');
}

/**
 * Reads the text of one document's bytes under the limits. The declared type
 * decides the reader only once the bytes carry its structure, the same rule
 * the storage port applies to an upload.
 */
export async function readDocumentText(input: {
	readonly contentType: string;
	readonly bytes: Uint8Array;
	readonly signal?: AbortSignal | undefined;
	readonly limits: DocumentTextLimits;
}): Promise<ReadOutcome> {
	const { bytes, limits, signal } = input;
	if (bytes.byteLength > limits.inputBytes) {
		return refused('too-large', 'DOCUMENT_TEXT_TOO_LARGE');
	}
	const type = normalizeContentType(input.contentType);
	if (!type || !contentTypeAllowed(type) || LEGACY.has(type)) {
		return refused('unsupported', 'DOCUMENT_TEXT_FORMAT');
	}
	if (!contentMatchesType(type, bytes)) {
		return refused('unsupported', 'DOCUMENT_TEXT_UNREADABLE');
	}
	if (IMAGES.has(type)) return { kind: 'scan', pageCount: 1 };
	signal?.throwIfAborted();
	try {
		if (type === 'application/pdf') {
			const writer = new PageWriter(bounds(limits), false);
			const pageCount = await readPdf(bytes, writer, signal);
			if (!writer.hasText) return { kind: 'scan', pageCount };
			return written(writer, pageCount);
		}
		if (type === DOCX || type === XLSX || type === PPTX) {
			const writer = new PageWriter(bounds(limits), type !== PPTX);
			const zip = new ZipPackage(bytes, {
				entries: limits.zipEntries,
				inflatedBytes: limits.inflatedBytes,
			});
			const reader =
				type === DOCX ? readDocx : type === XLSX ? readXlsx : readPptx;
			await reader(zip, writer);
			return written(writer);
		}
		return readPlainText(bytes, limits);
	} catch (error) {
		signal?.throwIfAborted();
		if (error instanceof PdfEncrypted) {
			return refused('unsupported', 'DOCUMENT_TEXT_ENCRYPTED');
		}
		if (
			error instanceof PdfUnreadable ||
			error instanceof ZipUnreadable ||
			error instanceof XmlUnreadable
		) {
			return refused('unsupported', 'DOCUMENT_TEXT_UNREADABLE');
		}
		throw error;
	}
}

/* Normalizing line ends can only shorten the text, so twice the text bound of
   input bytes always holds as much as the bound keeps. */
function readPlainText(
	bytes: Uint8Array,
	limits: DocumentTextLimits,
): ReadOutcome {
	const writer = new PageWriter(bounds(limits), true);
	const window = Math.min(bytes.byteLength, limits.textBytes * 2);
	const text = new TextDecoder('utf-8')
		.decode(bytes.subarray(0, window), { stream: window < bytes.byteLength })
		.replace(/\r\n?/g, '\n');
	for (
		let start = 0;
		start < text.length && !writer.full;
		start += TEXT_CHUNK
	) {
		writer.write(text.slice(start, start + TEXT_CHUNK));
	}
	if (window < bytes.byteLength) writer.cut();
	return written(writer);
}

/** OCR page texts under the same bounds as a text layer. */
export function ocrPages(
	pages: readonly string[],
	pageCount: number,
	limits: DocumentTextLimits,
): ReadOutcome {
	const writer = new PageWriter(bounds(limits), false);
	for (const page of pages) {
		writer.startPage();
		writer.write(page);
		if (writer.full) break;
	}
	return written(writer, Math.max(pageCount, pages.length));
}
