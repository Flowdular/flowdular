import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	createAuthenticationMiddleware,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { EXPORTS_PERMISSIONS } from '../src/acl/permissions.ts';
import type { ExportJobView } from '../src/domain/types.ts';
import { createExportRoutes } from '../src/api/endpoints.ts';
import {
	createExportsRuntime,
	type ExportsRuntime,
} from '../src/server/runtime.ts';
import { createExportListRegistry } from '../src/services/list-registry.ts';
import {
	openExportHarness,
	principal,
	type ExportTestHarness,
	LIST_PERMISSION,
	TENANT,
} from './support/harness.ts';
import { createFakeList, members, MEMBERS_LIST } from './support/lists.ts';

const ORIGIN = 'https://erp.example';
const SESSION_TOKEN = 'session-token-0001';
const CSRF_TOKEN = 'csrf-token-0001';

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

interface InvokeInit extends RequestInit {
	readonly authenticated?: boolean;
	readonly params?: Record<string, string>;
}

function fixture(
	session: AuthPrincipal | null,
	runtime: ExportsRuntime = createExportsRuntime({
		databases: harness.databases,
		purpose: 'test',
		storage: harness.storage,
		repository: harness.repository,
		maxRows: () => 100_000,
		maxBytes: () => 50 * 1024 * 1024,
		maxObjectBytes: () => 1_048_576,
	}),
) {
	const list = createFakeList();
	runtime.lists.register('users.core', [list.definition]);
	runtime.lists.seal();
	const sessions = new Map<string, AuthPrincipal>();
	if (session) sessions.set(SESSION_TOKEN, session);
	const auth = authRuntime(sessions);
	const routes = createExportRoutes(auth, runtime);
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
		init: InvokeInit = {},
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
		init: InvokeInit = {},
		routePath = path.split('?')[0]!,
	) => invoke(routePath, path, init);
	const mutation = (path: string, body: unknown, init: InvokeInit = {}) =>
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
	return { runtime, list, call, mutation };
}

const MUTATIONS = [
	['/api/exports/start', { list: MEMBERS_LIST }],
	['/api/exports/jobs/read-url', { id: 'job-1' }],
] as const;

const READS = ['/api/exports/jobs', '/api/exports/lists'] as const;

describe('the export endpoints', () => {
	it('starts a job and reads it back', async () => {
		const { runtime, list, call, mutation } = fixture(principal());
		try {
			list.rows.set(TENANT, members(3));
			const started = await mutation('/api/exports/start', {
				list: MEMBERS_LIST,
			});
			expect(started.status).toBe(201);
			const created = (await started.json()) as { job: ExportJobView };
			expect(created.job).toMatchObject({
				listId: MEMBERS_LIST,
				status: 'requested',
				downloadable: false,
			});
			/* The snapshot and the object never cross the wire. */
			expect(Object.keys(created.job)).not.toContain('requester');
			expect(Object.keys(created.job)).not.toContain('objectId');
			expect(Object.keys(created.job)).not.toContain('claimedAt');

			await runtime.tick();
			const read = await call(
				`/api/exports/jobs/${created.job.id}`,
				{ params: { id: created.job.id } },
				'/api/exports/jobs/:id',
			);
			expect(read.status).toBe(200);
			expect(((await read.json()) as { job: ExportJobView }).job).toMatchObject(
				{ status: 'completed', rowCount: 3, downloadable: true },
			);

			const listed = await call('/api/exports/jobs');
			expect(listed.status).toBe(200);
			const page = (await listed.json()) as {
				items: readonly ExportJobView[];
				page: { nextCursor: string | null; limit: number };
			};
			expect(page.items).toHaveLength(1);
			expect(page.page).toEqual({ nextCursor: null, limit: 50 });

			const url = await mutation('/api/exports/jobs/read-url', {
				id: created.job.id,
			});
			expect(url.status).toBe(200);
			expect(
				((await url.json()) as { url: string }).url.startsWith(
					'/api/storage/objects/',
				),
			).toBe(true);
		} finally {
			await runtime.dispose();
		}
	});

	it('answers the catalogue with the module that owns each list', async () => {
		const { runtime, call } = fixture(principal());
		try {
			const response = await call('/api/exports/lists');
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				lists: readonly Record<string, unknown>[];
			};
			expect(body.lists).toEqual([
				{
					id: MEMBERS_LIST,
					label: 'Members',
					moduleId: 'users.core',
					permitted: true,
				},
			]);
			/* The grant that decides an export is not part of what a screen reads. */
			expect(JSON.stringify(body)).not.toContain(LIST_PERMISSION);
		} finally {
			await runtime.dispose();
		}
	});

	/* A screen reads the catalogue on every visit; the answer is the sealed
	   registry and the caller's scopes, so it must not open a database lease or
	   run the migrations behind the repository. */
	it('answers the catalogue without resolving the repository', async () => {
		const untouched = () =>
			Promise.reject(new Error('The catalogue resolved the repository.'));
		const { runtime, call } = fixture(principal(), {
			lists: createExportListRegistry(),
			service: untouched,
			repository: untouched,
			tick: untouched,
			start: () => {},
			stop: () => {},
			quiesce: async () => {},
			dispose: async () => {},
		});
		try {
			const response = await call('/api/exports/lists');
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				lists: readonly { id: string }[];
			};
			expect(body.lists.map((entry) => entry.id)).toEqual([MEMBERS_LIST]);
		} finally {
			await runtime.dispose();
		}
	});

	it('marks a list the caller may not export as one they may not start', async () => {
		const { runtime, call } = fixture(
			principal([EXPORTS_PERMISSIONS.read, EXPORTS_PERMISSIONS.manage]),
		);
		try {
			const body = (await (await call('/api/exports/lists')).json()) as {
				lists: readonly { permitted: boolean }[];
			};
			expect(body.lists.map((entry) => entry.permitted)).toEqual([false]);
		} finally {
			await runtime.dispose();
		}
	});

	it('refuses a start for a list the caller may not read', async () => {
		const { runtime, mutation } = fixture(
			principal([EXPORTS_PERMISSIONS.read, EXPORTS_PERMISSIONS.manage]),
		);
		try {
			const response = await mutation('/api/exports/start', {
				list: MEMBERS_LIST,
			});
			expect(response.status).toBe(403);
			expect(
				((await response.json()) as { error: { code: string } }).error.code,
			).toBe('EXPORT_LIST_FORBIDDEN');
		} finally {
			await runtime.dispose();
		}
	});

	it('refuses a start for a list no module registered', async () => {
		const { runtime, mutation } = fixture(principal());
		try {
			const response = await mutation('/api/exports/start', {
				list: 'nobody.core.rows',
			});
			expect(response.status).toBe(404);
			expect(
				((await response.json()) as { error: { code: string } }).error.code,
			).toBe('EXPORT_LIST_UNKNOWN');
		} finally {
			await runtime.dispose();
		}
	});

	it('refuses a page limit outside the endpoint bound', async () => {
		const { runtime, call } = fixture(principal());
		try {
			const response = await call('/api/exports/jobs?limit=500');
			expect(response.status).toBe(400);
		} finally {
			await runtime.dispose();
		}
	});

	it('refuses a cursor this server did not sign', async () => {
		const { runtime, call } = fixture(principal());
		try {
			const response = await call('/api/exports/jobs?cursor=c1.abc.def');
			expect(response.status).toBe(400);
			expect(
				((await response.json()) as { error: { code: string } }).error.code,
			).toBe('CURSOR_INVALID');
		} finally {
			await runtime.dispose();
		}
	});
});

describe('EXPORTS-DENY', () => {
	it('answers 401 without a session', async () => {
		const { runtime, call } = fixture(null);
		try {
			for (const path of READS) {
				expect([path, (await call(path)).status]).toEqual([path, 401]);
			}
			for (const [path, body] of MUTATIONS) {
				const response = await call(path, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						origin: ORIGIN,
						'x-csrf-token': CSRF_TOKEN,
					},
					body: JSON.stringify(body),
				});
				expect([path, response.status]).toEqual([path, 401]);
			}
		} finally {
			await runtime.dispose();
		}
	});

	it('answers 403 without the read scope', async () => {
		const { runtime, call } = fixture(principal([EXPORTS_PERMISSIONS.manage]));
		try {
			for (const path of READS) {
				expect([path, (await call(path)).status]).toEqual([path, 403]);
			}
		} finally {
			await runtime.dispose();
		}
	});

	it('answers 403 without the manage scope', async () => {
		const { runtime, mutation } = fixture(
			principal([EXPORTS_PERMISSIONS.read]),
		);
		try {
			const response = await mutation('/api/exports/start', {
				list: MEMBERS_LIST,
			});
			expect(response.status).toBe(403);
		} finally {
			await runtime.dispose();
		}
	});

	it('refuses a read URL to a reader without the exported list permission', async () => {
		const { runtime, list, mutation } = fixture(principal());
		try {
			list.rows.set(TENANT, members(1));
			const started = await mutation('/api/exports/start', {
				list: MEMBERS_LIST,
			});
			const created = (await started.json()) as { job: ExportJobView };
			await runtime.tick();
			const reader = fixture(
				principal([EXPORTS_PERMISSIONS.read, EXPORTS_PERMISSIONS.manage]),
			);
			try {
				const response = await reader.mutation('/api/exports/jobs/read-url', {
					id: created.job.id,
				});
				expect(response.status).toBe(403);
				expect(
					((await response.json()) as { error: { code: string } }).error.code,
				).toBe('EXPORT_LIST_FORBIDDEN');
			} finally {
				await reader.runtime.dispose();
			}
		} finally {
			await runtime.dispose();
		}
	});

	it('refuses a mutation without a CSRF proof before it reads the body', async () => {
		const { runtime, call } = fixture(principal());
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
		const { runtime, mutation } = fixture(principal());
		try {
			for (const [path, body] of MUTATIONS) {
				const response = await mutation(path, body, {
					headers: { origin: 'https://attacker.example' },
				});
				expect([path, response.status]).toEqual([path, 403]);
			}
		} finally {
			await runtime.dispose();
		}
	});

	it('refuses a mutation whose body is not JSON', async () => {
		const { runtime, mutation } = fixture(principal());
		try {
			for (const [path, body] of MUTATIONS) {
				const response = await mutation(path, body, {
					headers: { 'content-type': 'text/plain' },
				});
				expect([path, response.status]).toEqual([path, 415]);
			}
		} finally {
			await runtime.dispose();
		}
	});
});
