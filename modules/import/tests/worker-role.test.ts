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
import { DOCUMENTS_ATTACHMENTS_CAPABILITY } from '@flowdular/module-documents';
import {
	IMPORT_PORTS_CAPABILITY,
	type ImportPort,
	type ImportPorts,
} from '../src/domain/ports.ts';
import { createServerComposition } from '../src/platform.ts';
import {
	openImportHarness,
	principal,
	TENANT,
	type ImportTestHarness,
} from './support/harness.ts';
import {
	createFakeImportPort,
	FIVE_ROW_CSV,
	MEMBERS_MAPPING,
	MEMBERS_TARGET,
} from './support/port.ts';

const ORIGIN = 'https://erp.example';
const SESSION_TOKEN = 'session-token-worker';
const CSRF_TOKEN = 'csrf-token-worker';

let harness: ImportTestHarness;

beforeAll(async () => {
	harness = await openImportHarness();
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
	readonly ports: ImportPorts;
	get(path: string): Promise<Response>;
	post(path: string, body: unknown): Promise<Response>;
}

/* One platform process: the composition the generated platform builds, over
   the database and the documents store every process of a deployment shares. */
function compose(port: ImportPort): Role {
	const registered = new Map<string, unknown>([
		[DOCUMENTS_ATTACHMENTS_CAPABILITY, harness.attachments],
	]);
	const auth = sessionAuth(principal());
	const composition = createServerComposition({
		environment: { NODE_ENV: 'test' },
		workspaceRoot: process.cwd(),
		databases: harness.databases,
		settings: {},
		auth,
		dataClasses: { declare: () => undefined },
		capabilities: {
			register: (id: string, value: unknown) => registered.set(id, value),
			get: (id: string) => registered.get(id) ?? null,
		},
	} as never);
	const ports = registered.get(IMPORT_PORTS_CAPABILITY) as ImportPorts;
	ports.register('users.core', [port]);
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
		const context = {
			request,
			params: {},
			url: new URL(request.url),
			state: new Map<string, unknown>(),
		};
		await auth.middleware(context as never, async () => new Response(null));
		return route.handler(context as never);
	};
	return {
		composition,
		ports,
		get: (path) => invoke('GET', path),
		post: (path, body) => invoke('POST', path, body),
	};
}

async function startImport(
	role: Role,
): Promise<{ id: string; status: string }> {
	const stored = await harness.storeCsv(TENANT, FIVE_ROW_CSV);
	const response = await role.post('/api/import/jobs/start', {
		target: MEMBERS_TARGET,
		documentId: stored.documentId,
		documentRef: stored.documentRef,
		mode: 'create-only',
		dryRun: false,
		columns: MEMBERS_MAPPING,
	});
	expect(response.status).toBe(201);
	return ((await response.json()) as { job: { id: string; status: string } })
		.job;
}

async function continueImport(role: Role, id: string): Promise<void> {
	const response = await role.post('/api/import/jobs/continue', {
		id,
		validOnly: true,
	});
	expect(response.status).toBe(200);
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

describe('IMPORT-WEB-WORKER-ROLE the web role queues and the worker role runs the stages', () => {
	it('persists each stage in the web role without a poll or a claim, and a worker started later performs it', async () => {
		const port = createFakeImportPort();
		const acquire = vi.spyOn(harness.databases, 'acquire');
		const web = compose(port.port);
		const worker = compose(port.port);
		try {
			web.composition.start?.();
			await settle();
			expect(acquire).not.toHaveBeenCalled();
			expect(() => web.ports.register('users.core', [])).toThrow(
				expect.objectContaining({ code: 'IMPORT_PORTS_SEALED' }),
			);
			const targets = await web.get('/api/import/targets');
			expect(targets.status).toBe(200);
			expect(
				(
					(await targets.json()) as { targets: { target: string }[] }
				).targets.map((entry) => entry.target),
			).toEqual([MEMBERS_TARGET]);

			const started = await startImport(web);
			expect(started.status).toBe('parsing');
			/* Stop drains anything the web role might have started; it started
			   nothing, so the job is exactly as the request left it. */
			await web.composition.stop?.();
			expect(await job(started.id)).toMatchObject({
				status: 'parsing',
				claimedAt: null,
			});
			expect(port.calls).toEqual([]);

			worker.composition.start?.();
			await worker.composition.startWorker?.();
			await worker.composition.stop?.();
			expect(await job(started.id)).toMatchObject({
				status: 'validated',
				totalRows: 5,
				validRows: 4,
			});

			await continueImport(web, started.id);
			await web.composition.stop?.();
			expect(await job(started.id)).toMatchObject({
				status: 'writing',
				claimedAt: null,
			});
			expect(port.records.get(TENANT)).toBeUndefined();

			await worker.composition.startWorker?.();
			await worker.composition.stop?.();
			expect(await job(started.id)).toMatchObject({
				status: 'completed',
				writtenRows: 4,
			});
			expect(port.records.get(TENANT)?.size).toBe(4);
		} finally {
			acquire.mockRestore();
			await web.composition.dispose?.();
			await worker.composition.dispose?.();
		}
	});
});

describe('IMPORT-WORKER-DRAIN stopping a worker drains the batch it is writing', () => {
	it('waits for the in-flight batch, claims nothing while stopped, and takes the next job after startWorker again', async () => {
		const port = createFakeImportPort();
		const entered = deferred();
		const release = deferred();
		const gated: ImportPort = {
			...port.port,
			write: async (input) => {
				entered.resolve();
				await release.promise;
				return port.port.write(input);
			},
		};
		const worker = compose(gated);
		try {
			worker.composition.start?.();
			const first = await startImport(worker);
			await worker.composition.startWorker?.();
			await worker.composition.stop?.();
			await continueImport(worker, first.id);
			await worker.composition.startWorker?.();
			await entered.promise;
			expect(await job(first.id)).toMatchObject({ status: 'writing' });

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
				writtenRows: 4,
			});
			expect(port.records.get(TENANT)?.size).toBe(4);

			const second = await startImport(worker);
			await worker.composition.stop?.();
			expect(await job(second.id)).toMatchObject({
				status: 'parsing',
				claimedAt: null,
			});

			await worker.composition.startWorker?.();
			await worker.composition.stop?.();
			expect(await job(second.id)).toMatchObject({ status: 'validated' });
		} finally {
			release.resolve();
			await worker.composition.dispose?.();
		}
	});
});
