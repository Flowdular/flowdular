import { randomBytes } from 'node:crypto';
import {
	decodeCursor,
	defineEndpoint,
	encodeCursor,
	HttpProblem,
	jsonResponse,
	pageResponse,
	problemResponse,
	readJsonObject,
	readPageQuery,
	requiredString,
} from '@flowdular/server';
import { STORAGE_CONTENT_TYPES } from '@flowdular/storage';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@flowdular/module-auth/server';
import { DOCUMENTS_PERMISSIONS } from '../acl/permissions.ts';
import {
	DOCUMENT_LIMITS,
	DOCUMENT_SCANS,
	type DocumentScan,
} from '../domain/types.ts';
import type { DocumentsRuntime } from '../server/runtime.ts';
import {
	documentAttachment,
	DocumentsServiceError,
} from '../services/documents-service.ts';

/**
 * The upload carries the file as the whole body, so everything about it travels
 * in headers: `content-type` is the declared type the storage port verifies
 * against the bytes, and these three name the record it belongs to.
 */
export const UPLOAD_HEADERS = {
	filename: 'x-document-filename',
	ownerModule: 'x-document-owner-module',
	recordRef: 'x-document-record-ref',
	description: 'x-document-description',
} as const;

/* A header travels as ASCII, so anything else is percent encoded. A plain value
   decodes to itself; a malformed escape is a rejection rather than a guess. */
const HEADER_RAW_LIMIT = 4_096;

/** The default page of the documents screen, and the ceiling it may ask for. */
const LIST_PAGE_LIMIT = 50;

function failure(error: unknown): Response {
	if (error instanceof DocumentsServiceError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The documents operation failed.');
}

function invalid(message: string): HttpProblem {
	return new HttpProblem('INVALID_INPUT', message, 400);
}

function headerValue(
	request: Request,
	name: string,
	max: number,
): string | null {
	const raw = request.headers.get(name);
	if (raw === null || raw.trim() === '') return null;
	if (raw.length > HEADER_RAW_LIMIT) throw invalid(`${name} is too long.`);
	/* Only a client that percent-encodes reaches this module with a name the
	   whole way intact: a byte above 0x7F in a header value is read as Latin-1
	   by one hop and as UTF-8 by the next, so the value that arrives is not the
	   value that was sent. It is refused rather than stored mangled. */
	for (let index = 0; index < raw.length; index += 1) {
		if (raw.charCodeAt(index) > 0x7f) {
			throw invalid(`${name} must be percent-encoded ASCII.`);
		}
	}
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		throw invalid(`${name} is not percent-encoded text.`);
	}
	const normalized = decoded.trim();
	if (normalized.length === 0) return null;
	if (normalized.length > max) throw invalid(`${name} is too long.`);
	return normalized;
}

function requiredHeader(request: Request, name: string, max: number): string {
	const value = headerValue(request, name, max);
	if (value === null) throw invalid(`${name} is required.`);
	return value;
}

/* The declared length refuses an oversized or over-quota body before it is
   read; the port and the quota check measure what actually arrived. */
function declaredBytes(request: Request): number | undefined {
	const raw = request.headers.get('content-length');
	if (raw === null || raw.trim() === '') return undefined;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) {
		throw invalid('content-length must be a byte count.');
	}
	return value;
}

function queryValue(
	request: Request,
	key: string,
	max: number,
): string | undefined {
	const raw = new URL(request.url).searchParams.get(key);
	if (raw === null || raw === '') return undefined;
	if (raw.length > max) throw invalid(`${key} is too long.`);
	return raw;
}

function queryScan(request: Request): DocumentScan | undefined {
	const raw = queryValue(request, 'scan', 32);
	if (raw === undefined) return undefined;
	if (!(DOCUMENT_SCANS as readonly string[]).includes(raw)) {
		throw invalid(`scan must be one of: ${DOCUMENT_SCANS.join(', ')}.`);
	}
	return raw as DocumentScan;
}

export interface DocumentsRoutesOptions {
	/**
	 * The platform object ceiling, so the uploader can refuse a file before it
	 * sends it. The storage port stays the authority; this is what the screen is
	 * told about it.
	 */
	readonly maxObjectBytes: number;
}

export function createDocumentsRoutes(
	auth: AuthRuntime,
	runtime: DocumentsRuntime,
	options: DocumentsRoutesOptions,
) {
	/* Module-owned and never stored: a cursor names a position in one
	   workspace's own list, so a restart invalidating one costs a client the
	   first page. */
	const cursorSecret = randomBytes(32);
	const upload = defineEndpoint({
		id: 'documents.files.upload',
		path: '/api/documents/upload',
		methods: ['POST'],
		access: { kind: 'permission', permission: DOCUMENTS_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const request = octane.request;
				const contentType = request.headers.get('content-type');
				if (!contentType) {
					throw new HttpProblem(
						'CONTENT_TYPE_REQUIRED',
						'The declared content type is required.',
						415,
					);
				}
				const body = request.body;
				if (!body) throw invalid('The request body is required.');
				const principal = principalFromContext(octane)!;
				const service = await runtime.service();
				const record = await service.upload(
					principal.tenantId,
					principal.accountId,
					{
						ownerModule: requiredHeader(
							request,
							UPLOAD_HEADERS.ownerModule,
							DOCUMENT_LIMITS.ownerModule,
						),
						recordRef: requiredHeader(
							request,
							UPLOAD_HEADERS.recordRef,
							DOCUMENT_LIMITS.recordRef,
						),
						filename: requiredHeader(
							request,
							UPLOAD_HEADERS.filename,
							DOCUMENT_LIMITS.filename,
						),
						description: headerValue(
							request,
							UPLOAD_HEADERS.description,
							DOCUMENT_LIMITS.description,
						),
						contentType,
						declaredBytes: declaredBytes(request),
						body,
					},
				);
				return jsonResponse({ document: documentAttachment(record) }, 201);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const list = defineEndpoint({
		id: 'documents.files.list',
		path: '/api/documents',
		methods: ['GET'],
		access: { kind: 'permission', permission: DOCUMENTS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const service = await runtime.service();
				const page = readPageQuery(new URL(octane.request.url), {
					maxLimit: DOCUMENT_LIMITS.page,
					defaultLimit: LIST_PAGE_LIMIT,
				});
				const cursor = page.cursor
					? decodeCursor(page.cursor, cursorSecret)
					: null;
				const records = await service.list(
					principalFromContext(octane)!.tenantId,
					{
						ownerModule: queryValue(
							octane.request,
							'ownerModule',
							DOCUMENT_LIMITS.ownerModule,
						),
						recordRef: queryValue(
							octane.request,
							'recordRef',
							DOCUMENT_LIMITS.recordRef,
						),
						scan: queryScan(octane.request),
						/* The screen's search box. It narrows the query, so a term and
						   a cursor answer one result set rather than a page the screen
						   would have to search again. */
						search: queryValue(octane.request, 'q', DOCUMENT_LIMITS.search),
					},
					{
						limit: page.limit,
						after:
							cursor === null
								? null
								: {
										createdAt: Number(cursor.createdAt),
										id: String(cursor.id),
									},
					},
				);
				const last = records.at(-1);
				return pageResponse({
					items: records.map(documentAttachment),
					limit: page.limit,
					/* A full page may still be the last one; the client stops when the
					   cursor stops, which costs one empty page at most. */
					nextCursor:
						last && records.length === page.limit
							? encodeCursor(
									{ createdAt: last.createdAt, id: last.id },
									cursorSecret,
								)
							: null,
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* What the uploader has to know before it sends a byte. The port applies
	   both rules itself; a screen that knows them refuses a file the reader
	   picked instead of spending the upload to find out. */
	const limits = defineEndpoint({
		id: 'documents.files.limits',
		path: '/api/documents/limits',
		methods: ['GET'],
		access: { kind: 'permission', permission: DOCUMENTS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async () =>
			jsonResponse({
				maxObjectBytes: options.maxObjectBytes,
				contentTypes: STORAGE_CONTENT_TYPES,
			}),
	});

	const readUrl = defineEndpoint({
		id: 'documents.files.read-url',
		path: '/api/documents/read-url',
		methods: ['POST'],
		access: { kind: 'permission', permission: DOCUMENTS_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const service = await runtime.service();
				return jsonResponse(
					await service.readUrl(
						principalFromContext(octane)!.tenantId,
						requiredString(value, 'id', { max: DOCUMENT_LIMITS.id }),
					),
				);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const remove = defineEndpoint({
		id: 'documents.files.delete',
		path: '/api/documents/delete',
		methods: ['POST'],
		access: { kind: 'permission', permission: DOCUMENTS_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const service = await runtime.service();
				const record = await service.remove(
					principalFromContext(octane)!.tenantId,
					requiredString(value, 'id', { max: DOCUMENT_LIMITS.id }),
				);
				return jsonResponse({ document: documentAttachment(record) });
			} catch (error) {
				return failure(error);
			}
		},
	});

	return [
		upload.serverRoute,
		list.serverRoute,
		limits.serverRoute,
		readUrl.serverRoute,
		remove.serverRoute,
	] as const;
}

export const endpoints = [
	'documents.files.upload',
	'documents.files.list',
	'documents.files.limits',
	'documents.files.read-url',
	'documents.files.delete',
] as const;
