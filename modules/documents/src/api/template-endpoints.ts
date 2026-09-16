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
	requiredInteger,
	requiredString,
} from '@flowdular/server';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@flowdular/module-auth/server';
import { DOCUMENTS_PERMISSIONS } from '../acl/permissions.ts';
import {
	DOCUMENT_TEMPLATE_FORMATS,
	DOCUMENT_TEMPLATE_LIMITS,
	type DocumentTemplateFormat,
} from '../domain/templates.ts';
import type { DocumentsRuntime } from '../server/runtime.ts';
import { DocumentsServiceError } from '../services/documents-service.ts';
import { TemplatesServiceError } from '../services/templates-service.ts';

/* A draft body, its layout and a sample input travel together. */
const PREVIEW_BODY_BYTES =
	DOCUMENT_TEMPLATE_LIMITS.bodyCharacters * 4 +
	DOCUMENT_TEMPLATE_LIMITS.inputBytes +
	16 * 1024;
const SAVE_BODY_BYTES = DOCUMENT_TEMPLATE_LIMITS.bodyCharacters * 4 + 16 * 1024;
const VERSION_PAGE = 50;

function failure(error: unknown): Response {
	if (error instanceof DocumentsServiceError) {
		return jsonResponse(
			{
				error: {
					code: error.code,
					message: error.message,
					...(error instanceof TemplatesServiceError && error.issues
						? { issues: error.issues }
						: {}),
				},
			},
			error.status,
		);
	}
	return problemResponse(error, 'The template operation failed.');
}

function invalid(message: string): HttpProblem {
	return new HttpProblem('INVALID_INPUT', message, 400);
}

function templateKey(value: string | null): string {
	if (
		value === null ||
		value.length < 1 ||
		value.length > DOCUMENT_TEMPLATE_LIMITS.key
	) {
		throw invalid(`key is 1 to ${DOCUMENT_TEMPLATE_LIMITS.key} characters.`);
	}
	return value;
}

function bodyText(value: Record<string, unknown>): string {
	if (typeof value.body !== 'string') throw invalid('body must be a string.');
	if (value.body.length > DOCUMENT_TEMPLATE_LIMITS.bodyCharacters) {
		throw new TemplatesServiceError(
			'TEMPLATE_INVALID',
			`A template body holds at most ${DOCUMENT_TEMPLATE_LIMITS.bodyCharacters} characters.`,
			422,
			[
				{
					code: 'TEMPLATE_TOO_LARGE',
					message: `A template body holds at most ${DOCUMENT_TEMPLATE_LIMITS.bodyCharacters} characters.`,
					line: null,
					field: 'body',
				},
			],
		);
	}
	return value.body;
}

function formatOf(value: unknown): DocumentTemplateFormat | undefined {
	if (value === undefined || value === null) return undefined;
	if (!(DOCUMENT_TEMPLATE_FORMATS as readonly unknown[]).includes(value)) {
		throw invalid('format is pdf or docx.');
	}
	return value as DocumentTemplateFormat;
}

function contentDisposition(filename: string): string {
	const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
	return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function createTemplateRoutes(
	auth: AuthRuntime,
	runtime: DocumentsRuntime,
) {
	const cursorSecret = randomBytes(32);
	const read = {
		kind: 'permission',
		permission: DOCUMENTS_PERMISSIONS.templatesRead,
	} as const;
	const manage = {
		kind: 'permission',
		permission: DOCUMENTS_PERMISSIONS.templatesManage,
	} as const;

	const list = defineEndpoint({
		id: 'documents.templates.list',
		path: '/api/documents/templates',
		methods: ['GET'],
		access: read,
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const service = await runtime.templatesService();
				return jsonResponse({
					items: await service.list(principalFromContext(octane)!.tenantId),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const detail = defineEndpoint({
		id: 'documents.templates.detail',
		path: '/api/documents/templates/detail',
		methods: ['GET'],
		access: read,
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const url = new URL(octane.request.url);
				const service = await runtime.templatesService();
				return jsonResponse({
					template: await service.detail(
						principalFromContext(octane)!.tenantId,
						templateKey(url.searchParams.get('key')),
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const versions = defineEndpoint({
		id: 'documents.templates.versions',
		path: '/api/documents/templates/versions',
		methods: ['GET'],
		access: read,
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const url = new URL(octane.request.url);
				const key = templateKey(url.searchParams.get('key'));
				const page = readPageQuery(url, {
					maxLimit: VERSION_PAGE,
					defaultLimit: VERSION_PAGE,
				});
				const before = page.cursor
					? Number(decodeCursor(page.cursor, cursorSecret).before)
					: null;
				const service = await runtime.templatesService();
				const items = await service.versions(
					principalFromContext(octane)!.tenantId,
					key,
					before,
					page.limit,
				);
				const last = items.at(-1);
				return pageResponse({
					items,
					limit: page.limit,
					nextCursor:
						last && items.length === page.limit && last.version > 1
							? encodeCursor({ before: last.version }, cursorSecret)
							: null,
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const version = defineEndpoint({
		id: 'documents.templates.version',
		path: '/api/documents/templates/version',
		methods: ['GET'],
		access: read,
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const url = new URL(octane.request.url);
				const number = Number(url.searchParams.get('version'));
				if (!Number.isSafeInteger(number) || number < 1)
					throw invalid('version is a whole number from 1.');
				const service = await runtime.templatesService();
				return jsonResponse({
					version: await service.version(
						principalFromContext(octane)!.tenantId,
						templateKey(url.searchParams.get('key')),
						number,
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* A preview renders and answers the bytes; nothing is stored, so the reader
	   permission is enough, and the CSRF proof still comes first because the
	   request carries a body the server spends work on. */
	const preview = defineEndpoint({
		id: 'documents.templates.preview',
		path: '/api/documents/templates/preview',
		methods: ['POST'],
		access: read,
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, PREVIEW_BODY_BYTES);
				const service = await runtime.templatesService();
				const rendered = await service.preview(
					principalFromContext(octane)!.tenantId,
					{
						key: templateKey(
							requiredString(value, 'key', {
								max: DOCUMENT_TEMPLATE_LIMITS.key,
							}),
						),
						body: bodyText(value),
						layout: value.layout,
						input: value.input,
						format: formatOf(value.format),
					},
					octane.request.signal,
				);
				return new Response(Buffer.from(rendered.bytes), {
					status: 200,
					headers: {
						'content-type': rendered.contentType,
						'content-disposition': contentDisposition(rendered.filename),
						'cache-control': 'no-store',
						'x-content-type-options': 'nosniff',
					},
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const save = defineEndpoint({
		id: 'documents.templates.save',
		path: '/api/documents/templates/save',
		methods: ['POST'],
		access: manage,
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request, SAVE_BODY_BYTES);
				const principal = principalFromContext(octane)!;
				const service = await runtime.templatesService();
				return jsonResponse(
					{
						version: await service.save(
							principal.tenantId,
							principal.accountId,
							{
								key: templateKey(
									requiredString(value, 'key', {
										max: DOCUMENT_TEMPLATE_LIMITS.key,
									}),
								),
								body: bodyText(value),
								layout: value.layout,
								expectedVersion: requiredInteger(value, 'expectedVersion', {
									min: 0,
								}),
							},
						),
					},
					201,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const revert = defineEndpoint({
		id: 'documents.templates.revert',
		path: '/api/documents/templates/revert',
		methods: ['POST'],
		access: manage,
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const value = await readJsonObject(octane.request);
				const principal = principalFromContext(octane)!;
				const service = await runtime.templatesService();
				return jsonResponse(
					{
						version: await service.revert(
							principal.tenantId,
							principal.accountId,
							{
								key: templateKey(
									requiredString(value, 'key', {
										max: DOCUMENT_TEMPLATE_LIMITS.key,
									}),
								),
								expectedVersion: requiredInteger(value, 'expectedVersion', {
									min: 0,
								}),
								toVersion:
									value.toVersion === undefined || value.toVersion === null
										? null
										: requiredInteger(value, 'toVersion', { min: 1 }),
							},
						),
					},
					201,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});

	return [
		list.serverRoute,
		detail.serverRoute,
		versions.serverRoute,
		version.serverRoute,
		preview.serverRoute,
		save.serverRoute,
		revert.serverRoute,
	] as const;
}

export const templateEndpoints = [
	'documents.templates.list',
	'documents.templates.detail',
	'documents.templates.versions',
	'documents.templates.version',
	'documents.templates.preview',
	'documents.templates.save',
	'documents.templates.revert',
] as const;
