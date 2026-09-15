import type { DatabaseProvider } from '@flowdular/sdk/database';
import type { AuthPrincipal } from '@flowdular/sdk/modules/auth';
import type { AuthRuntime } from '@flowdular/sdk/modules/auth/server';
import { AUTH_PRINCIPAL_STATE_KEY } from '@flowdular/sdk/modules/auth/server';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createCatalogRoutes } from '../src/api/endpoints.ts';
import { CATALOG_PERMISSIONS } from '../src/acl/permissions.ts';
import {
	createCatalogRuntime,
	type CatalogRuntime,
} from '../src/server/runtime.ts';
import {
	catalogTestProvider,
	closeCatalogTestDatabases,
} from './support/database.ts';

/* auth.core resolves the browser session in its middleware and publishes it in
   context state; sessionMutationDenial reads it from there. The key is not yet
   exported from @flowdular/sdk/modules/auth/server, so this double mirrors it. */
const AUTH_SESSION_STATE_KEY = 'flowdular.auth.session';

type CatalogRoute = ReturnType<typeof createCatalogRoutes>[number];
type CatalogRouteContext = Parameters<CatalogRoute['handler']>[0];

const runtimes = new Set<CatalogRuntime>();

afterEach(async () => {
	await Promise.all([...runtimes].map((runtime) => runtime.dispose()));
	runtimes.clear();
});

afterAll(closeCatalogTestDatabases);

function catalogRuntime(databases: DatabaseProvider): CatalogRuntime {
	const runtime = createCatalogRuntime({ databases, purpose: 'test' });
	runtimes.add(runtime);
	return runtime;
}

function principal(
	scopes: readonly string[],
	tenantId = 'tenant-a',
): AuthPrincipal {
	return {
		accountId: 'account-a',
		tenantId,
		email: 'owner@example.test',
		displayName: 'Owner',
		role: 'owner',
		scopes,
		tenants: [],
	};
}

function authRuntime(actor: AuthPrincipal): AuthRuntime {
	const session = {
		principal: actor,
		csrfToken: 'csrf-token',
		expiresAt: Date.now() + 60_000,
		sessionId: 'session-id',
		passwordChangeRequired: false,
	};
	return {
		cookie: { name: 'test-session', secure: false, maxAgeSeconds: 3_600 },
		authorizeAgentToolAccess: () => [],
		service: () => ({
			resolveSession: (token: string) => (token === 'token' ? session : null),
		}),
	} as unknown as AuthRuntime;
}

function context(request: Request, actor?: AuthPrincipal): CatalogRouteContext {
	const state = new Map<string, unknown>();
	if (actor) {
		state.set(AUTH_PRINCIPAL_STATE_KEY, actor);
		state.set(AUTH_SESSION_STATE_KEY, {
			principal: actor,
			csrfToken: 'csrf-token',
			expiresAt: Date.now() + 60_000,
			sessionId: 'session-id',
			passwordChangeRequired: false,
		});
	}
	return {
		request,
		url: new URL(request.url),
		state,
	} as unknown as CatalogRouteContext;
}

function mutation(path: string, body: unknown, csrf = 'csrf-token'): Request {
	return new Request(`https://erp.example${path}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			origin: 'https://erp.example',
			cookie: 'test-session=token',
			'x-csrf-token': csrf,
		},
		body: JSON.stringify(body),
	});
}

function route(
	routes: readonly CatalogRoute[],
	path: string,
	method: string,
): CatalogRoute {
	const result = routes.find(
		(entry) => entry.path === path && entry.methods.includes(method),
	);
	if (!result) throw new Error(`Missing ${method} ${path}.`);
	return result;
}

describe('catalog lifecycle and history endpoints', () => {
	it('returns 401 and 403 for every endpoint before access to tenant data', async () => {
		const routes = createCatalogRoutes(
			{ authorizeAgentToolAccess: () => [] } as unknown as AuthRuntime,
			catalogRuntime(await catalogTestProvider()),
		);
		for (const endpoint of routes) {
			const method = endpoint.methods.includes('GET') ? 'GET' : 'POST';
			const request = new Request(`https://erp.example${endpoint.path}`, {
				method,
				...(method === 'POST'
					? { headers: { 'content-type': 'application/json' }, body: '{}' }
					: {}),
			});
			const unauthenticated = await endpoint.handler(context(request));
			expect(unauthenticated.status, `${method} ${endpoint.path}`).toBe(401);
			const forbidden = await endpoint.handler(context(request, principal([])));
			expect(forbidden.status, `${method} ${endpoint.path}`).toBe(403);
		}
	});

	it('records the user actor for a protected lifecycle transition', async () => {
		const actor = principal([
			CATALOG_PERMISSIONS.read,
			CATALOG_PERMISSIONS.manage,
		]);
		const runtime = catalogRuntime(await catalogTestProvider());
		const routes = createCatalogRoutes(authRuntime(actor), runtime);
		const created = await route(routes, '/api/catalog/items', 'POST').handler(
			context(
				mutation('/api/catalog/items', {
					sku: 'A-1',
					name: 'Alpha',
					kind: 'product',
					unit: 'each',
					basePriceMinor: 100,
					currency: 'EUR',
				}),
				actor,
			),
		);
		const item = ((await created.json()) as { item: { id: string } }).item;
		const archived = await route(
			routes,
			'/api/catalog/items/archive',
			'POST',
		).handler(
			context(mutation('/api/catalog/items/archive', { id: item.id }), actor),
		);
		expect(archived.status).toBe(200);

		const history = await route(
			routes,
			'/api/catalog/items/history',
			'GET',
		).handler(
			context(
				new Request(
					`https://erp.example/api/catalog/items/history?recordId=${item.id}`,
				),
				actor,
			),
		);
		expect(history.status).toBe(200);
		expect(await history.json()).toMatchObject({
			entries: [
				{ action: 'archived', actor: { kind: 'user', id: 'account-a' } },
				{ action: 'created', actor: { kind: 'user', id: 'account-a' } },
			],
		});
	});

	it('updates, restores, and permanently deletes only an archived item in the active tenant', async () => {
		const actor = principal([
			CATALOG_PERMISSIONS.read,
			CATALOG_PERMISSIONS.manage,
		]);
		const runtime = catalogRuntime(await catalogTestProvider());
		const routes = createCatalogRoutes(authRuntime(actor), runtime);
		const created = await route(routes, '/api/catalog/items', 'POST').handler(
			context(
				mutation('/api/catalog/items', {
					sku: 'LIFECYCLE-1',
					name: 'Lifecycle item',
					kind: 'product',
					unit: 'each',
					basePriceMinor: 100,
					currency: 'EUR',
				}),
				actor,
			),
		);
		const item = ((await created.json()) as { item: { id: string } }).item;

		const updated = await route(
			routes,
			'/api/catalog/items/update',
			'POST',
		).handler(
			context(
				mutation('/api/catalog/items/update', {
					id: item.id,
					name: 'Lifecycle item revised',
					kind: 'service',
					unit: 'hour',
					basePriceMinor: 250,
					currency: 'PLN',
				}),
				actor,
			),
		);
		expect(updated.status).toBe(200);
		expect(await updated.json()).toMatchObject({
			item: { id: item.id, name: 'Lifecycle item revised', currency: 'PLN' },
		});

		const activeDelete = await route(
			routes,
			'/api/catalog/items/delete',
			'POST',
		).handler(
			context(mutation('/api/catalog/items/delete', { id: item.id }), actor),
		);
		expect(activeDelete.status).toBe(409);
		expect(await activeDelete.json()).toMatchObject({
			error: { code: 'CATALOG_ITEM_NOT_ARCHIVED' },
		});

		const foreignActor = principal(
			[CATALOG_PERMISSIONS.read, CATALOG_PERMISSIONS.manage],
			'tenant-b',
		);
		const foreignArchive = await route(
			createCatalogRoutes(authRuntime(foreignActor), runtime),
			'/api/catalog/items/archive',
			'POST',
		).handler(
			context(
				mutation('/api/catalog/items/archive', { id: item.id }),
				foreignActor,
			),
		);
		expect(foreignArchive.status).toBe(404);

		for (const action of ['archive', 'restore', 'archive'] as const) {
			const response = await route(
				routes,
				`/api/catalog/items/${action}`,
				'POST',
			).handler(
				context(
					mutation(`/api/catalog/items/${action}`, { id: item.id }),
					actor,
				),
			);
			expect(response.status, action).toBe(200);
		}

		const removed = await route(
			routes,
			'/api/catalog/items/delete',
			'POST',
		).handler(
			context(mutation('/api/catalog/items/delete', { id: item.id }), actor),
		);
		expect(removed.status).toBe(200);
		expect(await removed.json()).toEqual({ deleted: true });
		await expect(
			(await runtime.service()).get('tenant-a', item.id),
		).resolves.toBeNull();
	});

	it('rejects a lifecycle mutation without a valid CSRF token', async () => {
		const actor = principal([CATALOG_PERMISSIONS.manage]);
		const runtime = catalogRuntime(await catalogTestProvider());
		const item = await (
			await runtime.service()
		).create(
			'tenant-a',
			{
				sku: 'A-1',
				name: 'Alpha',
				kind: 'product',
				unit: 'each',
				basePriceMinor: 100,
				currency: 'EUR',
			},
			{ kind: 'user', id: 'account-a', label: 'Owner' },
		);
		const response = await route(
			createCatalogRoutes(authRuntime(actor), runtime),
			'/api/catalog/items/archive',
			'POST',
		).handler(
			context(
				mutation('/api/catalog/items/archive', { id: item.id }, 'bad'),
				actor,
			),
		);
		expect(response.status).toBe(403);
		expect(
			(await (await runtime.service()).get('tenant-a', item.id))?.status,
		).toBe('active');
	});

	it('rejects a bulk lifecycle mutation without a valid CSRF token', async () => {
		const actor = principal([CATALOG_PERMISSIONS.manage]);
		const runtime = catalogRuntime(await catalogTestProvider());
		const item = await (
			await runtime.service()
		).create('tenant-a', seedInput('A-1'), OWNER);
		const response = await route(
			createCatalogRoutes(authRuntime(actor), runtime),
			'/api/catalog/items/archive-many',
			'POST',
		).handler(
			context(
				mutation('/api/catalog/items/archive-many', { ids: [item.id] }, 'bad'),
				actor,
			),
		);
		expect(response.status).toBe(403);
		expect(
			(await (await runtime.service()).get('tenant-a', item.id))?.status,
		).toBe('active');
	});

	it('bounds the ids of a bulk lifecycle mutation', async () => {
		const actor = principal([CATALOG_PERMISSIONS.manage]);
		const routes = createCatalogRoutes(
			authRuntime(actor),
			catalogRuntime(await catalogTestProvider()),
		);
		for (const body of [
			{},
			{ ids: [] },
			{ ids: Array.from({ length: 101 }, (_, index) => `id-${index}`) },
			{ ids: ['same', 'same'] },
			{ ids: [''] },
			{ ids: ['x'.repeat(129)] },
		]) {
			for (const path of [
				'/api/catalog/items/archive-many',
				'/api/catalog/items/restore-many',
			]) {
				const response = await route(routes, path, 'POST').handler(
					context(mutation(path, body), actor),
				);
				expect(response.status, `${path} ${JSON.stringify(body)}`).toBe(400);
				expect(await response.json()).toMatchObject({
					error: { code: 'INVALID_INPUT' },
				});
			}
		}
	});

	it('answers one outcome per id and one history row per accepted transition', async () => {
		const actor = principal([
			CATALOG_PERMISSIONS.read,
			CATALOG_PERMISSIONS.manage,
		]);
		const runtime = catalogRuntime(await catalogTestProvider());
		const service = await runtime.service();
		const first = await service.create('tenant-a', seedInput('A-1'), OWNER);
		const second = await service.create('tenant-a', seedInput('A-2'), OWNER);
		const foreign = await service.create('tenant-b', seedInput('B-1'), OWNER);
		const routes = createCatalogRoutes(authRuntime(actor), runtime);

		const archived = await route(
			routes,
			'/api/catalog/items/archive-many',
			'POST',
		).handler(
			context(
				mutation('/api/catalog/items/archive-many', {
					ids: [first.id, 'missing', foreign.id, second.id],
				}),
				actor,
			),
		);
		expect(archived.status).toBe(200);
		expect(await archived.json()).toEqual({
			outcomes: [
				{ id: first.id, outcome: 'updated' },
				{ id: 'missing', outcome: 'not-found' },
				{ id: foreign.id, outcome: 'not-found' },
				{ id: second.id, outcome: 'updated' },
			],
		});
		expect((await service.get('tenant-b', foreign.id))?.status).toBe('active');

		const restored = await route(
			routes,
			'/api/catalog/items/restore-many',
			'POST',
		).handler(
			context(
				mutation('/api/catalog/items/restore-many', { ids: [first.id] }),
				actor,
			),
		);
		expect(await restored.json()).toEqual({
			outcomes: [{ id: first.id, outcome: 'updated' }],
		});

		for (const [id, actions] of [
			[first.id, ['restored', 'archived', 'created']],
			[second.id, ['archived', 'created']],
		] as const) {
			const history = await service.history('tenant-a', {
				recordId: id,
				limit: 10,
				cursor: null,
			});
			expect(history.entries.map((entry) => entry.action)).toEqual(actions);
			expect(history.entries[0]?.actor).toEqual({
				kind: 'user',
				id: 'account-a',
				label: 'Owner',
			});
		}
	});
});

function seedInput(sku: string) {
	return {
		sku,
		name: 'Item ' + sku,
		kind: 'product' as const,
		unit: 'each',
		basePriceMinor: 100,
		currency: 'EUR',
	};
}

const OWNER = { kind: 'user', id: 'account-a', label: 'Owner' } as const;

function listRequest(query: Record<string, string>): Request {
	return new Request(
		'https://erp.example/api/catalog/items?' +
			new URLSearchParams(query).toString(),
	);
}

/* Flips the first character of one dot-separated segment of a signed cursor. */
function tamper(cursor: string, segment: number): string {
	const parts = cursor.split('.');
	const target = parts[segment]!;
	const first = target[0] === 'A' ? 'B' : 'A';
	parts[segment] = first + target.slice(1);
	return parts.join('.');
}

interface ListBody {
	readonly items: readonly { readonly id: string; readonly sku: string }[];
	readonly page: { readonly nextCursor: string | null; readonly limit: number };
}

describe('catalog items list endpoint', () => {
	async function listing(count: number) {
		const actor = principal([CATALOG_PERMISSIONS.read]);
		const runtime = catalogRuntime(await catalogTestProvider());
		const service = await runtime.service();
		for (let index = 0; index < count; index += 1) {
			await service.create(
				'tenant-a',
				seedInput(`SKU-${String(index).padStart(3, '0')}`),
				OWNER,
			);
		}
		await service.create('tenant-b', seedInput('OTHER-1'), OWNER);
		const list = route(
			createCatalogRoutes(authRuntime(actor), runtime),
			'/api/catalog/items',
			'GET',
		);
		const read = async (
			query: Record<string, string>,
			as = actor,
		): Promise<{ status: number; body: ListBody }> => {
			const response = await list.handler(context(listRequest(query), as));
			return {
				status: response.status,
				body: (await response.json()) as ListBody,
			};
		};
		return { read, runtime };
	}

	it('answers consecutive pages without overlap or gap, a cursor only on a full page', async () => {
		const { read } = await listing(5);
		const first = await read({ limit: '2', sort: 'sku' });
		expect(first.status).toBe(200);
		expect(first.body.items.map((item) => item.sku)).toEqual([
			'SKU-000',
			'SKU-001',
		]);
		expect(first.body.page).toEqual({
			nextCursor: expect.any(String),
			limit: 2,
		});
		const second = await read({
			limit: '2',
			sort: 'sku',
			cursor: first.body.page.nextCursor!,
		});
		expect(second.body.items.map((item) => item.sku)).toEqual([
			'SKU-002',
			'SKU-003',
		]);
		const third = await read({
			limit: '2',
			sort: 'sku',
			cursor: second.body.page.nextCursor!,
		});
		expect(third.body.items.map((item) => item.sku)).toEqual(['SKU-004']);
		expect(third.body.page.nextCursor).toBeNull();

		const whole = await read({});
		expect(whole.body.items).toHaveLength(5);
		expect(whole.body.page).toEqual({ nextCursor: null, limit: 50 });
	});

	it('refuses a tampered, foreign, refiltered or re-sorted cursor and an unknown sort', async () => {
		const { read } = await listing(3);
		const query = { limit: '2', sort: 'name', direction: 'asc', q: 'sku' };
		const cursor = (await read(query)).body.page.nextCursor!;
		expect((await read({ ...query, cursor })).status).toBe(200);

		const refused = async (
			changes: Record<string, string>,
			as?: AuthPrincipal,
		) => {
			const result = await read({ ...query, ...changes }, as);
			expect(result.status, JSON.stringify(changes)).toBe(400);
			return (result.body as unknown as { error: { code: string } }).error.code;
		};
		for (const segment of [0, 1, 2]) {
			expect(await refused({ cursor: tamper(cursor, segment) })).toBe(
				'CURSOR_INVALID',
			);
		}
		expect(
			await refused(
				{ cursor },
				principal([CATALOG_PERMISSIONS.read], 'tenant-b'),
			),
		).toBe('CURSOR_INVALID');
		expect(await refused({ cursor, q: 'other' })).toBe('CURSOR_INVALID');
		expect(await refused({ cursor, kind: 'product' })).toBe('CURSOR_INVALID');
		expect(await refused({ cursor, sort: 'sku' })).toBe('CURSOR_INVALID');
		expect(await refused({ cursor, direction: 'desc' })).toBe('CURSOR_INVALID');
		expect(await refused({ cursor: 'not-a-cursor' })).toBe('CURSOR_INVALID');
		expect(await refused({ sort: 'price' })).toBe('INVALID_INPUT');
		expect(await refused({ direction: 'up' })).toBe('INVALID_INPUT');
		expect(await refused({ status: 'gone' })).toBe('INVALID_INPUT');
		expect(await refused({ limit: '201' })).toBe('INVALID_INPUT');
	});

	it('pushes the filters into the read and never crosses the tenant', async () => {
		const { read, runtime } = await listing(2);
		const service = await runtime.service();
		const [archived] = (await read({ sort: 'sku' })).body.items;
		await service.archive('tenant-a', archived!.id, OWNER);
		expect(
			(await read({ status: 'archived' })).body.items.map((item) => item.sku),
		).toEqual(['SKU-000']);
		expect(
			(await read({ status: 'active' })).body.items.map((item) => item.sku),
		).toEqual(['SKU-001']);
		expect((await read({ kind: 'service' })).body.items).toEqual([]);
		expect((await read({ q: 'other' })).body.items).toEqual([]);
	});
});
