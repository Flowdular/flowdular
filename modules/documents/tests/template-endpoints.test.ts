import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	createAuthenticationMiddleware,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { DOCUMENTS_PERMISSIONS } from '../src/acl/permissions.ts';
import { createDocumentsRoutes } from '../src/api/endpoints.ts';
import { createDocumentsRuntime } from '../src/server/runtime.ts';
import { readDocumentText } from '../src/services/text/extract.ts';
import { DOCUMENT_TEXT_LIMITS } from '../src/domain/text.ts';
import {
	openDocumentsTestContext,
	type DocumentsTestContext,
} from './support/database.ts';
import {
	OFFER_BODY,
	OFFER_KEY,
	offerDefinition,
	offerInput,
} from './support/templates.ts';

const ORIGIN = 'https://erp.example';
const SESSION_TOKEN = 'session-token-templates';
const CSRF_TOKEN = 'csrf-token-templates';
const TENANT = 'tenant-template-http';
const READER = [DOCUMENTS_PERMISSIONS.templatesRead];
const MANAGER = [
	DOCUMENTS_PERMISSIONS.templatesRead,
	DOCUMENTS_PERMISSIONS.templatesManage,
];

let context: DocumentsTestContext;

beforeAll(async () => {
	context = await openDocumentsTestContext({ maxObjectBytes: 4 * 1024 * 1024 });
});

afterAll(async () => {
	await context?.dispose();
});

afterEach(async () => {
	await context.reset();
});

function principal(
	scopes: readonly string[],
	tenantId = TENANT,
): AuthPrincipal {
	return {
		accountId: 'account-ada',
		tenantId,
		email: 'ada@example.com',
		displayName: 'Ada',
		role: 'owner',
		scopes,
		tenants: [],
	};
}

function authRuntime(session: AuthPrincipal | null): AuthRuntime {
	const cookie = {
		name: 'coreloom_session_dev',
		secure: false,
		maxAgeSeconds: 3_600,
	};
	const service = {
		resolveSession: async (token: string | null) =>
			session && token === SESSION_TOKEN
				? { principal: session, csrfToken: CSRF_TOKEN, expiresAt: 0 }
				: null,
		resolveApiToken: async () => null,
		listTenantMembers: async () => [],
	} as unknown as Awaited<ReturnType<AuthRuntime['service']>>;
	return {
		cookie,
		settings: {
			allowSignUp: false,
			emailConfirmation: false,
			signInProviders: [],
		},
		authorizeAgentToolAccess: () => [],
		middleware: createAuthenticationMiddleware(async () => service, cookie),
		service: async () => service,
	} as unknown as AuthRuntime;
}

function fixture(session: AuthPrincipal | null) {
	const runtime = createDocumentsRuntime({
		databases: context.databases,
		purpose: 'test',
		repository: context.repository,
		templatesRepository: context.templates,
		storage: context.storage.port,
		quotaBytes: () => 10 * 1024 * 1024,
		readUrlSeconds: () => 300,
		timeZone: () => 'Europe/Warsaw',
	});
	runtime.templates.register('orders.core', [offerDefinition()]);
	const auth = authRuntime(session);
	const routes = createDocumentsRoutes(auth, runtime, {
		maxObjectBytes: context.storage.maxObjectBytes,
	});
	const invoke = async (
		path: string,
		init: RequestInit & { readonly csrf?: string | null | undefined } = {},
	) => {
		const { csrf, ...requestInit } = init;
		const headers = new Headers(requestInit.headers);
		if (session) headers.set('cookie', `coreloom_session_dev=${SESSION_TOKEN}`);
		if (requestInit.method === 'POST') {
			headers.set('content-type', 'application/json');
			headers.set('origin', ORIGIN);
			if (csrf !== null) headers.set('x-csrf-token', csrf ?? CSRF_TOKEN);
		}
		const request = new Request(ORIGIN + path, { ...requestInit, headers });
		const octane = {
			request,
			params: {},
			url: new URL(request.url),
			state: new Map<string, unknown>(),
		};
		await auth.middleware(octane as never, async () => new Response(null));
		const route = routes.find(
			(candidate) =>
				candidate.path === path.split('?')[0] &&
				candidate.methods.includes(requestInit.method ?? 'GET'),
		);
		if (!route) throw new Error(`No route ${path}.`);
		return route.handler(octane as never);
	};
	return {
		get: (path: string) => invoke(path),
		post: (path: string, body: unknown, csrf?: string | null) =>
			invoke(path, { method: 'POST', body: JSON.stringify(body), csrf }),
		runtime,
	};
}

async function json<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

const GETS = [
	'/api/documents/templates',
	`/api/documents/templates/detail?key=${OFFER_KEY}`,
	`/api/documents/templates/versions?key=${OFFER_KEY}`,
	`/api/documents/templates/version?key=${OFFER_KEY}&version=1`,
];

describe('template endpoints', () => {
	it('DOCUMENTS-TEMPLATE-ENDPOINTS answers 401 without an identity and 403 without the permission', async () => {
		const anonymous = fixture(null);
		const stranger = fixture(principal(['documents.files.read']));
		for (const path of GETS) {
			expect([path, (await anonymous.get(path)).status]).toEqual([path, 401]);
			expect([path, (await stranger.get(path)).status]).toEqual([path, 403]);
		}
		for (const path of [
			'/api/documents/templates/preview',
			'/api/documents/templates/save',
			'/api/documents/templates/revert',
		]) {
			expect([path, (await anonymous.post(path, {})).status]).toEqual([
				path,
				401,
			]);
			expect([path, (await stranger.post(path, {})).status]).toEqual([
				path,
				403,
			]);
		}
		const reader = fixture(principal(READER));
		expect(
			(
				await reader.post('/api/documents/templates/save', {
					key: OFFER_KEY,
					body: 'x',
					expectedVersion: 0,
				})
			).status,
		).toBe(403);
		expect(
			(
				await reader.post('/api/documents/templates/revert', {
					key: OFFER_KEY,
					expectedVersion: 0,
				})
			).status,
		).toBe(403);
	});

	it('DOCUMENTS-TEMPLATE-ENDPOINTS refuses a mutation without the CSRF proof first', async () => {
		const manager = fixture(principal(MANAGER));
		for (const path of [
			'/api/documents/templates/preview',
			'/api/documents/templates/save',
			'/api/documents/templates/revert',
		]) {
			const response = await manager.post(
				path,
				{ key: OFFER_KEY },
				'wrong-token',
			);
			expect([
				path,
				response.status,
				(await json<{ error: { code: string } }>(response)).error.code,
			]).toEqual([path, 403, 'CSRF_REJECTED']);
		}
		expect(await context.templates.listTemplates(TENANT, 10)).toEqual([]);
	});

	it('DOCUMENTS-TEMPLATE-ENDPOINTS lets a reader list, read and preview, and a manager save and revert', async () => {
		const reader = fixture(principal(READER));
		const listed = await json<{
			items: { key: string; version: number | null }[];
		}>(await reader.get('/api/documents/templates'));
		expect(listed.items).toEqual([
			expect.objectContaining({
				key: OFFER_KEY,
				version: null,
				ownerModule: 'orders.core',
			}),
		]);
		const detail = await json<{
			template: { current: { body: string; version: number | null } };
		}>(await reader.get(`/api/documents/templates/detail?key=${OFFER_KEY}`));
		expect(detail.template.current).toMatchObject({
			body: OFFER_BODY,
			version: null,
		});

		const pdf = await reader.post('/api/documents/templates/preview', {
			key: OFFER_KEY,
			body: '# Podgląd {{ customer }}',
			layout: { footer: 'Strona {{ page }} z {{ pages }}' },
			input: offerInput(2),
		});
		expect([pdf.status, pdf.headers.get('content-type')]).toEqual([
			200,
			'application/pdf',
		]);
		const read = await readDocumentText({
			contentType: 'application/pdf',
			bytes: new Uint8Array(await pdf.arrayBuffer()),
			limits: DOCUMENT_TEXT_LIMITS,
		});
		expect(read.kind === 'text' && read.pages[0]).toContain(
			'Podgląd Spółka Żółw',
		);
		const docx = await reader.post('/api/documents/templates/preview', {
			key: OFFER_KEY,
			body: OFFER_BODY,
			input: offerInput(2),
			format: 'docx',
		});
		expect([docx.status, docx.headers.get('content-type')]).toEqual([
			200,
			'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		]);
		expect(await context.storage.keys()).toEqual([]);
		expect(await context.templates.listTemplates(TENANT, 10)).toEqual([]);

		const manager = fixture(principal(MANAGER));
		const saved = await manager.post('/api/documents/templates/save', {
			key: OFFER_KEY,
			body: OFFER_BODY + '\n\nDziękujemy.',
			layout: { pageSize: 'Letter' },
			expectedVersion: 0,
		});
		expect(saved.status).toBe(201);
		expect(
			(
				await json<{
					version: { version: number; layout: { pageSize: string } };
				}>(saved)
			).version,
		).toMatchObject({
			version: 2,
			layout: { pageSize: 'Letter' },
		});
		const history = await json<{
			items: { version: number; origin: string }[];
			page: { nextCursor: string | null };
		}>(
			await reader.get(
				`/api/documents/templates/versions?key=${OFFER_KEY}&limit=1`,
			),
		);
		expect(history.items.map((entry) => [entry.version, entry.origin])).toEqual(
			[[2, 'edit']],
		);
		const older = await json<{
			items: { version: number }[];
			page: { nextCursor: string | null };
		}>(
			await reader.get(
				`/api/documents/templates/versions?key=${OFFER_KEY}&limit=1&cursor=${encodeURIComponent(history.page.nextCursor!)}`,
			),
		);
		expect([
			older.items.map((entry) => entry.version),
			older.page.nextCursor,
		]).toEqual([[1], null]);
		const reverted = await manager.post('/api/documents/templates/revert', {
			key: OFFER_KEY,
			expectedVersion: 2,
		});
		expect([
			reverted.status,
			(await json<{ version: { version: number; origin: string } }>(reverted))
				.version,
		]).toEqual([
			201,
			expect.objectContaining({ version: 3, origin: 'revert' }),
		]);
	});

	it('DOCUMENTS-TEMPLATE-ENDPOINTS answers the stable refusals', async () => {
		const manager = fixture(principal(MANAGER));
		const unknown = await manager.get(
			'/api/documents/templates/detail?key=orders.core.nothing',
		);
		expect([
			unknown.status,
			(await json<{ error: { code: string } }>(unknown)).error.code,
		]).toEqual([404, 'TEMPLATE_NOT_FOUND']);
		const invalid = await manager.post('/api/documents/templates/save', {
			key: OFFER_KEY,
			body: '# Title\n\n<b>bold</b>\n\n{{ missing }}',
			expectedVersion: 0,
		});
		const refused = await json<{
			error: { code: string; issues: { code: string; line: number }[] };
		}>(invalid);
		expect([invalid.status, refused.error.code]).toEqual([
			422,
			'TEMPLATE_INVALID',
		]);
		expect(
			refused.error.issues.map((issue) => [issue.code, issue.line]),
		).toEqual([['TEMPLATE_HTML', 3]]);
		const input = await manager.post('/api/documents/templates/preview', {
			key: OFFER_KEY,
			body: OFFER_BODY,
			input: { customer: 1 },
		});
		const inputRefusal = await json<{
			error: { code: string; issues: { path: string }[] };
		}>(input);
		expect([
			input.status,
			inputRefusal.error.code,
			inputRefusal.error.issues.map((issue) => issue.path),
		]).toEqual([422, 'TEMPLATE_INPUT_INVALID', ['items', 'customer']]);
		const conflict = await manager.post('/api/documents/templates/save', {
			key: OFFER_KEY,
			body: 'x',
			expectedVersion: 4,
		});
		expect([
			conflict.status,
			(await json<{ error: { code: string } }>(conflict)).error.code,
		]).toEqual([409, 'TEMPLATE_VERSION_CONFLICT']);
		const foreign = fixture(principal(MANAGER, 'tenant-elsewhere'));
		await manager.post('/api/documents/templates/save', {
			key: OFFER_KEY,
			body: OFFER_BODY + '\n\nx',
			expectedVersion: 0,
		});
		const elsewhere = await json<{ items: { version: number | null }[] }>(
			await foreign.get('/api/documents/templates'),
		);
		expect(elsewhere.items.map((item) => item.version)).toEqual([null]);
		const missingVersion = await foreign.get(
			`/api/documents/templates/version?key=${OFFER_KEY}&version=2`,
		);
		expect([
			missingVersion.status,
			(await json<{ error: { code: string } }>(missingVersion)).error.code,
		]).toEqual([404, 'TEMPLATE_VERSION_NOT_FOUND']);
	});
});
