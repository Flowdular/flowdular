import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import type { DatabaseProvider } from '@flowdular/database';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	createAuthenticationMiddleware,
	type AuthRuntime,
	type PlatformServerComposition,
} from '@flowdular/module-auth/server';
import {
	ADAPTERS_SOURCES_CAPABILITY,
	type AdapterRegistry,
} from '../src/domain/registry.ts';
import { createServerComposition } from '../src/platform.ts';
import {
	CONNECTORS_CALLS_CAPABILITY,
	EXPORT_LISTS_CAPABILITY,
	IMPORT_WRITE_CAPABILITY,
	METERING_METERS_CAPABILITY,
	type ImportWriter,
} from '../src/services/capabilities.ts';
import { DatabaseAdaptersRepository } from '../src/services/database-repository.ts';
import {
	openAdaptersTestDatabase,
	type AdaptersTestDatabase,
} from './support/database.ts';
import {
	createFakeCalls,
	createFakeList,
	createFakeMeters,
	createFakeWriter,
	principal,
	TENANT,
	type FakeWriter,
} from './support/fakes.ts';
import { SOURCE_ID, sourceRegistration } from './support/service.ts';

const ORIGIN = 'https://erp.example';
const SESSION_TOKEN = 'session-token-worker';
const CSRF_TOKEN = 'csrf-token-worker';

let database: AdaptersTestDatabase;

beforeAll(async () => {
	database = await openAdaptersTestDatabase();
});

beforeEach(async () => {
	await database.reset();
});

afterAll(async () => {
	await database?.dispose();
});

const owner = principal();

/* The session the routes read and the live member a run acts for. */
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
		findTenantMember: async (tenantId: string, accountId: string) =>
			tenantId === session.tenantId && accountId === session.accountId
				? {
						...session,
						status: 'active',
						membershipStatus: 'active',
					}
				: null,
	} as unknown as Awaited<ReturnType<AuthRuntime['service']>>;
	return {
		cookie,
		middleware: createAuthenticationMiddleware(async () => service, cookie),
		service: async () => service,
	} as unknown as AuthRuntime;
}

interface Role {
	readonly composition: PlatformServerComposition;
	readonly sources: AdapterRegistry;
	get(path: string): Promise<Response>;
	post(path: string, body: unknown): Promise<Response>;
}

/* One platform process: the composition the generated platform builds, over
   the database every process of a deployment shares, with fakes of the
   capabilities a run consumes. */
function compose(writer: ImportWriter): Role {
	const registered = new Map<string, unknown>([
		[CONNECTORS_CALLS_CAPABILITY, createFakeCalls().calls],
		[IMPORT_WRITE_CAPABILITY, writer],
		[EXPORT_LISTS_CAPABILITY, createFakeList().lists],
		[METERING_METERS_CAPABILITY, createFakeMeters().meters],
	]);
	const auth = sessionAuth(owner);
	const composition = createServerComposition({
		environment: { NODE_ENV: 'test' },
		databases: database.databases,
		auth,
		settings: {},
		dataClasses: { declare: () => undefined },
		capabilities: {
			register: (id: string, value: unknown) => registered.set(id, value),
			get: (id: string) => registered.get(id) ?? null,
		},
	} as never);
	const sources = registered.get(
		ADAPTERS_SOURCES_CAPABILITY,
	) as AdapterRegistry;
	sources.register('vendors.core', [sourceRegistration()]);
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
		sources,
		get: (path) => invoke('GET', path),
		post: (path, body) => invoke('POST', path, body),
	};
}

async function enable(role: Role): Promise<void> {
	const response = await role.post('/api/adapters/bind', {
		adapterId: SOURCE_ID,
		instanceId: null,
		enabled: true,
		mapping: null,
		schedule: null,
	});
	expect(response.status).toBe(200);
}

async function startRun(role: Role): Promise<{ id: string; status: string }> {
	const response = await role.post('/api/adapters/runs/start', {
		adapterId: SOURCE_ID,
	});
	expect(response.status).toBe(201);
	return ((await response.json()) as { run: { id: string; status: string } })
		.run;
}

const run = (id: string) => database.repository.findRun(TENANT, id);

/* The recorded fixture: two pages, one row the mapping refuses. */
const SUCCEEDED = {
	status: 'succeeded',
	pages: 2,
	rowsCreated: 2,
	rowsFailed: 1,
};

const settle = (ms = 0) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe('ADAPTER-WEB-WORKER-ROLE the web role queues and the worker role runs', () => {
	it('stores a queued run in the web role without a poll, a wake or a claim, and a worker started later performs it', async () => {
		const writer: FakeWriter = createFakeWriter();
		const acquire = vi.spyOn(database.databases, 'acquire');
		const web = compose(writer.writer);
		const worker = compose(writer.writer);
		try {
			web.composition.start?.();
			await settle();
			expect(acquire).not.toHaveBeenCalled();
			expect(() =>
				web.sources.register('vendors.core', [
					sourceRegistration({ id: 'vendors.core.late' }),
				]),
			).toThrow(expect.objectContaining({ code: 'ADAPTER_REGISTRY_SEALED' }));
			const catalogue = await web.get('/api/adapters');
			expect(catalogue.status).toBe(200);
			expect(
				(
					(await catalogue.json()) as { adapters: { id: string }[] }
				).adapters.map((adapter) => adapter.id),
			).toEqual([SOURCE_ID]);

			await enable(web);
			const queued = await startRun(web);
			expect(queued.status).toBe('queued');
			/* Stop drains anything a wake would have started in this process; the
			   web role started nothing, so the run is as the request left it. */
			await web.composition.stop?.();
			expect(await run(queued.id)).toMatchObject({
				status: 'queued',
				claimedBy: null,
			});
			expect(writer.writes).toEqual([]);

			worker.composition.start?.();
			await worker.composition.startWorker?.();
			await worker.composition.stop?.();
			expect(await run(queued.id)).toMatchObject(SUCCEEDED);
			expect(writer.records.get(TENANT)?.size).toBe(2);
		} finally {
			acquire.mockRestore();
			await web.composition.dispose?.();
			await worker.composition.dispose?.();
		}
	});
});

describe('ADAPTER-WORKER-DRAIN stopping a worker drains the run it is performing', () => {
	it('waits for the in-flight page, claims nothing while stopped, and runs again after startWorker', async () => {
		const writer = createFakeWriter();
		const entered = deferred();
		const release = deferred();
		const gated: ImportWriter = {
			...writer.writer,
			write: async (input) => {
				entered.resolve();
				await release.promise;
				return writer.writer.write(input);
			},
		};
		const routing = vi.spyOn(
			DatabaseAdaptersRepository.prototype,
			'listPendingRuns',
		);
		const worker = compose(gated);
		try {
			worker.composition.start?.();
			await enable(worker);
			const first = await startRun(worker);
			await worker.composition.startWorker?.();
			await entered.promise;
			expect(await run(first.id)).toMatchObject({ status: 'running' });

			let stopped = false;
			const stopping = Promise.resolve(worker.composition.stop?.()).then(() => {
				stopped = true;
			});
			await settle(20);
			expect(stopped).toBe(false);
			release.resolve();
			await stopping;
			expect(await run(first.id)).toMatchObject(SUCCEEDED);

			const second = await startRun(worker);
			await worker.composition.stop?.();
			expect(await run(second.id)).toMatchObject({
				status: 'queued',
				claimedBy: null,
			});

			await worker.composition.startWorker?.();
			await worker.composition.stop?.();
			expect(await run(second.id)).toMatchObject({
				...SUCCEEDED,
				rowsCreated: 0,
				rowsUpdated: 2,
			});

			/* Once the restarted worker's first pass found nothing, only the wake a
			   new run raises can claim it before the poll interval. */
			routing.mockClear();
			await worker.composition.startWorker?.();
			await vi.waitFor(() => expect(routing).toHaveBeenCalledTimes(1), {
				timeout: 10_000,
			});
			await routing.mock.results[0]!.value;
			await settle();
			const third = await startRun(worker);
			await worker.composition.stop?.();
			expect(await run(third.id)).toMatchObject({ status: 'succeeded' });
		} finally {
			release.resolve();
			routing.mockRestore();
			await worker.composition.dispose?.();
		}
	});
});

/* Refuses the first background lease, which an open takes after its runtime
   lease, and counts the releases of every runtime lease handed out. */
function refuseFirstOpen(databases: DatabaseProvider) {
	const acquire = databases.acquire.bind(databases);
	const runtimeReleases: ReturnType<typeof vi.fn>[] = [];
	let refused = 0;
	const spy = vi
		.spyOn(databases, 'acquire')
		.mockImplementation(async (request) => {
			if (request.purpose === 'background' && refused === 0) {
				refused += 1;
				throw new Error('background pool unavailable');
			}
			const lease = await acquire(request);
			if (request.purpose === 'migration' || request.purpose === 'background')
				return lease;
			const release = vi.fn(() => lease.release());
			runtimeReleases.push(release);
			return { database: lease.database, release };
		});
	return {
		runtimeReleases,
		refused: () => refused,
		restore: () => spy.mockRestore(),
	};
}

describe('a worker whose database open failed', () => {
	it('opens it again on the next startWorker of the same composition and released what the failed open held', async () => {
		const writer: FakeWriter = createFakeWriter();
		const web = compose(writer.writer);
		const worker = compose(writer.writer);
		try {
			web.composition.start?.();
			await enable(web);
			const queued = await startRun(web);
			const refusal = refuseFirstOpen(database.databases);
			try {
				worker.composition.start?.();
				await worker.composition.startWorker?.();
				await worker.composition.stop?.();
				expect(refusal.refused()).toBe(1);
				expect(refusal.runtimeReleases).toHaveLength(1);
				expect(refusal.runtimeReleases[0]).toHaveBeenCalledTimes(1);
				expect(await run(queued.id)).toMatchObject({
					status: 'queued',
					claimedBy: null,
				});

				await worker.composition.startWorker?.();
				await worker.composition.stop?.();
				expect(await run(queued.id)).toMatchObject(SUCCEEDED);
			} finally {
				refusal.restore();
			}
		} finally {
			await web.composition.dispose?.();
			await worker.composition.dispose?.();
		}
	});

	it('answers the next request of the same composition after a failed open', async () => {
		const web = compose(createFakeWriter().writer);
		const refusal = refuseFirstOpen(database.databases);
		try {
			web.composition.start?.();
			const refused = await web.post('/api/adapters/bind', {
				adapterId: SOURCE_ID,
				instanceId: null,
				enabled: true,
				mapping: null,
				schedule: null,
			});
			expect(refused.status).toBe(500);
			expect(refusal.refused()).toBe(1);
			await enable(web);
		} finally {
			refusal.restore();
			await web.composition.dispose?.();
		}
	});
});
