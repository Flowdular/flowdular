import { t } from '@flowdular/client/i18n';
import type { DocumentAttachment } from '../domain/attachments.ts';
import type { DocumentReadUrl, DocumentScan } from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: {
		readonly code?: string;
		readonly message?: string;
	};
}

/** A failed request with the server's stable code, so a screen can translate it. */
export class DocumentsApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'DocumentsApiError';
		this.status = status;
		this.code = code;
	}
}

/**
 * The server message is English and written for an operator. A code this module
 * knows becomes translated copy; anything else keeps the server's own sentence
 * rather than hiding what went wrong behind a generic line.
 */
export function documentsErrorMessage(
	error: unknown,
	fallbackKey: string,
): string {
	if (error instanceof DocumentsApiError) {
		const key = 'documents.error.code.' + error.code;
		const translated = t(key);
		if (translated !== key) return translated;
		return error.message;
	}
	if (error instanceof Error && error.message !== '') return error.message;
	return t(fallbackKey);
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new DocumentsApiError(
			response.status,
			value.error?.code ?? 'REQUEST_FAILED',
			value.error?.message ?? t('documents.error.request'),
		);
	}
	return value;
}

async function post<T>(
	path: string,
	body: unknown,
	csrfToken: string,
): Promise<T> {
	return payload<T>(
		await fetch(path, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-csrf-token': csrfToken,
			},
			credentials: 'same-origin',
			body: JSON.stringify(body),
		}),
	);
}

export interface DocumentFilter {
	readonly ownerModule?: string;
	readonly recordRef?: string;
	readonly scan?: DocumentScan | '';
	/** Substring of the filename or the description; the server matches it. */
	readonly search?: string;
	/** The page to continue; null or absent asks for the first one. */
	readonly cursor?: string | null;
}

function query(entries: Readonly<Record<string, string>>): string {
	const parameters = new URLSearchParams();
	for (const [key, value] of Object.entries(entries)) {
		if (value !== '') parameters.set(key, value);
	}
	const text = parameters.toString();
	return text === '' ? '' : '?' + text;
}

export interface DocumentPage {
	readonly items: readonly DocumentAttachment[];
	readonly page: { readonly nextCursor: string | null };
}

/** One server-filtered, server-paged listing; the screen narrows nothing. */
export async function loadDocuments(
	filter: DocumentFilter = {},
): Promise<DocumentPage> {
	const response = await fetch(
		'/api/documents' +
			query({
				ownerModule: filter.ownerModule ?? '',
				recordRef: filter.recordRef ?? '',
				scan: filter.scan ?? '',
				q: filter.search ?? '',
				cursor: filter.cursor ?? '',
			}),
		{
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
		},
	);
	return payload<DocumentPage>(response);
}

export interface DocumentLimits {
	readonly maxObjectBytes: number;
	readonly contentTypes: readonly string[];
}

export async function loadDocumentLimits(): Promise<DocumentLimits> {
	return payload<DocumentLimits>(
		await fetch('/api/documents/limits', {
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
		}),
	);
}

export interface UploadDocumentRequest {
	readonly file: File;
	readonly ownerModule: string;
	readonly recordRef: string;
	readonly description: string;
}

/* A header is ASCII on the wire and a document name is not, so every text
   header is percent encoded and the server decodes it once. */
function encodedHeaders(
	input: UploadDocumentRequest,
	csrfToken: string,
): Record<string, string> {
	return {
		'content-type': input.file.type,
		'x-csrf-token': csrfToken,
		'x-document-filename': encodeURIComponent(input.file.name),
		'x-document-owner-module': encodeURIComponent(input.ownerModule),
		'x-document-record-ref': encodeURIComponent(input.recordRef),
		...(input.description === ''
			? {}
			: { 'x-document-description': encodeURIComponent(input.description) }),
	};
}

/** The file is the whole body: there is no multipart parser on the server. */
export async function uploadDocument(
	input: UploadDocumentRequest,
	csrfToken: string,
): Promise<DocumentAttachment> {
	const response = await fetch('/api/documents/upload', {
		method: 'POST',
		headers: encodedHeaders(input, csrfToken),
		credentials: 'same-origin',
		body: input.file,
	});
	return (await payload<{ readonly document: DocumentAttachment }>(response))
		.document;
}

export async function documentReadUrl(
	id: string,
	csrfToken: string,
): Promise<DocumentReadUrl> {
	return post<DocumentReadUrl>('/api/documents/read-url', { id }, csrfToken);
}

export async function deleteDocument(
	id: string,
	csrfToken: string,
): Promise<DocumentAttachment> {
	return (
		await post<{ readonly document: DocumentAttachment }>(
			'/api/documents/delete',
			{ id },
			csrfToken,
		)
	).document;
}
