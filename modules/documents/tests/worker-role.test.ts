import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	createAuthenticationMiddleware,
	type AuthRuntime,
	type PlatformServerComposition,
} from '@flowdular/module-auth/server';
import type { StoragePort } from '@flowdular/storage';
import { DOCUMENTS_PERMISSIONS } from '../src/acl/permissions.ts';
import { DOCUMENT_TEXT_LIMITS } from '../src/domain/text.ts';
import {
	DOCUMENTS_TEMPLATES_CAPABILITY,
	type DocumentTemplates,
} from '../src/domain/templates.ts';
import { createServerComposition } from '../src/platform.ts';
import { DatabaseTemplatesRepository } from '../src/services/templates-repository.ts';
import {
	openDocumentsTestContext,
	type DocumentsTestContext,
} from './support/database.ts';
import { textBytes } from './support/files.ts';
import { OFFER_KEY, offerDefinition, offerInput } from './support/templates.ts';

const ORIGIN = 'https://erp.example';
const SESSION_TOKEN = 'session-token-worker';
const CSRF_TOKEN = 'csrf-token-worker';
const TENANT = 'tenant-documents-worker';
const ACCOUNT = 'account-ada';

const MANAGER: AuthPrincipal = {
	accountId: ACCOUNT,
	tenantId: TENANT,
	email: 'ada@example.com',
	displayName: 'Ada',
	role: 'owner',
	scopes: [
		DOCUMENTS_PERMISSIONS.read,
		DOCUMENTS_PERMISSIONS.manage,
		DOCUMENTS_PERMISSIONS.templatesRead,
	],
	tenants: [],
};

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

function sessionAuth(session: AuthPrincipal): AuthRuntime {
	const cookie = {
		name: 'coreloom_session_dev',
		secure: false,
		maxAgeSeconds: 3_600,
	};
	const service = {
		resolveSession: async (token: string | null) =>
			token === SESSION_TOKEN
				? { principal: session, csrfToken: CSRF_TOKEN, expiresAt: 0 }
				: null,
		resolveApiTokenIdentity: async () => null,
	} as unknown as Awaited<ReturnType<AuthRuntime['service']>>;
	return {
		cookie,
		middleware: createAuthenticationMiddleware(async () => service, cookie),
		service: async () => service,
	} as unknown as AuthRuntime;
}

interface Role {
	readonly composition: PlatformServerComposition;
	readonly templates: DocumentTemplates;
	get(path: string): Promise<Response>;
	post(path: string, body: unknown): Promise<Response>;
}

/* One platform process: the composition the generated platform builds, over
   the database and the object store every process of a deployment shares. */
function compose(storage: StoragePort = context.storage.port): Role {
	const registered = new Map<string, unknown>();
	const auth = sessionAuth(MANAGER);
	const composition = createServerComposition({
		environment: { NODE_ENV: 'test' },
		workspaceRoot: process.cwd(),
		auth,
		settings: {
			prime: async () => undefined,
			get: () => {
				throw new Error('Not declared in this case.');
			},
		},
		storage,
		databases: context.databases,
		agentTools: { register: () => undefined },
		dataClasses: { declare: () => undefined },
		capabilities: {
			register: (id: string, value: unknown) => registered.set(id, value),
			get: (id: string) => registered.get(id) ?? null,
		},
	} as never);
	const templates = registered.get(
		DOCUMENTS_TEMPLATES_CAPABILITY,
	) as DocumentTemplates;
	templates.register('orders.core', [offerDefinition()]);
	const invoke = async (
		method: 'GET' | 'POST',
		path: string,
		body?: unknown,
	) => {
		const route = composition.routes.find(
			(candidate) =>
				candidate.path === path && candidate.methods.includes(method),
		);
		if (!route) throw new Error(`Route ${method} ${path} is missing.`);
		const headers = new Headers({
			cookie: `coreloom_session_dev=${SESSION_TOKEN}`,
		});
		if (method === 'POST') {
			headers.set('content-type', 'application/json');
			headers.set('origin', ORIGIN);
			headers.set('x-csrf-token', CSRF_TOKEN);
		}
		const request = new Request(ORIGIN + path, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const octane = {
			request,
			params: {},
			url: new URL(request.url),
			state: new Map<string, unknown>(),
		};
		await auth.middleware(octane as never, async () => new Response(null));
		return route.handler(octane as never);
	};
	return {
		composition,
		templates,
		get: (path) => invoke('GET', path),
		post: (path, body) => invoke('POST', path, body),
	};
}

/* More repeated rows than a request renders inline, so the render is queued. */
async function queueRender(role: Role, customer: string): Promise<string> {
	const answer = await role.templates.render({
		tenantId: TENANT,
		principal: { accountId: ACCOUNT, scopes: MANAGER.scopes },
		ownerModule: 'orders.core',
		recordRef: 'order-1',
		templateKey: OFFER_KEY,
		input: offerInput(51, customer),
	});
	expect(answer).toMatchObject({ status: 'queued', documentId: null });
	return answer.jobId;
}

const render = (id: string) => context.templates.findRender(TENANT, id);

const settle = (ms = 0) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe('DOCUMENTS-WEB-WORKER-ROLE the web role queues and the worker role performs', () => {
	it('persists a queued render and a pending extraction in the web role without a poll, a wake or a claim, and a worker started later performs both', async () => {
		const acquire = vi.spyOn(context.databases, 'acquire');
		const web = compose();
		const worker = compose();
		try {
			web.composition.start?.();
			await settle();
			expect(acquire).not.toHaveBeenCalled();
			expect(() =>
				web.templates.register('orders.core', [
					offerDefinition({ key: 'orders.core.late' }),
				]),
			).toThrow(/after documents.core started/);
			const catalogue = await web.get('/api/documents/templates');
			expect(catalogue.status).toBe(200);
			expect(
				((await catalogue.json()) as { items: { key: string }[] }).items.map(
					(item) => item.key,
				),
			).toEqual([OFFER_KEY]);

			const jobId = await queueRender(web, 'Web');
			const large = await context.service().upload(TENANT, ACCOUNT, {
				ownerModule: 'directory.core',
				recordRef: 'party-1',
				filename: 'large.txt',
				contentType: 'text/plain',
				body: textBytes(DOCUMENT_TEXT_LIMITS.inlineBytes + 1),
			});
			const text = await web.post('/api/documents/text', { id: large.id });
			expect(text.status).toBe(200);
			expect(await text.json()).toMatchObject({ status: 'pending' });

			/* Stop drains anything a wake would have started in this process; the
			   web role started nothing, so both rows are as the requests left them. */
			await web.composition.stop?.();
			expect(await render(jobId)).toMatchObject({
				status: 'queued',
				attempts: 0,
			});
			expect(await context.repository.findText(TENANT, large.id)).toMatchObject(
				{ status: 'pending', attempts: 0 },
			);

			worker.composition.start?.();
			await worker.composition.startWorker?.();
			await worker.composition.stop?.();
			const rendered = await render(jobId);
			expect(rendered).toMatchObject({ status: 'succeeded', attempts: 1 });
			expect(rendered?.documentId).not.toBeNull();
			expect(await context.repository.findText(TENANT, large.id)).toMatchObject(
				{ status: 'ok', attempts: 1 },
			);
		} finally {
			acquire.mockRestore();
			await web.composition.dispose?.();
			await worker.composition.dispose?.();
		}
	});
});

describe('DOCUMENTS-WORKER-DRAIN stopping a worker drains the render it is storing', () => {
	it('waits for the in-flight render, claims nothing while stopped, and renders again after startWorker', async () => {
		const entered = deferred();
		const release = deferred();
		const gated: StoragePort = {
			...context.storage.port,
			put: async (input) => {
				entered.resolve();
				await release.promise;
				return context.storage.port.put(input);
			},
		};
		const routing = vi.spyOn(
			DatabaseTemplatesRepository.prototype,
			'listPendingRenders',
		);
		const worker = compose(gated);
		try {
			worker.composition.start?.();
			const first = await queueRender(worker, 'First');
			await worker.composition.startWorker?.();
			await entered.promise;
			expect(await render(first)).toMatchObject({ status: 'running' });

			let stopped = false;
			const stopping = Promise.resolve(worker.composition.stop?.()).then(() => {
				stopped = true;
			});
			await settle(20);
			expect(stopped).toBe(false);
			release.resolve();
			await stopping;
			expect(await render(first)).toMatchObject({
				status: 'succeeded',
				attempts: 1,
			});

			const second = await queueRender(worker, 'Second');
			await worker.composition.stop?.();
			expect(await render(second)).toMatchObject({
				status: 'queued',
				attempts: 0,
			});

			await worker.composition.startWorker?.();
			await worker.composition.stop?.();
			expect(await render(second)).toMatchObject({ status: 'succeeded' });

			/* Once the restarted worker's first pass found nothing, only the wake a
			   new render raises can claim it before the poll interval. */
			routing.mockClear();
			await worker.composition.startWorker?.();
			await vi.waitFor(() => expect(routing).toHaveBeenCalledTimes(1), {
				timeout: 10_000,
			});
			await routing.mock.results[0]!.value;
			await settle();
			const third = await queueRender(worker, 'Third');
			await worker.composition.stop?.();
			expect(await render(third)).toMatchObject({ status: 'succeeded' });
		} finally {
			release.resolve();
			routing.mockRestore();
			await worker.composition.dispose?.();
		}
	});
});
