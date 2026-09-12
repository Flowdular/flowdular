import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	createAuthenticationMiddleware,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { DOCUMENTS_PERMISSIONS } from '../src/acl/permissions.ts';
import { createDocumentsRoutes, UPLOAD_HEADERS } from '../src/api/endpoints.ts';
import { createDocumentsRuntime } from '../src/server/runtime.ts';
import {
	openDocumentsTestContext,
	type DocumentsTestContext,
} from './support/database.ts';
import { pdfBytes, pngBytes } from './support/files.ts';

const ORIGIN = 'https://erp.example';
const SESSION_TOKEN = 'session-token-0001';
const CSRF_TOKEN = 'csrf-token-0001';
const TENANT = 'tenant-http';
const ALL_SCOPES = Object.values(DOCUMENTS_PERMISSIONS);

let context: DocumentsTestContext;

beforeAll(async () => {
	context = await openDocumentsTestContext();
});

afterAll(async () => {
	await context?.dispose();
});

afterEach(async () => {
	await context.reset();
});

function principal(
	scopes: readonly string[],
	accountId = 'account-ada',
	tenantId = TENANT,
): AuthPrincipal {
	return {
		accountId,
		tenantId,
		email: `${accountId}@example.com`,
		displayName: 'Ada',
		role: 'owner',
		scopes,
		tenants: [],
	};
}

/* The real authentication middleware publishes the principal and the session
   the CSRF guard reads, so these routes are exercised through the same state
   the platform gives them rather than a hand-placed principal. */
function authRuntime(
	sessions: ReadonlyMap<string, AuthPrincipal>,
): AuthRuntime {
	const cookie = {
		name: 'coreloom_session_dev',
		secure: false,
		maxAgeSeconds: 3_600,
	};
	const service = {
		resolveSession: async (token: string | null) => {
			const found = token === null ? undefined : sessions.get(token);
			return found
				? { principal: found, csrfToken: CSRF_TOKEN, expiresAt: 0 }
				: null;
		},
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

function fixture(session: AuthPrincipal | null, quotaBytes = 10 * 1024 * 1024) {
	const runtime = createDocumentsRuntime({
		databases: context.databases,
		purpose: 'test',
		repository: context.repository,
		storage: context.storage.port,
		quotaBytes: () => quotaBytes,
		readUrlSeconds: () => 300,
	});
	const sessions = new Map<string, AuthPrincipal>();
	if (session) sessions.set(SESSION_TOKEN, session);
	const auth = authRuntime(sessions);
	const routes = createDocumentsRoutes(auth, runtime, {
		maxObjectBytes: context.storage.maxObjectBytes,
	});
	const route = (path: string, method: string) => {
		const found = routes.find(
			(candidate) =>
				candidate.path === path && candidate.methods.includes(method),
		);
		if (!found) throw new Error(`Route ${method} ${path} is missing.`);
		return found;
	};
	const invoke = async (
		path: string,
		requestPath: string,
		init: RequestInit & { readonly authenticated?: boolean } = {},
	) => {
		const { authenticated = true, ...requestInit } = init;
		const headers = new Headers(requestInit.headers);
		if (authenticated && session) {
			headers.set('cookie', `coreloom_session_dev=${SESSION_TOKEN}`);
		} else {
			headers.delete('cookie');
		}
		const request = new Request(ORIGIN + requestPath, {
			...requestInit,
			headers,
		});
		const octaneContext = {
			request,
			params: {},
			url: new URL(request.url),
			state: new Map<string, unknown>(),
		};
		await auth.middleware(
			octaneContext as never,
			async () => new Response(null),
		);
		return route(path, requestInit.method ?? 'GET').handler(
			octaneContext as never,
		);
	};
	const call = (path: string, init: Parameters<typeof invoke>[2] = {}) =>
		invoke(path.split('?')[0]!, path, init);
	const mutation = (
		path: string,
		body: unknown,
		init: Parameters<typeof invoke>[2] = {},
	) =>
		call(path, {
			...init,
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: ORIGIN,
				'x-csrf-token': CSRF_TOKEN,
				...(init.headers as Record<string, string> | undefined),
			},
			body: JSON.stringify(body),
		});
	const upload = (
		body: Uint8Array,
		headers: Record<string, string> = {},
		init: Parameters<typeof invoke>[2] = {},
	) =>
		call('/api/documents/upload', {
			...init,
			method: 'POST',
			headers: {
				'content-type': 'application/pdf',
				origin: ORIGIN,
				'x-csrf-token': CSRF_TOKEN,
				[UPLOAD_HEADERS.filename]: 'contract.pdf',
				[UPLOAD_HEADERS.ownerModule]: 'directory.core',
				[UPLOAD_HEADERS.recordRef]: 'party-4711',
				...headers,
				...(init.headers as Record<string, string> | undefined),
			},
			/* An exact-size copy: a Buffer view may sit in a shared pool, and its
			   own ArrayBuffer would carry the neighbours with it. */
			body: new Uint8Array(body).buffer,
		});
	return { call, mutation, upload, runtime };
}

const READ_PATHS = [['/api/documents', DOCUMENTS_PERMISSIONS.read]] as const;

const MUTATION_PATHS = [
	['/api/documents/read-url', DOCUMENTS_PERMISSIONS.read],
	['/api/documents/delete', DOCUMENTS_PERMISSIONS.manage],
] as const;

async function body<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

describe('documents HTTP boundary', () => {
	it('DOCUMENTS-DENY answers 401 on every route without an identity', async () => {
		const anonymous = fixture(null);
		for (const [path] of READ_PATHS) {
			expect([path, (await anonymous.call(path)).status]).toEqual([path, 401]);
		}
		for (const [path] of MUTATION_PATHS) {
			expect([
				path,
				(await anonymous.mutation(path, { id: 'x' })).status,
			]).toEqual([path, 401]);
		}
		expect((await anonymous.upload(pdfBytes())).status).toBe(401);
	});

	it('DOCUMENTS-DENY answers 403 without the permission the route declares', async () => {
		const wrong = fixture(principal(['system.settings.read']));
		for (const [path] of READ_PATHS) {
			expect([path, (await wrong.call(path)).status]).toEqual([path, 403]);
		}
		for (const [path] of MUTATION_PATHS) {
			expect([path, (await wrong.mutation(path, { id: 'x' })).status]).toEqual([
				path,
				403,
			]);
		}
		expect((await wrong.upload(pdfBytes())).status).toBe(403);
	});

	it('DOCUMENTS-DENY refuses an upload for a principal holding only the read permission', async () => {
		const reader = fixture(principal([DOCUMENTS_PERMISSIONS.read]));
		expect((await reader.upload(pdfBytes())).status).toBe(403);
		expect(
			(await reader.mutation('/api/documents/delete', { id: 'x' })).status,
		).toBe(403);
		expect((await reader.call('/api/documents')).status).toBe(200);
	});

	it('DOCUMENTS-DENY refuses a mutation without a CSRF proof before the body is read', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		for (const [path] of MUTATION_PATHS) {
			const response = await owner.mutation(
				path,
				{ id: 'x' },
				{ headers: { 'x-csrf-token': 'wrong-token' } },
			);
			expect([path, response.status]).toEqual([path, 403]);
			expect([
				path,
				(await body<{ error: { code: string } }>(response)).error.code,
			]).toEqual([path, 'CSRF_REJECTED']);
		}
		const upload = await owner.upload(
			pdfBytes(),
			{},
			{ headers: { 'x-csrf-token': 'wrong-token' } },
		);
		expect(upload.status).toBe(403);
		expect((await body<{ error: { code: string } }>(upload)).error.code).toBe(
			'CSRF_REJECTED',
		);
		/* The refusal has to come before anything is stored. */
		expect(await context.repository.storedBytes(TENANT)).toBe(0);
	});

	it('DOCUMENTS-UPLOAD stores a file sent as the raw request body and lists it', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		const created = await owner.upload(pdfBytes(), {
			[UPLOAD_HEADERS.description]: encodeURIComponent('Umowa ramowa'),
			[UPLOAD_HEADERS.filename]: encodeURIComponent('umowa-zaświadczenie.pdf'),
		});
		expect(created.status).toBe(201);
		const document = (
			await body<{
				document: {
					id: string;
					filename: string;
					description: string;
					bytes: number;
					scan: string;
				};
			}>(created)
		).document;
		expect({
			filename: document.filename,
			description: document.description,
			scan: document.scan,
		}).toEqual({
			filename: 'umowa-zaświadczenie.pdf',
			description: 'Umowa ramowa',
			scan: 'unscanned',
		});

		const listed = await owner.call(
			'/api/documents?ownerModule=directory.core',
		);
		expect(listed.status).toBe(200);
		expect(
			(await body<{ items: { id: string }[] }>(listed)).items.map(
				(entry) => entry.id,
			),
		).toEqual([document.id]);
		expect(
			(
				await body<{ items: unknown[] }>(
					await owner.call('/api/documents?ownerModule=users.core'),
				)
			).items,
		).toEqual([]);
	});

	it('DOCUMENTS-REFUSE answers a stable code for every upload the platform limits refuse', async () => {
		const owner = fixture(principal(ALL_SCOPES), 8);
		const overQuota = await owner.upload(pdfBytes());
		expect([
			overQuota.status,
			(await body<{ error: { code: string } }>(overQuota)).error.code,
		]).toEqual([413, 'QUOTA_EXCEEDED']);

		const roomy = fixture(principal(ALL_SCOPES));
		const mismatch = await roomy.upload(pngBytes());
		expect([
			mismatch.status,
			(await body<{ error: { code: string } }>(mismatch)).error.code,
		]).toEqual([400, 'CONTENT_MISMATCH']);

		const refusedType = await roomy.upload(pdfBytes(), {
			'content-type': 'application/x-msdownload',
		});
		expect([
			refusedType.status,
			(await body<{ error: { code: string } }>(refusedType)).error.code,
		]).toEqual([415, 'CONTENT_TYPE_REFUSED']);

		const missingHeader = await roomy.upload(pdfBytes(), {
			[UPLOAD_HEADERS.recordRef]: '',
		});
		expect([
			missingHeader.status,
			(await body<{ error: { code: string } }>(missingHeader)).error.code,
		]).toEqual([400, 'INVALID_INPUT']);
		expect(await context.repository.storedBytes(TENANT)).toBe(0);
	});

	it('DOCUMENTS-READ-URL and delete answer over HTTP and refuse an unknown id', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		const created = await owner.upload(pdfBytes());
		const { id } = (await body<{ document: { id: string } }>(created)).document;

		const read = await owner.mutation('/api/documents/read-url', { id });
		expect(read.status).toBe(200);
		const issued = await body<{ url: string; expiresInSeconds: number }>(read);
		expect(issued.expiresInSeconds).toBe(300);
		expect(issued.url.startsWith('/api/storage/objects/')).toBe(true);

		const missing = await owner.mutation('/api/documents/read-url', {
			id: 'not-a-document',
		});
		expect([
			missing.status,
			(await body<{ error: { code: string } }>(missing)).error.code,
		]).toEqual([404, 'DOCUMENT_NOT_FOUND']);

		const deleted = await owner.mutation('/api/documents/delete', { id });
		expect(deleted.status).toBe(200);
		expect(
			(await body<{ document: { status: string } }>(deleted)).document.status,
		).toBe('deleted');
		expect(
			(await body<{ items: unknown[] }>(await owner.call('/api/documents')))
				.items,
		).toEqual([]);
	});
});

describe('documents list paging', () => {
	async function upload(
		owner: ReturnType<typeof fixture>,
		filename: string,
		headers: Record<string, string> = {},
	): Promise<string> {
		const created = await owner.upload(pdfBytes(), {
			[UPLOAD_HEADERS.filename]: filename,
			...headers,
		});
		expect(created.status).toBe(201);
		return (await body<{ document: { id: string } }>(created)).document.id;
	}

	/* The page is the server's: a screen that paged the rows it happened to
	   hold would page whatever the first answer contained. */
	it('walks every row through the cursor it hands back', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		const stored: string[] = [];
		for (let index = 0; index < 5; index += 1) {
			stored.push(await upload(owner, `contract-${index}.pdf`));
		}

		const walked: string[] = [];
		const pageSizes: number[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < 6; page += 1) {
			const response = await owner.call(
				'/api/documents?limit=2' + (cursor ? '&cursor=' + cursor : ''),
			);
			expect(response.status).toBe(200);
			const answered = await body<{
				items: { id: string }[];
				page: { nextCursor: string | null };
			}>(response);
			walked.push(...answered.items.map((entry) => entry.id));
			pageSizes.push(answered.items.length);
			cursor = answered.page.nextCursor;
			if (cursor === null) break;
		}

		expect(cursor).toBeNull();
		/* The limit is the server's: five rows cannot arrive in one answer. */
		expect(Math.max(...pageSizes)).toBe(2);
		expect(pageSizes.length).toBeGreaterThan(2);
		expect(new Set(walked).size).toBe(stored.length);
		expect([...walked].sort()).toEqual([...stored].sort());
	});

	it('refuses a cursor this server did not sign and a limit past the ceiling', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		const forged = await owner.call('/api/documents?cursor=c1.abc.def');
		expect([
			forged.status,
			(await body<{ error: { code: string } }>(forged)).error.code,
		]).toEqual([400, 'CURSOR_INVALID']);
		expect((await owner.call('/api/documents?limit=500')).status).toBe(400);
	});

	/* The owner module and the scan state narrow the query, not the page: a
	   filter applied to one page hides rows the next one would have held. */
	it('applies the owner module filter to the page the server builds', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		const mine = await upload(owner, 'mine.pdf');
		await upload(owner, 'theirs.pdf', {
			[UPLOAD_HEADERS.ownerModule]: 'users.core',
		});

		const filtered = await owner.call(
			'/api/documents?ownerModule=directory.core&limit=1',
		);

		const answered = await body<{
			items: { id: string }[];
			page: { nextCursor: string | null };
		}>(filtered);
		expect(answered.items.map((entry) => entry.id)).toEqual([mine]);
		/* A full page may still be the last one, so the cursor is followed once
		   more and answers nothing of the other module's row. */
		const beyond = await body<{
			items: unknown[];
			page: { nextCursor: string | null };
		}>(
			await owner.call(
				'/api/documents?ownerModule=directory.core&limit=1&cursor=' +
					String(answered.page.nextCursor),
			),
		);
		expect(beyond.items).toEqual([]);
		expect(beyond.page.nextCursor).toBeNull();
	});

	/* The search term is a filter like the others: a screen that narrowed its
	   own page would search whatever rows that page happened to carry. */
	it('DOCUMENTS-PAGE applies the search term to the query over filename and description', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		const named = await upload(owner, 'invoice-2026.pdf');
		const described = await upload(owner, 'scan-0042.pdf', {
			[UPLOAD_HEADERS.description]: 'Signed INVOICE copy',
		});
		await upload(owner, 'handbook.pdf');

		const found = await body<{ items: { id: string }[] }>(
			await owner.call('/api/documents?q=invoice'),
		);
		expect(found.items.map((entry) => entry.id).sort()).toEqual(
			[named, described].sort(),
		);

		/* A wildcard is a character of the term, never a pattern the caller gets
		   to write: escaping it is what keeps `%` from listing the workspace. */
		const wildcard = await body<{ items: unknown[] }>(
			await owner.call('/api/documents?q=' + encodeURIComponent('%')),
		);
		expect(wildcard.items).toEqual([]);

		const first = await body<{
			items: { id: string }[];
			page: { nextCursor: string | null };
		}>(await owner.call('/api/documents?q=invoice&limit=1'));
		expect(first.items.length).toBe(1);
		const second = await body<{ items: { id: string }[] }>(
			await owner.call(
				'/api/documents?q=invoice&limit=1&cursor=' +
					String(first.page.nextCursor),
			),
		);
		/* The term travels with the cursor, so the second page continues the
		   same result set instead of reopening the workspace. */
		expect(
			new Set([...first.items, ...second.items].map((entry) => entry.id)),
		).toEqual(new Set([named, described]));

		expect(
			(await owner.call('/api/documents?q=' + 'a'.repeat(201))).status,
		).toBe(400);
	});

	it('serves the object limits the uploader has to state', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		const response = await owner.call('/api/documents/limits');
		expect(response.status).toBe(200);
		const limits = await body<{
			maxObjectBytes: number;
			contentTypes: string[];
		}>(response);
		expect(limits.maxObjectBytes).toBe(context.storage.maxObjectBytes);
		expect(limits.contentTypes).toContain('application/pdf');
		expect(limits.contentTypes).not.toContain('application/zip');
		expect((await fixture(null).call('/api/documents/limits')).status).toBe(
			401,
		);
	});
});

describe('upload headers', () => {
	/* A byte above 0x7F is read as Latin-1 by one hop and as UTF-8 by the next,
	   so a name that arrives that way is not the name that was sent. */
	it('refuses a header value that is not percent-encoded ASCII', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		const refused = await owner.upload(pdfBytes(), {
			/* What a client that sends UTF-8 bytes raw looks like once the server
			   has read the header as the Latin-1 a header value is. */
			[UPLOAD_HEADERS.filename]: 'caf\u00e9.pdf',
		});

		expect(refused.status).toBe(400);
		expect(await context.repository.storedBytes(TENANT)).toBe(0);

		const accepted = await owner.upload(pdfBytes(), {
			[UPLOAD_HEADERS.filename]: encodeURIComponent('zaświadczenie.pdf'),
		});
		expect(accepted.status).toBe(201);
		expect(
			(await body<{ document: { filename: string } }>(accepted)).document
				.filename,
		).toBe('zaświadczenie.pdf');
	});
});
