import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import {
	BACKUP_MANIFEST_FILE,
	BACKUP_MANIFEST_VERSION,
	type DatabaseProvider,
} from '@flowdular/database';
import { createDataClassRegistry } from '@flowdular/kernel';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	createAuthenticationMiddleware,
	type AuthRuntime,
	type PlatformServerComposition,
} from '@flowdular/module-auth/server';
import { AUDIT_PERMISSIONS } from '../src/acl/permissions.ts';
import { createServerComposition } from '../src/platform.ts';
import { createAuditRuntime } from '../src/server/runtime.ts';
import {
	AUDIT_ERASURE_CAPABILITY,
	type AuditErasureRegistry,
} from '../src/services/erasure-port.ts';
import {
	openAuditTestDatabase,
	type AuditTestDatabase,
} from './support/database.ts';
import { FakeOwnerModule } from './support/fake-modules.ts';
import {
	openOperatorDirectory,
	type OperatorDirectory,
} from './support/operator.ts';

const ORIGIN = 'https://erp.example';
const SESSION_TOKEN = 'session-token-worker';
const CSRF_TOKEN = 'csrf-token-worker';
const TENANT = 'tenant-audit-worker';

const READER: AuthPrincipal = {
	accountId: 'account-ada',
	tenantId: TENANT,
	email: 'ada@example.com',
	displayName: 'Ada',
	role: 'owner',
	scopes: [AUDIT_PERMISSIONS.read],
	tenants: [],
};

let shared: AuditTestDatabase;
let operator: OperatorDirectory;
let backups: string;

beforeAll(async () => {
	shared = await openAuditTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

/* The sweep and the export both refuse to run without a recorded backup, so
   every case starts from a deployment that has one. */
async function openDeployment(): Promise<NodeJS.ProcessEnv> {
	operator = await openOperatorDirectory();
	backups = await mkdtemp(join(tmpdir(), 'audit-backup-'));
	await writeFile(
		join(backups, BACKUP_MANIFEST_FILE),
		JSON.stringify({
			schemaVersion: BACKUP_MANIFEST_VERSION,
			createdAt: new Date().toISOString(),
			adapter: 'pglite',
			platformVersion: '0.2.0',
			modules: ['audit.core'],
			keys: [],
		}),
	);
	return { ...operator.environment, FD_AUDIT_BACKUP_MANIFEST: backups };
}

afterEach(async () => {
	await shared.reset();
	await operator?.cleanup();
	if (backups) await rm(backups, { recursive: true, force: true });
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

function ownerModule(): FakeOwnerModule {
	return new FakeOwnerModule('agents.core', 'runs', [
		{
			tenantId: TENANT,
			id: 'run-1',
			at: Date.now() - 1_000,
			payload: { status: 'succeeded' },
		},
	]);
}

interface Role {
	readonly composition: PlatformServerComposition;
	readonly erasure: AuditErasureRegistry;
	get(path: string): Promise<Response>;
}

/* One platform process: its own data class registry, which every module
   declares into while composing and the platform seals afterwards, over the
   database every process of a deployment shares. */
function compose(owner: FakeOwnerModule, environment: NodeJS.ProcessEnv): Role {
	const registered = new Map<string, unknown>();
	const dataClasses = createDataClassRegistry();
	dataClasses.declare(owner.moduleId, [owner.declaration()]);
	const auth = sessionAuth(READER);
	const composition = createServerComposition({
		environment,
		workspaceRoot: operator.workspaceRoot,
		databases: shared.databases,
		auth,
		settings: {},
		dataClasses,
		capabilities: {
			register: (id: string, value: unknown) => registered.set(id, value),
			get: (id: string) => registered.get(id) ?? null,
		},
	} as never);
	const erasure = registered.get(
		AUDIT_ERASURE_CAPABILITY,
	) as AuditErasureRegistry;
	erasure.register({
		moduleId: owner.moduleId,
		classId: owner.classId,
		erase: owner.erase,
	});
	dataClasses.seal();
	return {
		composition,
		erasure,
		get: async (path) => {
			const route = composition.routes.find(
				(candidate) =>
					candidate.path === path && candidate.methods.includes('GET'),
			);
			if (!route) throw new Error(`Route GET ${path} is missing.`);
			const request = new Request(ORIGIN + path, {
				headers: { cookie: `coreloom_session_dev=${SESSION_TOKEN}` },
			});
			const context = {
				request,
				params: {},
				url: new URL(request.url),
				state: new Map<string, unknown>(),
			};
			await auth.middleware(context as never, async () => new Response(null));
			return route.handler(context as never);
		},
	};
}

/* The operator command records the request from a process of its own; only a
   running platform performs it. */
async function requestExport(environment: NodeJS.ProcessEnv): Promise<string> {
	const command = createAuditRuntime({
		databases: shared.databases,
		dataClasses: createDataClassRegistry(),
		environment,
		workspaceRoot: operator.workspaceRoot,
		repository: shared.repository,
		sweepIntervalMs: () => 60_000,
		sweepBatchSize: () => 500,
	});
	try {
		const run = await (
			await command.exports()
		).request({
			tenantId: TENANT,
			slug: 'audit-worker',
			name: 'Audit worker',
			requestedBy: 'cli:operator',
			outputDirectory: operator.allowed,
			apply: true,
		});
		expect(run.status).toBe('started');
		return run.id;
	} finally {
		await command.dispose();
	}
}

const exportRun = (id: string) => shared.repository.getExportRun(TENANT, id);

const settle = (ms = 0) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe('AUDIT-WEB-WORKER-ROLE both roles seal the registry and only the worker performs', () => {
	it('serves routes in the web role without a sweep, export or erasure poll, and a worker started later performs the persisted export', async () => {
		const environment = await openDeployment();
		const owner = ownerModule();
		const acquire = vi.spyOn(shared.databases, 'acquire');
		const web = compose(owner, environment);
		const worker = compose(owner, environment);
		try {
			web.composition.start?.();
			await settle();
			expect(acquire).not.toHaveBeenCalled();
			expect(() =>
				web.erasure.register({
					moduleId: 'directory.core',
					classId: 'directory.core.parties',
					erase: owner.erase,
				}),
			).toThrow(/after the platform started/);
			expect(web.erasure.list().map((entry) => entry.classId)).toEqual([
				owner.classId,
			]);

			const id = await requestExport(environment);
			const history = await web.get('/api/audit/exports');
			expect(history.status).toBe(200);
			expect(
				(
					(await history.json()) as {
						exports: { id: string; status: string }[];
					}
				).exports,
			).toEqual([expect.objectContaining({ id, status: 'started' })]);
			await web.composition.stop?.();
			expect(await exportRun(id)).toMatchObject({
				status: 'started',
				archivePath: null,
			});
			expect(owner.exportCalls).toEqual([]);

			worker.composition.start?.();
			expect(() =>
				worker.erasure.register({
					moduleId: 'directory.core',
					classId: 'directory.core.parties',
					erase: owner.erase,
				}),
			).toThrow(/after the platform started/);
			await worker.composition.startWorker?.();
			await worker.composition.stop?.();
			const performed = await exportRun(id);
			expect(performed).toMatchObject({ status: 'completed', reason: null });
			expect(performed?.archivePath).not.toBeNull();
			expect(owner.exportCalls).toEqual([TENANT]);
		} finally {
			acquire.mockRestore();
			await web.composition.dispose?.();
			await worker.composition.dispose?.();
		}
	});
});

describe('AUDIT-WORKER-DRAIN stopping a worker drains the export it holds', () => {
	it('waits for the in-flight export, claims nothing while stopped, and performs the next request after startWorker again', async () => {
		const environment = await openDeployment();
		const owner = ownerModule();
		const entered = deferred();
		const release = deferred();
		owner.beforeExport = async () => {
			entered.resolve();
			await release.promise;
		};
		const worker = compose(owner, environment);
		try {
			worker.composition.start?.();
			const first = await requestExport(environment);
			await worker.composition.startWorker?.();
			await entered.promise;

			let stopped = false;
			const stopping = Promise.resolve(worker.composition.stop?.()).then(() => {
				stopped = true;
			});
			await settle(20);
			expect(stopped).toBe(false);
			release.resolve();
			await stopping;
			expect(await exportRun(first)).toMatchObject({ status: 'completed' });

			const second = await requestExport(environment);
			await worker.composition.stop?.();
			expect(await exportRun(second)).toMatchObject({ status: 'started' });
			expect(owner.exportCalls).toEqual([TENANT]);

			await worker.composition.startWorker?.();
			await worker.composition.stop?.();
			expect(await exportRun(second)).toMatchObject({ status: 'completed' });
			expect(owner.exportCalls).toEqual([TENANT, TENANT]);
		} finally {
			release.resolve();
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
		const environment = await openDeployment();
		const owner = ownerModule();
		const worker = compose(owner, environment);
		try {
			const id = await requestExport(environment);
			const refusal = refuseFirstOpen(shared.databases);
			try {
				worker.composition.start?.();
				await worker.composition.startWorker?.();
				await worker.composition.stop?.();
				expect(refusal.refused()).toBe(1);
				expect(refusal.runtimeReleases).toHaveLength(1);
				expect(refusal.runtimeReleases[0]).toHaveBeenCalledTimes(1);
				expect(await exportRun(id)).toMatchObject({
					status: 'started',
					archivePath: null,
				});

				await worker.composition.startWorker?.();
				await worker.composition.stop?.();
				expect(await exportRun(id)).toMatchObject({
					status: 'completed',
					reason: null,
				});
			} finally {
				refusal.restore();
			}
		} finally {
			await worker.composition.dispose?.();
		}
	});
});
