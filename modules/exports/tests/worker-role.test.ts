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
import type { DefinedListExport } from '@flowdular/server';
import {
	EXPORT_LISTS_CAPABILITY,
	type ExportLists,
} from '../src/domain/lists.ts';
import type { ExportJobView } from '../src/domain/types.ts';
import { createServerComposition } from '../src/platform.ts';
import {
	openExportHarness,
	principal,
	TENANT,
	type ExportTestHarness,
} from './support/harness.ts';
import { createFakeList, members, MEMBERS_LIST } from './support/lists.ts';

const ORIGIN = 'https://erp.example';
const SESSION_TOKEN = 'session-token-worker';
const CSRF_TOKEN = 'csrf-token-worker';

let harness: ExportTestHarness;

beforeAll(async () => {
	harness = await openExportHarness();
});

afterAll(async () => {
	await harness?.dispose();
});

afterEach(async () => {
	await harness.reset();
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
	readonly lists: ExportLists;
	get(path: string, params?: Record<string, string>): Promise<Response>;
	post(path: string, body: unknown): Promise<Response>;
}

/* One platform process: the composition the generated platform builds, over
   the database and the object store every process of a deployment shares. */
function compose(list: DefinedListExport): Role {
	const registered = new Map<string, unknown>();
	const auth = sessionAuth(principal());
	const composition = createServerComposition({
		environment: {
			NODE_ENV: 'test',
			FD_STORAGE_ADAPTER: 'local',
			FD_STORAGE_LOCAL_DIRECTORY: harness.storageDirectory,
			FD_STORAGE_MAX_OBJECT_BYTES: '1048576',
		},
		workspaceRoot: process.cwd(),
		databases: harness.databases,
		storage: harness.storage,
		settings: {},
		auth,
		dataClasses: { declare: () => undefined },
		capabilities: {
			register: (id: string, value: unknown) => registered.set(id, value),
			get: (id: string) => registered.get(id) ?? null,
		},
	} as never);
	const lists = registered.get(EXPORT_LISTS_CAPABILITY) as ExportLists;
	lists.register('users.core', [list]);
	const invoke = async (
		method: 'GET' | 'POST',
		path: string,
		requestPath: string,
		params: Record<string, string>,
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
		const request = new Request(ORIGIN + requestPath, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const context = {
			request,
			params,
			url: new URL(request.url),
			state: new Map<string, unknown>(),
		};
		await auth.middleware(context as never, async () => new Response(null));
		return route.handler(context as never);
	};
	return {
		composition,
		lists,
		get: (path, params = {}) => {
			let requestPath = path;
			for (const [key, value] of Object.entries(params)) {
				requestPath = requestPath.replace(`:${key}`, value);
			}
			return invoke('GET', path, requestPath, params);
		},
		post: (path, body) => invoke('POST', path, path, {}, body),
	};
}

async function startExport(role: Role): Promise<ExportJobView> {
	const response = await role.post('/api/exports/start', {
		list: MEMBERS_LIST,
	});
	expect(response.status).toBe(201);
	return ((await response.json()) as { job: ExportJobView }).job;
}

const job = (id: string) => harness.repository.findJob(TENANT, id);

const settle = (ms = 0) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe('EXPORTS-WEB-WORKER-ROLE the web role queues and the worker role writes', () => {
	it('persists a requested job in the web role without a poll or a claim, and a worker started later writes the file', async () => {
		const list = createFakeList();
		list.rows.set(TENANT, members(3));
		const acquire = vi.spyOn(harness.databases, 'acquire');
		const web = compose(list.definition);
		const worker = compose(list.definition);
		try {
			web.composition.start?.();
			await settle();
			expect(acquire).not.toHaveBeenCalled();
			expect(() => web.lists.register('users.core', [])).toThrow(
				expect.objectContaining({ code: 'EXPORT_LISTS_SEALED' }),
			);
			const catalogue = await web.get('/api/exports/lists');
			expect(catalogue.status).toBe(200);
			expect(
				((await catalogue.json()) as { lists: { id: string }[] }).lists.map(
					(entry) => entry.id,
				),
			).toEqual([MEMBERS_LIST]);

			const requested = await startExport(web);
			expect(requested.status).toBe('requested');
			/* Stop drains anything the web role might have started; it started
			   nothing, so the job is exactly as the request left it. */
			await web.composition.stop?.();
			expect(await job(requested.id)).toMatchObject({
				status: 'requested',
				claimedAt: null,
			});
			expect(list.calls).toHaveLength(0);

			worker.composition.start?.();
			await worker.composition.startWorker?.();
			await worker.composition.stop?.();
			expect(await job(requested.id)).toMatchObject({
				status: 'completed',
				rowCount: 3,
			});
			const read = await web.get('/api/exports/jobs/:id', {
				id: requested.id,
			});
			expect(((await read.json()) as { job: ExportJobView }).job).toMatchObject(
				{ status: 'completed', downloadable: true },
			);
		} finally {
			acquire.mockRestore();
			await web.composition.dispose?.();
			await worker.composition.dispose?.();
		}
	});
});

describe('EXPORTS-WORKER-DRAIN stopping a worker drains the file it is writing', () => {
	it('waits for the in-flight job, claims nothing while stopped, and takes the next job after startWorker again', async () => {
		const list = createFakeList();
		list.rows.set(TENANT, members(3));
		const entered = deferred();
		const release = deferred();
		const gated: DefinedListExport = {
			...list.definition,
			page: async (pagePrincipal, cursor, limit) => {
				entered.resolve();
				await release.promise;
				return list.definition.page(pagePrincipal, cursor, limit);
			},
		};
		const worker = compose(gated);
		try {
			worker.composition.start?.();
			const first = await startExport(worker);
			await worker.composition.startWorker?.();
			await entered.promise;
			expect(await job(first.id)).toMatchObject({ status: 'running' });

			let stopped = false;
			const stopping = Promise.resolve(worker.composition.stop?.()).then(() => {
				stopped = true;
			});
			await settle(20);
			expect(stopped).toBe(false);
			release.resolve();
			await stopping;
			expect(await job(first.id)).toMatchObject({
				status: 'completed',
				rowCount: 3,
			});

			const second = await startExport(worker);
			await worker.composition.stop?.();
			expect(await job(second.id)).toMatchObject({
				status: 'requested',
				claimedAt: null,
			});

			await worker.composition.startWorker?.();
			await worker.composition.stop?.();
			expect(await job(second.id)).toMatchObject({
				status: 'completed',
				rowCount: 3,
			});
		} finally {
			release.resolve();
			await worker.composition.dispose?.();
		}
	});
});
