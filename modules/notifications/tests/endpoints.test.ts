import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthPrincipal } from '@flowdular/module-auth';
import {
	createAuthenticationMiddleware,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { NOTIFICATIONS_PERMISSIONS } from '../src/acl/permissions.ts';
import { createNotificationsRoutes } from '../src/api/endpoints.ts';
import { NOTIFICATION_KINDS } from '../src/domain/types.ts';
import { createNotificationsRuntime } from '../src/server/runtime.ts';
import { AesGcmSecretVault } from '../src/services/secret-vault.ts';
import {
	openNotificationsTestDatabase,
	type NotificationsTestDatabase,
} from './support/database.ts';
import { publicResolver, TEST_SETTINGS } from './support/harness.ts';

const ORIGIN = 'https://erp.example';
const SESSION_TOKEN = 'session-token-0001';
const CSRF_TOKEN = 'csrf-token-0001';
const TENANT = 'tenant-http';
const ALL_SCOPES = Object.values(NOTIFICATIONS_PERMISSIONS);

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

let shared: NotificationsTestDatabase;

beforeAll(async () => {
	shared = await openNotificationsTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

function fixture(session: AuthPrincipal | null) {
	const runtime = createNotificationsRuntime({
		databases: shared.databases,
		repository: shared.repository,
		secretVault: new AesGcmSecretVault(Buffer.alloc(32, 0x4e)),
		deliverySettings: () => TEST_SETTINGS,
		egressAllowlist: () => '',
		pollIntervalMs: () => 60_000,
		members: async () => [],
		hostResolver: publicResolver({ 'hooks.example': '93.184.216.34' }),
	});
	const sessions = new Map<string, AuthPrincipal>();
	if (session) sessions.set(SESSION_TOKEN, session);
	const auth = authRuntime(sessions);
	const routes = createNotificationsRoutes(auth, runtime);
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
		const context = {
			request,
			params: {},
			url: new URL(request.url),
			state: new Map<string, unknown>(),
		};
		await auth.middleware(context as never, async () => new Response(null));
		return route(path, requestInit.method ?? 'GET').handler(context as never);
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
	return { call, mutation, runtime };
}

const READ_PATHS = [
	['/api/notifications/inbox', NOTIFICATIONS_PERMISSIONS.read],
	['/api/notifications/inbox/unread-count', NOTIFICATIONS_PERMISSIONS.read],
	['/api/notifications/preferences', NOTIFICATIONS_PERMISSIONS.read],
	['/api/notifications/webhooks', NOTIFICATIONS_PERMISSIONS.webhooksRead],
	['/api/notifications/deliveries', NOTIFICATIONS_PERMISSIONS.deliveriesRead],
] as const;

const MUTATION_PATHS = [
	['/api/notifications/inbox/mark-read', NOTIFICATIONS_PERMISSIONS.manage],
	['/api/notifications/inbox/mark-unread', NOTIFICATIONS_PERMISSIONS.manage],
	['/api/notifications/inbox/archive', NOTIFICATIONS_PERMISSIONS.manage],
	['/api/notifications/preferences/save', NOTIFICATIONS_PERMISSIONS.manage],
	['/api/notifications/webhooks', NOTIFICATIONS_PERMISSIONS.webhooksManage],
	[
		'/api/notifications/webhooks/update',
		NOTIFICATIONS_PERMISSIONS.webhooksManage,
	],
	[
		'/api/notifications/webhooks/pause',
		NOTIFICATIONS_PERMISSIONS.webhooksManage,
	],
	[
		'/api/notifications/webhooks/resume',
		NOTIFICATIONS_PERMISSIONS.webhooksManage,
	],
	[
		'/api/notifications/webhooks/disable',
		NOTIFICATIONS_PERMISSIONS.webhooksManage,
	],
	[
		'/api/notifications/webhooks/rotate-secret',
		NOTIFICATIONS_PERMISSIONS.webhooksManage,
	],
	[
		'/api/notifications/webhooks/delete',
		NOTIFICATIONS_PERMISSIONS.webhooksManage,
	],
	[
		'/api/notifications/deliveries/replay',
		NOTIFICATIONS_PERMISSIONS.deliveriesRead,
	],
] as const;

describe('notifications HTTP boundary', () => {
	it('NOTIFICATIONS-DENY answers 401 on every route without an identity', async () => {
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
	});

	it('NOTIFICATIONS-DENY answers 403 without the permission the route declares', async () => {
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
	});

	it('NOTIFICATIONS-DENY refuses a mutation without a CSRF proof before the body is read', async () => {
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
				((await response.json()) as { error: { code: string } }).error.code,
			]).toEqual([path, 'CSRF_REJECTED']);
		}
	});

	it('NOTIFICATIONS-DENY refuses a mutation that is not same-origin', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		const response = await owner.mutation(
			'/api/notifications/webhooks/pause',
			{ id: 'x' },
			{ headers: { origin: 'https://evil.example' } },
		);
		expect(response.status).toBe(403);
	});

	it('refuses a mutation body that is not JSON or is out of bounds', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		const notJson = await owner.call('/api/notifications/inbox/mark-read', {
			method: 'POST',
			headers: {
				'content-type': 'text/plain',
				origin: ORIGIN,
				'x-csrf-token': CSRF_TOKEN,
			},
			body: 'id=1',
		});
		expect(notJson.status).toBe(415);

		const tooLong = await owner.mutation('/api/notifications/inbox/mark-read', {
			id: 'x'.repeat(129),
		});
		expect(tooLong.status).toBe(400);
	});

	it('serves the member their own inbox, unread count and preferences', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		const inbox = await owner.call('/api/notifications/inbox?status=unread');
		expect(inbox.status).toBe(200);
		expect(await inbox.json()).toEqual({ inbox: [] });

		const unread = await owner.call('/api/notifications/inbox/unread-count');
		expect(await unread.json()).toEqual({ unread: 0 });

		const saved = await owner.mutation('/api/notifications/preferences/save', {
			kind: 'agent-run-failed',
			enabled: false,
		});
		expect(saved.status).toBe(200);
		const preferences = await owner.call('/api/notifications/preferences');
		expect(
			(
				(await preferences.json()) as {
					preferences: readonly { kind: string; enabled: boolean }[];
				}
			).preferences,
		).toEqual([
			expect.objectContaining({ kind: 'agent-run-failed', enabled: false }),
		]);
	});

	it('offers both approval kinds in the preference list and saves one', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		const offered = (await (
			await owner.call('/api/notifications/preferences')
		).json()) as { kinds: readonly string[] };
		expect(offered.kinds).toEqual([...NOTIFICATION_KINDS]);
		expect(offered.kinds).toContain('approval-requested');
		expect(offered.kinds).toContain('approval-decided');

		const saved = await owner.mutation('/api/notifications/preferences/save', {
			kind: 'approval-decided',
			enabled: false,
		});
		expect(saved.status).toBe(200);
		expect(
			(
				(await (await owner.call('/api/notifications/preferences')).json()) as {
					preferences: readonly { kind: string; enabled: boolean }[];
				}
			).preferences,
		).toEqual([
			expect.objectContaining({ kind: 'approval-decided', enabled: false }),
		]);
	});

	it('rejects an unknown filter value instead of ignoring it', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		expect(
			(await owner.call('/api/notifications/inbox?status=nope')).status,
		).toBe(400);
		expect(
			(await owner.call('/api/notifications/deliveries?status=nope')).status,
		).toBe(400);
	});

	it('returns the webhook secret on creation and on rotation only', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		const created = await owner.mutation('/api/notifications/webhooks', {
			name: 'Ops receiver',
			url: 'https://hooks.example/receiver',
			events: ['agent-run-failed'],
		});
		expect(created.status).toBe(201);
		const body = (await created.json()) as {
			secret: string;
			subscription: { id: string; secretFingerprint: string };
		};
		expect(body.secret).toBeTypeOf('string');

		const listed = await owner.call('/api/notifications/webhooks');
		expect(JSON.stringify(await listed.json())).not.toContain(body.secret);

		const rotated = await owner.mutation(
			'/api/notifications/webhooks/rotate-secret',
			{ id: body.subscription.id },
		);
		const rotatedBody = (await rotated.json()) as { secret: string };
		expect(rotatedBody.secret).not.toBe(body.secret);

		const duplicate = await owner.mutation('/api/notifications/webhooks', {
			name: 'ops receiver',
			url: 'https://hooks.example/receiver',
			events: ['agent-run-failed'],
		});
		expect(duplicate.status).toBe(409);
		expect(
			((await duplicate.json()) as { error: { code: string } }).error.code,
		).toBe('SUBSCRIPTION_NAME_CONFLICT');
	});

	it('NOTIFICATIONS-DISABLE-DELETE deletes only after the subscription was disabled', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		const created = await owner.mutation('/api/notifications/webhooks', {
			name: 'Ops receiver',
			url: 'https://hooks.example/receiver',
			events: ['agent-run-failed'],
		});
		const { subscription } = (await created.json()) as {
			subscription: { id: string };
		};

		const refused = await owner.mutation('/api/notifications/webhooks/delete', {
			id: subscription.id,
		});
		expect(refused.status).toBe(409);
		expect(
			((await refused.json()) as { error: { code: string } }).error.code,
		).toBe('SUBSCRIPTION_NOT_DISABLED');

		const disabled = await owner.mutation(
			'/api/notifications/webhooks/disable',
			{ id: subscription.id },
		);
		expect(disabled.status).toBe(200);
		expect(
			((await disabled.json()) as { subscription: { status: string } })
				.subscription.status,
		).toBe('disabled');

		const deleted = await owner.mutation('/api/notifications/webhooks/delete', {
			id: subscription.id,
		});
		expect(deleted.status).toBe(200);
		const listed = await owner.call('/api/notifications/webhooks');
		expect(await listed.json()).toEqual({ subscriptions: [] });
	});

	it('refuses a blocked webhook URL with a stable code', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		const blocked = await owner.mutation('/api/notifications/webhooks', {
			name: 'Loopback',
			url: 'http://127.0.0.1/receiver',
			events: ['agent-run-failed'],
		});
		expect(blocked.status).toBe(400);
		expect(
			((await blocked.json()) as { error: { code: string } }).error.code,
		).toBe('WEBHOOK_URL_BLOCKED');
	});

	it('NOTIFICATIONS-REPLAY refuses a caller without the deliveries permission', async () => {
		const member = fixture(
			principal([
				NOTIFICATIONS_PERMISSIONS.read,
				NOTIFICATIONS_PERMISSIONS.manage,
				NOTIFICATIONS_PERMISSIONS.webhooksRead,
			]),
		);
		const response = await member.mutation(
			'/api/notifications/deliveries/replay',
			{ id: 'any' },
		);
		expect(response.status).toBe(403);
	});
});
