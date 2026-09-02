import type { AuthPrincipal } from '@coreloom/module-auth';
import type { AuthRuntime } from '@coreloom/module-auth/server';
import { AUTH_PRINCIPAL_STATE_KEY } from '@coreloom/module-auth/server';
import { describe, expect, it } from 'vitest';
import { createCatalogRoutes } from '../src/api/endpoints.ts';
import { CATALOG_PERMISSIONS } from '../src/acl/permissions.ts';
import { createCatalogRuntime } from '../src/server/runtime.ts';

type CatalogRoute = ReturnType<typeof createCatalogRoutes>[number];
type CatalogRouteContext = Parameters<CatalogRoute['handler']>[0];

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
	if (actor) state.set(AUTH_PRINCIPAL_STATE_KEY, actor);
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
			createCatalogRuntime({ databasePath: ':memory:' }),
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
		const runtime = createCatalogRuntime({ databasePath: ':memory:' });
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
		const runtime = createCatalogRuntime({ databasePath: ':memory:' });
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
		expect(runtime.service().get('tenant-a', item.id)).toBeNull();
	});

	it('rejects a lifecycle mutation without a valid CSRF token', async () => {
		const actor = principal([CATALOG_PERMISSIONS.manage]);
		const runtime = createCatalogRuntime({ databasePath: ':memory:' });
		const item = runtime.service().create(
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
		expect(runtime.service().get('tenant-a', item.id)?.status).toBe('active');
	});
});
