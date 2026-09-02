import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
	AUTH_PRINCIPAL_STATE_KEY,
	type AuthRuntime,
} from '@coreloom/module-auth/server';
import { describe, expect, it } from 'vitest';
import { PARTY_PERMISSIONS } from '../src/acl/permissions.ts';
import { createPartyRoutes } from '../src/api/endpoints.ts';
import { filterParties } from '../src/client/party-list.ts';
import { moduleDefinition } from '../src/index.ts';
import { createPartiesRuntime } from '../src/server/runtime.ts';
import { PARTIES_MIGRATION_001 } from '../src/services/migration.ts';
import {
	PartiesService,
	PartyServiceError,
} from '../src/services/parties-service.ts';
import { SqlitePartyRepository } from '../src/services/sqlite-repository.ts';

const ORIGIN = 'https://erp.example';
const CSRF_TOKEN = 'parties-test-csrf';
const TEST_ACTOR = { kind: 'user', id: 'account-1', label: 'Owner' } as const;

function testContext(request: Request) {
	return {
		request,
		params: {},
		url: new URL(request.url),
		state: new Map<string, unknown>(),
	};
}

function principal(scopes: readonly string[], tenantId = 'tenant-a') {
	return {
		accountId: 'account-1',
		tenantId,
		email: 'owner@example.com',
		displayName: 'Owner',
		role: 'owner',
		scopes,
		tenants: [
			{
				tenantId,
				name: 'Tenant',
				slug: 'tenant',
				role: 'owner',
			},
		],
	};
}

function authenticatedContext(
	path: string,
	body: Readonly<Record<string, unknown>>,
	tenantId = 'tenant-a',
) {
	const context = testContext(
		new Request(`${ORIGIN}${path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				cookie: 'parties_test_session=session-token',
				origin: ORIGIN,
				'x-csrf-token': CSRF_TOKEN,
			},
			body: JSON.stringify(body),
		}),
	);
	context.state.set(
		AUTH_PRINCIPAL_STATE_KEY,
		principal([PARTY_PERMISSIONS.manage], tenantId),
	);
	return context;
}

function testAuthRuntime(): AuthRuntime {
	return {
		cookie: { name: 'parties_test_session' },
		authorizeAgentToolAccess: () => [],
		service: () => ({
			resolveSession: () => ({ csrfToken: CSRF_TOKEN }),
		}),
	} as unknown as AuthRuntime;
}

function serviceError(action: () => unknown): PartyServiceError {
	try {
		action();
	} catch (error) {
		if (error instanceof PartyServiceError) return error;
		throw error;
	}
	throw new Error('Expected a PartyServiceError.');
}

describe('parties.core', () => {
	it('exports its validated identity', () => {
		expect(moduleDefinition.manifest.id).toBe('parties.core');
	});

	it('isolates party lists by trusted tenant id', () => {
		const service = new PartiesService(new SqlitePartyRepository(':memory:'));
		service.create('tenant-a', { name: 'Acme', kind: 'customer' }, TEST_ACTOR);
		service.create('tenant-b', { name: 'Beta', kind: 'supplier' }, TEST_ACTOR);

		expect(service.list('tenant-a').map((party) => party.name)).toEqual([
			'Acme',
		]);
		expect(service.list('tenant-b').map((party) => party.name)).toEqual([
			'Beta',
		]);
	});

	it('preserves legacy rows while applying the VAT column once', () => {
		const directory = mkdtempSync(join(tmpdir(), 'parties-vat-'));
		const databasePath = join(directory, 'parties.db');
		try {
			const database = new DatabaseSync(databasePath);
			database.exec(PARTIES_MIGRATION_001);
			database
				.prepare(
					`INSERT INTO parties
					 (id, tenant_id, name, kind, email, phone, status, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					'legacy-party',
					'tenant-a',
					'Legacy party',
					'customer',
					null,
					null,
					'active',
					1,
				);
			database.close();

			const repository = new SqlitePartyRepository(databasePath);
			expect(repository.list('tenant-a')).toMatchObject([
				{ id: 'legacy-party', vatId: null },
			]);
			expect(() => new SqlitePartyRepository(databasePath)).not.toThrow();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('stores optional VAT identifiers on create and update', () => {
		const service = new PartiesService(new SqlitePartyRepository(':memory:'));
		const created = service.create(
			'tenant-a',
			{
				name: 'Acme',
				kind: 'customer',
				vatId: '  PL123ABC456  ',
			},
			TEST_ACTOR,
		);
		expect(created.vatId).toBe('PL123ABC456');

		const updated = service.update(
			'tenant-a',
			{
				id: created.id,
				name: 'Acme updated',
				kind: 'both',
				email: 'SALES@EXAMPLE.COM',
				phone: '123456789',
				vatId: '',
			},
			TEST_ACTOR,
		);
		expect(updated).toMatchObject({
			id: created.id,
			name: 'Acme updated',
			kind: 'both',
			email: 'sales@example.com',
			phone: '123456789',
			vatId: null,
			status: 'active',
			createdAt: created.createdAt,
		});
		expect(service.list('tenant-a')).toEqual([updated]);
	});

	it('filters parties by text and VAT identifier presence', () => {
		const service = new PartiesService(new SqlitePartyRepository(':memory:'));
		service.create(
			'tenant-a',
			{
				name: 'Acme',
				kind: 'customer',
				email: 'billing@acme.example',
				vatId: 'PL123ABC',
			},
			TEST_ACTOR,
		);
		service.create(
			'tenant-a',
			{
				name: 'Beta',
				kind: 'supplier',
				email: 'contact@beta.example',
			},
			TEST_ACTOR,
		);
		service.create(
			'tenant-a',
			{
				name: 'Shared',
				kind: 'both',
			},
			TEST_ACTOR,
		);
		const parties = service.list('tenant-a');

		expect(
			filterParties(parties, 'beta', false).map((party) => party.name),
		).toEqual(['Beta']);
		expect(
			filterParties(parties, 'billing', false).map((party) => party.name),
		).toEqual(['Acme']);
		expect(
			filterParties(parties, 'pl123', false).map((party) => party.name),
		).toEqual(['Acme']);
		expect(filterParties(parties, '', true).map((party) => party.name)).toEqual(
			['Acme'],
		);
		expect(filterParties(parties, 'beta', true)).toEqual([]);
		expect(
			filterParties(parties, '', false, 'customer').map((party) => party.name),
		).toEqual(['Acme', 'Shared']);
		expect(
			filterParties(parties, '', false, 'supplier').map((party) => party.name),
		).toEqual(['Beta', 'Shared']);
	});

	it.each(['PL-123', 'A'.repeat(21)])(
		'rejects invalid VAT identifier %s with a stable code',
		(vatId) => {
			const service = new PartiesService(new SqlitePartyRepository(':memory:'));
			const error = serviceError(() =>
				service.create(
					'tenant-a',
					{
						name: 'Acme',
						kind: 'customer',
						vatId,
					},
					TEST_ACTOR,
				),
			);
			expect(error).toMatchObject({ code: 'INVALID_VAT_ID', status: 400 });
		},
	);

	it('does not update a party through another tenant', () => {
		const service = new PartiesService(new SqlitePartyRepository(':memory:'));
		const party = service.create(
			'tenant-b',
			{
				name: 'Beta',
				kind: 'supplier',
				vatId: 'GB123',
			},
			TEST_ACTOR,
		);
		const error = serviceError(() =>
			service.update(
				'tenant-a',
				{
					id: party.id,
					name: 'Changed',
					kind: 'both',
					vatId: 'PL999',
				},
				TEST_ACTOR,
			),
		);
		expect(error).toMatchObject({ code: 'PARTY_NOT_FOUND', status: 404 });
		expect(service.list('tenant-b')).toMatchObject([
			{ id: party.id, name: 'Beta', vatId: 'GB123' },
		]);
	});

	it('archives, restores, and permanently deletes only archived records', () => {
		const service = new PartiesService(new SqlitePartyRepository(':memory:'));
		const party = service.create(
			'tenant-a',
			{ name: 'Acme', kind: 'customer' },
			TEST_ACTOR,
		);

		const activeDelete = serviceError(() =>
			service.delete('tenant-a', party.id, TEST_ACTOR),
		);
		expect(activeDelete).toMatchObject({
			code: 'PARTY_NOT_ARCHIVED',
			status: 409,
		});

		expect(service.archive('tenant-a', party.id, TEST_ACTOR).status).toBe(
			'archived',
		);
		expect(service.restore('tenant-a', party.id, TEST_ACTOR).status).toBe(
			'active',
		);
		service.archive('tenant-a', party.id, TEST_ACTOR);
		service.delete('tenant-a', party.id, TEST_ACTOR);

		expect(service.list('tenant-a')).toEqual([]);
		expect(
			service
				.history('tenant-a', {
					recordId: party.id,
					limit: 20,
					cursor: null,
				})
				.entries.map((entry) => entry.action),
		).toEqual(['deleted', 'archived', 'restored', 'archived', 'created']);
	});

	it('keeps lifecycle mutations and history isolated by tenant and actor', () => {
		const service = new PartiesService(new SqlitePartyRepository(':memory:'));
		const party = service.create(
			'tenant-b',
			{ name: 'Beta', kind: 'supplier' },
			TEST_ACTOR,
		);
		const agent = {
			kind: 'agent',
			id: 'agent-1',
			label: 'Supplier curator',
			runId: 'run-1',
		} as const;

		const error = serviceError(() =>
			service.archive('tenant-a', party.id, agent),
		);
		expect(error).toMatchObject({ code: 'PARTY_NOT_FOUND', status: 404 });
		expect(service.list('tenant-b')[0]?.status).toBe('active');

		service.archive('tenant-b', party.id, agent);
		expect(
			service.history('tenant-a', {
				recordId: party.id,
				limit: 20,
				cursor: null,
			}).entries,
		).toEqual([]);
		expect(
			service.history('tenant-b', {
				recordId: party.id,
				limit: 20,
				cursor: null,
			}).entries[0]?.actor,
		).toEqual(agent);
	});

	it('returns VAT identifiers from create and update endpoints', async () => {
		const runtime = createPartiesRuntime({ databasePath: ':memory:' });
		const routes = createPartyRoutes(testAuthRuntime(), runtime);
		const create = routes.find(
			(route) =>
				route.path === '/api/parties' && route.methods.includes('POST'),
		)!;
		const createdResponse = await create.handler(
			authenticatedContext('/api/parties', {
				name: 'Acme',
				kind: 'customer',
				vatId: 'PL123',
			}),
		);
		expect(createdResponse.status).toBe(201);
		const createdBody = (await createdResponse.json()) as {
			party: { id: string; vatId: string | null };
		};
		expect(createdBody.party.vatId).toBe('PL123');

		const update = routes.find(
			(route) =>
				route.path === '/api/parties/update' && route.methods.includes('POST'),
		)!;
		const updatedResponse = await update.handler(
			authenticatedContext('/api/parties/update', {
				id: createdBody.party.id,
				name: 'Acme',
				kind: 'both',
				vatId: 'PL456',
			}),
		);
		expect(updatedResponse.status).toBe(200);
		expect(await updatedResponse.json()).toMatchObject({
			party: { id: createdBody.party.id, vatId: 'PL456' },
		});
	});

	it('rejects invalid VAT characters at the HTTP boundary', async () => {
		const runtime = createPartiesRuntime({ databasePath: ':memory:' });
		const routes = createPartyRoutes(testAuthRuntime(), runtime);
		const create = routes.find(
			(route) =>
				route.path === '/api/parties' && route.methods.includes('POST'),
		)!;
		const response = await create.handler(
			authenticatedContext('/api/parties', {
				name: 'Acme',
				kind: 'customer',
				vatId: 'PL-123',
			}),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: 'INVALID_VAT_ID' },
		});
	});

	it('applies the full lifecycle through tenant-scoped guarded endpoints', async () => {
		const runtime = createPartiesRuntime({ databasePath: ':memory:' });
		const routes = createPartyRoutes(testAuthRuntime(), runtime);
		const create = routes.find(
			(route) =>
				route.path === '/api/parties' && route.methods.includes('POST'),
		)!;
		const created = await create.handler(
			authenticatedContext('/api/parties', {
				name: 'Lifecycle party',
				kind: 'both',
			}),
		);
		const party = ((await created.json()) as { party: { id: string } }).party;

		const endpoint = (path: string) =>
			routes.find(
				(route) => route.path === path && route.methods.includes('POST'),
			)!;
		const foreignArchive = await endpoint('/api/parties/archive').handler(
			authenticatedContext(
				'/api/parties/archive',
				{ id: party.id },
				'tenant-b',
			),
		);
		expect(foreignArchive.status).toBe(404);

		const activeDelete = await endpoint('/api/parties/delete').handler(
			authenticatedContext('/api/parties/delete', { id: party.id }),
		);
		expect(activeDelete.status).toBe(409);
		expect(await activeDelete.json()).toMatchObject({
			error: { code: 'PARTY_NOT_ARCHIVED' },
		});

		for (const action of ['archive', 'restore', 'archive'] as const) {
			const response = await endpoint(`/api/parties/${action}`).handler(
				authenticatedContext(`/api/parties/${action}`, { id: party.id }),
			);
			expect(response.status, action).toBe(200);
		}
		const removed = await endpoint('/api/parties/delete').handler(
			authenticatedContext('/api/parties/delete', { id: party.id }),
		);
		expect(removed.status).toBe(200);
		expect(await removed.json()).toEqual({ deleted: true });
		expect(runtime.service().get('tenant-a', party.id)).toBeNull();
		expect(
			runtime
				.service()
				.history('tenant-a', {
					recordId: party.id,
					limit: 20,
					cursor: null,
				})
				.entries.map((entry) => entry.action),
		).toEqual(['deleted', 'archived', 'restored', 'archived', 'created']);
	});

	it.each([
		['list', '/api/parties', 'GET'],
		['create', '/api/parties', 'POST'],
		['update', '/api/parties/update', 'POST'],
		['archive', '/api/parties/archive', 'POST'],
		['restore', '/api/parties/restore', 'POST'],
		['delete', '/api/parties/delete', 'POST'],
		['history', '/api/parties/history', 'GET'],
	] as const)(
		'denies unauthenticated %s requests',
		async (_name, path, method) => {
			const routes = createPartyRoutes(
				{ authorizeAgentToolAccess: () => [] } as unknown as AuthRuntime,
				createPartiesRuntime({ databasePath: ':memory:' }),
			);
			const route = routes.find(
				(candidate) =>
					candidate.path === path && candidate.methods.includes(method),
			)!;
			const response = await route.handler(
				testContext(new Request(`${ORIGIN}${path}`, { method })),
			);
			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({
				error: { code: 'UNAUTHENTICATED' },
			});
		},
	);

	it.each([
		['list', '/api/parties', 'GET'],
		['create', '/api/parties', 'POST'],
		['update', '/api/parties/update', 'POST'],
		['archive', '/api/parties/archive', 'POST'],
		['restore', '/api/parties/restore', 'POST'],
		['delete', '/api/parties/delete', 'POST'],
		['history', '/api/parties/history', 'GET'],
	] as const)(
		'denies unauthorized %s requests',
		async (_name, path, method) => {
			const routes = createPartyRoutes(
				{ authorizeAgentToolAccess: () => [] } as unknown as AuthRuntime,
				createPartiesRuntime({ databasePath: ':memory:' }),
			);
			const route = routes.find(
				(candidate) =>
					candidate.path === path && candidate.methods.includes(method),
			)!;
			const context = testContext(new Request(`${ORIGIN}${path}`, { method }));
			context.state.set(AUTH_PRINCIPAL_STATE_KEY, principal([]));
			const response = await route.handler(context);
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				error: { code: 'FORBIDDEN' },
			});
		},
	);

	it.each([
		['archive', '/api/parties/archive'],
		['restore', '/api/parties/restore'],
		['delete', '/api/parties/delete'],
	] as const)('requires CSRF protection for %s', async (_name, path) => {
		const routes = createPartyRoutes(
			testAuthRuntime(),
			createPartiesRuntime({ databasePath: ':memory:' }),
		);
		const route = routes.find(
			(candidate) =>
				candidate.path === path && candidate.methods.includes('POST'),
		)!;
		const context = testContext(
			new Request(`${ORIGIN}${path}`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					cookie: 'parties_test_session=session-token',
					origin: ORIGIN,
				},
				body: JSON.stringify({ id: 'party-1' }),
			}),
		);
		context.state.set(
			AUTH_PRINCIPAL_STATE_KEY,
			principal([PARTY_PERMISSIONS.manage]),
		);
		const response = await route.handler(context);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: { code: 'CSRF_REJECTED' },
		});
	});
});
