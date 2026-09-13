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
import {
	developmentMailPort,
	publicResolver,
	TEST_SETTINGS,
} from './support/harness.ts';

const ORIGIN = 'https://erp.example';
const SESSION_TOKEN = 'session-token-0001';
/* A second workspace's owner, signed in beside the first on the same routes. */
const OTHER_TOKEN = 'session-token-0002';
/* Another member of the first workspace: the inbox is theirs alone. */
const MEMBER_TOKEN = 'session-token-0003';
const CSRF_TOKEN = 'csrf-token-0001';
const TENANT = 'tenant-http';
const OTHER_TENANT = 'tenant-other';
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
		mail: developmentMailPort(),
		members: async () => [],
		hostResolver: publicResolver({ 'hooks.example': '93.184.216.34' }),
	});
	const sessions = new Map<string, AuthPrincipal>();
	if (session) sessions.set(SESSION_TOKEN, session);
	sessions.set(OTHER_TOKEN, principal(ALL_SCOPES, 'account-eve', OTHER_TENANT));
	sessions.set(MEMBER_TOKEN, principal(ALL_SCOPES, 'account-bo', TENANT));
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
		init: RequestInit & {
			readonly authenticated?: boolean;
			readonly token?: string;
		} = {},
	) => {
		const {
			authenticated = true,
			token = SESSION_TOKEN,
			...requestInit
		} = init;
		const headers = new Headers(requestInit.headers);
		if (authenticated && (session || token !== SESSION_TOKEN)) {
			headers.set('cookie', `coreloom_session_dev=${token}`);
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
	[
		'/api/notifications/inbox/transition-many',
		NOTIFICATIONS_PERMISSIONS.manage,
	],
	['/api/notifications/preferences/save', NOTIFICATIONS_PERMISSIONS.manage],
	['/api/notifications/preferences/email', NOTIFICATIONS_PERMISSIONS.manage],
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
		expect(await inbox.json()).toEqual({
			items: [],
			page: { nextCursor: null, limit: 50 },
		});

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

	it('serves e-mail delivery off until the member turns it on', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		const read = async () =>
			(
				(await (await owner.call('/api/notifications/preferences')).json()) as {
					member: { emailDelivery: boolean };
				}
			).member.emailDelivery;

		expect(await read()).toBe(false);
		const saved = await owner.mutation('/api/notifications/preferences/email', {
			enabled: true,
		});
		expect(saved.status).toBe(200);
		expect(await read()).toBe(true);

		await owner.mutation('/api/notifications/preferences/email', {
			enabled: false,
		});
		expect(await read()).toBe(false);
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
		expect(await listed.json()).toEqual({
			items: [],
			page: { nextCursor: null, limit: 50 },
		});
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

interface Page<Item> {
	readonly items: readonly Item[];
	readonly page: { readonly nextCursor: string | null; readonly limit: number };
}

interface Problem {
	readonly error: { readonly code: string };
}

/* A cursor's body is base64url; changing one character of it breaks the
   signature rather than producing another valid page. */
function tampered(cursor: string): string {
	const [version, body, signature] = cursor.split('.') as [
		string,
		string,
		string,
	];
	const flipped = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
	return `${version}.${flipped}.${signature}`;
}

describe('notifications list pages', () => {
	async function seedInbox(
		owner: ReturnType<typeof fixture>,
		count: number,
		tenantId = TENANT,
		recipient = 'account-ada',
	) {
		const publisher = await owner.runtime.publisher();
		for (let index = 0; index < count; index += 1) {
			await publisher.publish({
				tenantId,
				kind: 'agent-run-failed',
				sourceModule: 'agents.core',
				/* Publication is idempotent on the source reference, so each member's
				   seed names its own. */
				sourceRef: `${recipient}-run-${String(index).padStart(2, '0')}`,
				title: `Run ${index} failed`,
				recipients: [recipient],
			});
		}
	}

	async function page<Item>(
		owner: ReturnType<typeof fixture>,
		path: string,
		token?: string,
	): Promise<Page<Item>> {
		const response = await owner.call(path, token ? { token } : {});
		expect([path, response.status]).toEqual([path, 200]);
		return (await response.json()) as Page<Item>;
	}

	async function refused(
		owner: ReturnType<typeof fixture>,
		path: string,
		code: string,
	) {
		const response = await owner.call(path);
		expect([path, response.status]).toEqual([path, 400]);
		expect([path, ((await response.json()) as Problem).error.code]).toEqual([
			path,
			code,
		]);
	}

	it('NOTIFICATIONS-INBOX-MANY refuses an unbounded, repeated or unknown bulk transition before any row changes', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		await seedInbox(owner, 2);
		const listed = await page<{ id: string }>(
			owner,
			'/api/notifications/inbox',
		);
		const [first, second] = listed.items.map((item) => item.id) as [
			string,
			string,
		];
		for (const body of [
			{ ids: [], transition: 'mark-read' },
			{ ids: 'x', transition: 'mark-read' },
			{
				ids: Array.from({ length: 101 }, (_, index) => `item-${index}`),
				transition: 'mark-read',
			},
			{ ids: [first, first], transition: 'mark-read' },
			{ ids: [first, second], transition: 'mark-unread' },
			{ ids: [first, 7], transition: 'archive' },
		]) {
			const response = await owner.mutation(
				'/api/notifications/inbox/transition-many',
				body,
			);
			expect([body, response.status]).toEqual([body, 400]);
			expect([body, ((await response.json()) as Problem).error.code]).toEqual([
				body,
				'INVALID_INPUT',
			]);
		}
		expect(
			(
				await page<{ status: string }>(
					owner,
					'/api/notifications/inbox?status=unread',
				)
			).items,
		).toHaveLength(2);
	});

	it('NOTIFICATIONS-INBOX-MANY answers one outcome per id and leaves the other member and the missing id alone', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		await seedInbox(owner, 3);
		await seedInbox(owner, 1, TENANT, 'account-bo');
		await seedInbox(owner, 1, OTHER_TENANT, 'account-eve');
		const own = (
			await page<{ id: string }>(owner, '/api/notifications/inbox')
		).items.map((item) => item.id);
		const other = (
			await page<{ id: string }>(
				owner,
				'/api/notifications/inbox',
				MEMBER_TOKEN,
			)
		).items[0]!.id;
		const foreign = (
			await page<{ id: string }>(owner, '/api/notifications/inbox', OTHER_TOKEN)
		).items[0]!.id;
		const unread = async (token?: string) =>
			(
				(await (
					await owner.call(
						'/api/notifications/inbox/unread-count',
						token ? { token } : {},
					)
				).json()) as { unread: number }
			).unread;
		expect([await unread(), await unread(MEMBER_TOKEN)]).toEqual([3, 1]);

		const read = await owner.mutation(
			'/api/notifications/inbox/transition-many',
			{
				ids: [own[0], 'missing', other, foreign, own[2]],
				transition: 'mark-read',
			},
		);
		expect(read.status).toBe(200);
		expect(await read.json()).toEqual({
			outcomes: [
				{ id: own[0], outcome: 'updated' },
				{ id: 'missing', outcome: 'not-found' },
				{ id: other, outcome: 'not-found' },
				{ id: foreign, outcome: 'not-found' },
				{ id: own[2], outcome: 'updated' },
			],
		});
		expect([
			await unread(),
			await unread(MEMBER_TOKEN),
			await unread(OTHER_TOKEN),
		]).toEqual([1, 1, 1]);
		expect(
			(
				await page<{ id: string; status: string }>(
					owner,
					'/api/notifications/inbox',
				)
			).items.map((item) => [item.id, item.status]),
		).toEqual([
			[own[0], 'read'],
			[own[1], 'unread'],
			[own[2], 'read'],
		]);

		const archived = await owner.mutation(
			'/api/notifications/inbox/transition-many',
			{ ids: [own[1], own[0]], transition: 'archive' },
		);
		expect(await archived.json()).toEqual({
			outcomes: [
				{ id: own[1], outcome: 'updated' },
				{ id: own[0], outcome: 'updated' },
			],
		});
		expect([await unread(), await unread(MEMBER_TOKEN)]).toEqual([0, 1]);
		expect(
			(await page<{ id: string }>(owner, '/api/notifications/inbox')).items.map(
				(item) => item.id,
			),
		).toEqual([own[2]]);
		expect(
			(
				await page<{ status: string }>(
					owner,
					'/api/notifications/inbox',
					MEMBER_TOKEN,
				)
			).items.map((item) => item.status),
		).toEqual(['unread']);
		expect(
			(
				await page<{ status: string }>(
					owner,
					'/api/notifications/inbox',
					OTHER_TOKEN,
				)
			).items.map((item) => item.status),
		).toEqual(['unread']);
	});

	it('NOTIFICATIONS-INBOX-MANY refuses either change on an archived item and leaves it archived', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		await seedInbox(owner, 2);
		const [kept, archived] = (
			await page<{ id: string }>(owner, '/api/notifications/inbox')
		).items.map((item) => item.id) as [string, string];
		expect(
			(
				await owner.mutation('/api/notifications/inbox/archive', {
					id: archived,
				})
			).status,
		).toBe(200);

		for (const transition of ['mark-read', 'archive']) {
			const response = await owner.mutation(
				'/api/notifications/inbox/transition-many',
				{ ids: [archived], transition },
			);
			expect([transition, response.status]).toEqual([transition, 200]);
			expect([transition, await response.json()]).toEqual([
				transition,
				{
					outcomes: [
						{
							id: archived,
							outcome: 'refused',
							reason: 'INBOX_TRANSITION_INVALID',
						},
					],
				},
			]);
		}
		expect(
			(
				await page<{ id: string; status: string; readAt: string | null }>(
					owner,
					'/api/notifications/inbox?status=archived',
				)
			).items.map((item) => [item.id, item.status, item.readAt]),
		).toEqual([[archived, 'archived', null]]);
		expect(
			(
				await page<{ id: string; status: string }>(
					owner,
					'/api/notifications/inbox',
				)
			).items.map((item) => [item.id, item.status]),
		).toEqual([[kept, 'unread']]);
	});

	it('walks the inbox through consecutive pages with no overlap and no gap', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		await seedInbox(owner, 5);
		const whole = await page<{ id: string }>(
			owner,
			'/api/notifications/inbox?limit=50',
		);
		expect(whole.items).toHaveLength(5);
		expect(whole.page.nextCursor).toBeNull();

		const walked: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const current: Page<{ id: string }> = await page(
				owner,
				'/api/notifications/inbox?limit=2' +
					(cursor === null ? '' : '&cursor=' + cursor),
			);
			pages += 1;
			walked.push(...current.items.map((item) => item.id));
			/* A full page carries a cursor; a short page is the last one. */
			expect(current.page.nextCursor === null).toBe(current.items.length < 2);
			cursor = current.page.nextCursor;
		} while (cursor !== null);
		expect(pages).toBe(3);
		expect(walked).toEqual(whole.items.map((item) => item.id));
	});

	it('hands a cursor back on a full page even when nothing follows it', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		await seedInbox(owner, 2);
		const full = await page<{ id: string }>(
			owner,
			'/api/notifications/inbox?limit=2',
		);
		expect(full.page.nextCursor).not.toBeNull();
		const beyond = await page<{ id: string }>(
			owner,
			'/api/notifications/inbox?limit=2&cursor=' + String(full.page.nextCursor),
		);
		expect(beyond).toEqual({ items: [], page: { nextCursor: null, limit: 2 } });
	});

	it('refuses a cursor it did not sign, one of another workspace and one edited by hand', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		await seedInbox(owner, 2);
		await seedInbox(owner, 2, OTHER_TENANT, 'account-eve');
		const own = await page<{ id: string }>(
			owner,
			'/api/notifications/inbox?limit=1',
		);
		const foreign = await page<{ id: string }>(
			owner,
			'/api/notifications/inbox?limit=1',
			OTHER_TOKEN,
		);
		const ownCursor = String(own.page.nextCursor);
		await refused(
			owner,
			'/api/notifications/inbox?limit=1&cursor=c1.abc.def',
			'CURSOR_INVALID',
		);
		await refused(
			owner,
			'/api/notifications/inbox?limit=1&cursor=' + tampered(ownCursor),
			'CURSOR_INVALID',
		);
		await refused(
			owner,
			'/api/notifications/inbox?limit=1&cursor=' +
				String(foreign.page.nextCursor),
			'CURSOR_INVALID',
		);
		/* The same cursor is still good for the list it was made for. */
		expect(
			(
				await page<{ id: string }>(
					owner,
					'/api/notifications/inbox?limit=1&cursor=' + ownCursor,
				)
			).items,
		).toHaveLength(1);
	});

	it('refuses an inbox cursor of another member of the same workspace', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		await seedInbox(owner, 2);
		await seedInbox(owner, 2, TENANT, 'account-bo');
		const member = await page<{ id: string }>(
			owner,
			'/api/notifications/inbox?limit=1',
			MEMBER_TOKEN,
		);
		const cursor = String(member.page.nextCursor);
		await refused(
			owner,
			'/api/notifications/inbox?limit=1&cursor=' + cursor,
			'CURSOR_INVALID',
		);
		expect(
			(
				await page<{ id: string }>(
					owner,
					'/api/notifications/inbox?limit=1&cursor=' + cursor,
					MEMBER_TOKEN,
				)
			).items,
		).toHaveLength(1);
	});

	it('matches a search term literally, LIKE syntax included', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		const seeded = ['100% ops', 'a_b', 'axb', 'back\\slash'];
		/* The URL is searched too, so it must not spell the term another way. */
		for (const [index, name] of seeded.entries()) {
			const created = await owner.mutation('/api/notifications/webhooks', {
				name,
				url: `https://hooks.example/receiver-${index}`,
				events: ['agent-run-failed'],
			});
			expect([name, created.status]).toEqual([name, 201]);
		}
		const names = async (term: string) =>
			(
				await page<{ name: string }>(
					owner,
					'/api/notifications/webhooks?q=' + encodeURIComponent(term),
				)
			).items.map((entry) => entry.name);
		expect(await names('%')).toEqual(['100% ops']);
		expect(await names('a_b')).toEqual(['a_b']);
		expect(await names('\\')).toEqual(['back\\slash']);
		expect(await names('_')).toEqual(['a_b']);
	});

	it('refuses a cursor once the filters, the sort or the direction change', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		await seedInbox(owner, 3);
		const first = await page<{ id: string }>(
			owner,
			'/api/notifications/inbox?limit=2',
		);
		const cursor = String(first.page.nextCursor);
		for (const change of [
			'status=unread',
			'kind=agent-run-failed',
			'direction=asc',
		]) {
			await refused(
				owner,
				`/api/notifications/inbox?limit=2&${change}&cursor=${cursor}`,
				'CURSOR_INVALID',
			);
		}
		/* Neither the page size nor the same sort spelled out changes the list. */
		expect(
			(
				await page<{ id: string }>(
					owner,
					`/api/notifications/inbox?limit=5&sort=createdAt&direction=desc&cursor=${cursor}`,
				)
			).items,
		).toHaveLength(1);
	});

	it('refuses an unknown sort key, direction or limit', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		for (const path of [
			'/api/notifications/inbox?sort=title',
			'/api/notifications/inbox?direction=sideways',
			'/api/notifications/inbox?limit=0',
			'/api/notifications/inbox?limit=201',
			'/api/notifications/webhooks?sort=url',
			'/api/notifications/deliveries?sort=createdAt',
		]) {
			await refused(owner, path, 'INVALID_INPUT');
		}
	});

	it('lists the open inbox by default and archived items only when asked', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		await seedInbox(owner, 3);
		const open = await page<{ id: string }>(owner, '/api/notifications/inbox');
		const archived = await owner.mutation('/api/notifications/inbox/archive', {
			id: open.items[1]!.id,
		});
		expect(archived.status).toBe(200);

		expect(
			(await page<{ id: string }>(owner, '/api/notifications/inbox')).items.map(
				(item) => item.id,
			),
		).toEqual([open.items[0]!.id, open.items[2]!.id]);
		expect(
			(
				await page<{ id: string }>(
					owner,
					'/api/notifications/inbox?status=archived',
				)
			).items.map((item) => item.id),
		).toEqual([open.items[1]!.id]);
		expect(
			(
				await page<{ id: string }>(
					owner,
					'/api/notifications/inbox?direction=asc',
				)
			).items.map((item) => item.id),
		).toEqual([open.items[2]!.id, open.items[0]!.id]);
	});

	it('pages subscriptions by normalized name with the filters applied by the server', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		for (const name of ['beta', 'Alpha', 'gamma', 'Delta']) {
			const created = await owner.mutation('/api/notifications/webhooks', {
				name,
				url: `https://hooks.example/${name.toLowerCase()}`,
				events: ['agent-run-failed'],
			});
			expect([name, created.status]).toEqual([name, 201]);
		}
		const names = (subscriptions: Page<{ name: string }>) =>
			subscriptions.items.map((entry) => entry.name);

		const first = await page<{ name: string }>(
			owner,
			'/api/notifications/webhooks?limit=3',
		);
		expect(names(first)).toEqual(['Alpha', 'beta', 'Delta']);
		const second = await page<{ name: string }>(
			owner,
			'/api/notifications/webhooks?limit=3&cursor=' +
				String(first.page.nextCursor),
		);
		expect(names(second)).toEqual(['gamma']);
		expect(second.page.nextCursor).toBeNull();

		expect(
			names(await page(owner, '/api/notifications/webhooks?direction=desc')),
		).toEqual(['gamma', 'Delta', 'beta', 'Alpha']);
		expect(
			names(await page(owner, '/api/notifications/webhooks?q=ELT')),
		).toEqual(['Delta']);
		expect(
			names(await page(owner, '/api/notifications/webhooks?q=hooks.example')),
		).toHaveLength(4);
		expect(
			names(await page(owner, '/api/notifications/webhooks?status=paused')),
		).toEqual([]);
		await refused(
			owner,
			'/api/notifications/webhooks?q=alpha&cursor=' +
				String(first.page.nextCursor),
			'CURSOR_INVALID',
		);
	});

	it('pages the ledger by schedule with the subscription and search filters applied by the server', async () => {
		const owner = fixture(principal(ALL_SCOPES));
		const created = await owner.mutation('/api/notifications/webhooks', {
			name: 'Ops receiver',
			url: 'https://hooks.example/receiver',
			events: ['agent-run-failed'],
		});
		const { subscription } = (await created.json()) as {
			subscription: { id: string };
		};
		await seedInbox(owner, 3);

		const whole = await page<{ id: string; sourceRef: string }>(
			owner,
			'/api/notifications/deliveries',
		);
		expect(whole.items).toHaveLength(3);
		const walked: string[] = [];
		let cursor: string | null = null;
		do {
			const current: Page<{ id: string }> = await page(
				owner,
				'/api/notifications/deliveries?limit=2' +
					(cursor === null ? '' : '&cursor=' + cursor),
			);
			walked.push(...current.items.map((item) => item.id));
			cursor = current.page.nextCursor;
		} while (cursor !== null);
		expect(walked).toEqual(whole.items.map((item) => item.id));

		expect(
			(
				await page<{ id: string }>(
					owner,
					`/api/notifications/deliveries?subscription=${subscription.id}&status=pending`,
				)
			).items,
		).toHaveLength(3);
		expect(
			(
				await page<{ sourceRef: string }>(
					owner,
					'/api/notifications/deliveries?q=run-01',
				)
			).items.map((item) => item.sourceRef),
		).toEqual(['account-ada-run-01']);
		expect(
			(
				await page<{ id: string }>(
					owner,
					'/api/notifications/deliveries?subscription=missing',
				)
			).items,
		).toEqual([]);
	});
});
