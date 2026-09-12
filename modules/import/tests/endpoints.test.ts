import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	createAuthenticationMiddleware,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { IMPORT_PERMISSIONS } from '../src/acl/permissions.ts';
import { createImportRoutes } from '../src/api/endpoints.ts';
import { createImportRuntime } from '../src/server/runtime.ts';
import {
	openImportHarness,
	principal,
	TARGET_PERMISSION,
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
const SESSION_TOKEN = 'session-token-0001';
const CSRF_TOKEN = 'csrf-token-0001';

let harness: ImportTestHarness;

beforeAll(async () => {
	harness = await openImportHarness();
	harness.ports.register('users.core', [createFakeImportPort().port]);
	harness.ports.seal();
});

afterAll(async () => {
	await harness?.dispose();
});

afterEach(async () => {
	await harness.reset();
});

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

function fixture(session: AuthPrincipal | null) {
	const runtime = createImportRuntime({
		databases: harness.databases,
		purpose: 'test',
		repository: harness.repository,
		attachments: () => harness.attachments,
		maxRows: () => 50_000,
		batchSize: () => 500,
	});
	/* The registry the routes read is the runtime's own, so the harness port is
	   registered into it as a module would while the platform composes. */
	runtime.ports.register('users.core', [createFakeImportPort().port]);
	runtime.ports.seal();
	const sessions = new Map<string, AuthPrincipal>();
	if (session) sessions.set(SESSION_TOKEN, session);
	const auth = authRuntime(sessions);
	const routes = createImportRoutes(auth, runtime);
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
		init: RequestInit & {
			readonly authenticated?: boolean;
			readonly params?: Record<string, string>;
		} = {},
	) => {
		const { authenticated = true, params = {}, ...requestInit } = init;
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
			params,
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
	const call = (
		path: string,
		init: Parameters<typeof invoke>[2] = {},
		routePath = path.split('?')[0]!,
	) => invoke(routePath, path, init);
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
	return { runtime, call, mutation };
}

const MUTATIONS = [
	['/api/import/jobs/start', { target: MEMBERS_TARGET }],
	['/api/import/jobs/continue', { id: 'job-1', validOnly: true }],
	['/api/import/jobs/cancel', { id: 'job-1' }],
	['/api/import/mappings/save', { target: MEMBERS_TARGET, columns: {} }],
] as const;

const READS = [
	'/api/import/targets',
	'/api/import/jobs',
	'/api/import/mappings?target=' + MEMBERS_TARGET,
] as const;

describe('IMPORT-DENY', () => {
	it('answers 401 to every read and mutation without a session', async () => {
		const { call, mutation, runtime } = fixture(null);
		try {
			for (const path of READS) {
				const response = await call(path, { authenticated: false });
				expect([path, response.status]).toEqual([path, 401]);
			}
			for (const [path, body] of MUTATIONS) {
				const response = await mutation(path, body, { authenticated: false });
				expect([path, response.status]).toEqual([path, 401]);
			}
		} finally {
			await runtime.dispose();
		}
	});

	it('answers 403 to a read without import.jobs.read', async () => {
		const { call, runtime } = fixture(principal([IMPORT_PERMISSIONS.manage]));
		try {
			for (const path of READS) {
				const response = await call(path);
				expect([path, response.status]).toEqual([path, 403]);
			}
		} finally {
			await runtime.dispose();
		}
	});

	it('answers 403 to a mutation without import.jobs.manage', async () => {
		const { mutation, runtime } = fixture(principal([IMPORT_PERMISSIONS.read]));
		try {
			for (const [path, body] of MUTATIONS) {
				const response = await mutation(path, body);
				expect([path, response.status]).toEqual([path, 403]);
			}
		} finally {
			await runtime.dispose();
		}
	});

	it('refuses a mutation without a CSRF proof before it reads the body', async () => {
		const { call, runtime } = fixture(principal());
		try {
			for (const [path, body] of MUTATIONS) {
				const response = await call(path, {
					method: 'POST',
					headers: { 'content-type': 'application/json', origin: ORIGIN },
					body: JSON.stringify(body),
				});
				expect([path, response.status]).toEqual([path, 403]);
				expect(
					((await response.json()) as { error: { code: string } }).error.code,
				).toBe('CSRF_REJECTED');
			}
		} finally {
			await runtime.dispose();
		}
	});

	it('refuses a mutation that is not same-origin', async () => {
		const { call, runtime } = fixture(principal());
		try {
			const response = await call('/api/import/jobs/cancel', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: 'https://attacker.example',
					'x-csrf-token': CSRF_TOKEN,
				},
				body: JSON.stringify({ id: 'job-1' }),
			});
			expect(response.status).toBe(403);
		} finally {
			await runtime.dispose();
		}
	});

	it('refuses a mutation whose body is not JSON', async () => {
		const { call, runtime } = fixture(principal());
		try {
			const response = await call('/api/import/jobs/cancel', {
				method: 'POST',
				headers: {
					origin: ORIGIN,
					'x-csrf-token': CSRF_TOKEN,
					'content-type': 'text/plain',
				},
				body: 'id=job-1',
			});
			expect(response.status).toBe(415);
		} finally {
			await runtime.dispose();
		}
	});
});

describe('the import endpoints', () => {
	it('starts, reads, pages and continues a job over HTTP', async () => {
		const { call, mutation, runtime } = fixture(principal());
		try {
			const stored = await harness.storeCsv(TENANT, FIVE_ROW_CSV);
			const started = await mutation('/api/import/jobs/start', {
				target: MEMBERS_TARGET,
				documentId: stored.documentId,
				documentRef: stored.documentRef,
				mode: 'create-only',
				dryRun: false,
				columns: MEMBERS_MAPPING,
			});
			expect(started.status).toBe(201);
			const job = ((await started.json()) as { job: { id: string } }).job;

			/* The route's runtime and the harness share one repository, so the
			   harness poll drives the job the request just recorded. */
			await harness.runner.tick();

			const read = await call(
				`/api/import/jobs/${job.id}`,
				{ params: { id: job.id } },
				'/api/import/jobs/:id',
			);
			expect(read.status).toBe(200);
			expect(
				((await read.json()) as { job: { status: string } }).job.status,
			).toBe('validated');

			const rows = await call(
				`/api/import/jobs/${job.id}/rows?limit=2`,
				{ params: { id: job.id } },
				'/api/import/jobs/:id/rows',
			);
			const page = (await rows.json()) as {
				items: readonly unknown[];
				page: { nextCursor: string | null };
			};
			expect(page.items).toHaveLength(2);
			expect(page.page.nextCursor).not.toBeNull();

			const second = await call(
				`/api/import/jobs/${job.id}/rows?limit=2&cursor=${encodeURIComponent(page.page.nextCursor!)}`,
				{ params: { id: job.id } },
				'/api/import/jobs/:id/rows',
			);
			const secondPage = (await second.json()) as {
				items: readonly { rowNumber: number }[];
			};
			expect(secondPage.items.map((row) => row.rowNumber)).toEqual([3, 4]);

			const continued = await mutation('/api/import/jobs/continue', {
				id: job.id,
				validOnly: true,
			});
			expect(continued.status).toBe(200);
		} finally {
			await runtime.dispose();
		}
	});

	it('answers a job without the requester snapshot or the claim', async () => {
		const { call, mutation, runtime } = fixture(principal());
		try {
			const stored = await harness.storeCsv(TENANT, FIVE_ROW_CSV);
			const started = await mutation('/api/import/jobs/start', {
				target: MEMBERS_TARGET,
				documentId: stored.documentId,
				documentRef: stored.documentRef,
				mode: 'create-only',
				dryRun: true,
				columns: MEMBERS_MAPPING,
			});
			const created = (
				(await started.json()) as {
					job: Record<string, unknown>;
				}
			).job;
			/* The snapshot carries the requester's address, display name, role and
			   every scope they hold; a reader of a job is told who started it by
			   account id and nothing more. The claim is the poll loop's lease. */
			expect(created).not.toHaveProperty('requester');
			expect(created).not.toHaveProperty('claimedAt');
			expect(created['requesterAccountId']).toBe('account-ada');

			const listed = await call('/api/import/jobs');
			const items = (
				(await listed.json()) as {
					items: readonly Record<string, unknown>[];
				}
			).items;
			expect(items).toHaveLength(1);
			expect(items[0]).not.toHaveProperty('requester');
			expect(items[0]).not.toHaveProperty('claimedAt');

			const read = await call(
				`/api/import/jobs/${String(created['id'])}`,
				{ params: { id: String(created['id']) } },
				'/api/import/jobs/:id',
			);
			const single = ((await read.json()) as { job: Record<string, unknown> })
				.job;
			expect(single).not.toHaveProperty('requester');
			expect(single).not.toHaveProperty('claimedAt');
			expect(single['requesterAccountId']).toBe('account-ada');
		} finally {
			await runtime.dispose();
		}
	});

	it('refuses a cursor this server did not sign', async () => {
		const { call, runtime } = fixture(principal());
		try {
			const response = await call('/api/import/jobs?cursor=not-a-real-cursor');
			expect(response.status).toBe(400);
			expect(
				((await response.json()) as { error: { code: string } }).error.code,
			).toBe('CURSOR_INVALID');
		} finally {
			await runtime.dispose();
		}
	});

	it('refuses a page limit past the endpoint bound', async () => {
		const { call, runtime } = fixture(principal());
		try {
			expect((await call('/api/import/jobs?limit=201')).status).toBe(400);
			expect((await call('/api/import/jobs?limit=0')).status).toBe(400);
		} finally {
			await runtime.dispose();
		}
	});

	it('bounds the mapping a request may carry', async () => {
		const { mutation, runtime } = fixture(principal());
		try {
			const tooLong = await mutation('/api/import/mappings/save', {
				target: MEMBERS_TARGET,
				columns: { email: 'x'.repeat(400) },
			});
			expect(tooLong.status).toBe(400);
			const notAnObject = await mutation('/api/import/mappings/save', {
				target: MEMBERS_TARGET,
				columns: ['E-mail'],
			});
			expect(notAnObject.status).toBe(400);
		} finally {
			await runtime.dispose();
		}
	});

	it('answers the target list with the fields a screen builds a mapping from', async () => {
		const { call, runtime } = fixture(
			principal([IMPORT_PERMISSIONS.read, TARGET_PERMISSION]),
		);
		try {
			const response = await call('/api/import/targets');
			const body = (await response.json()) as {
				targets: readonly {
					target: string;
					permitted: boolean;
					fields: readonly { id: string }[];
				}[];
			};
			expect(body.targets).toHaveLength(1);
			expect(body.targets[0]?.permitted).toBe(true);
			expect(body.targets[0]?.fields.map((field) => field.id)).toEqual([
				'email',
				'displayName',
				'role',
			]);
		} finally {
			await runtime.dispose();
		}
	});
});
