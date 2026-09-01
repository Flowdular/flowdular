import type { AuthPrincipal } from '@coreloom/module-auth';
import type { AuthRuntime } from '@coreloom/module-auth/server';
import { AUTH_PRINCIPAL_STATE_KEY } from '@coreloom/module-auth/server';
import { describe, expect, it } from 'vitest';
import { EXPENSES_PERMISSIONS } from '../src/acl/permissions.ts';
import type { CreateExpensesClaimInput } from '../src/domain/types.ts';
import { moduleDefinition } from '../src/index.ts';
import { createExpensesRoutes } from '../src/api/endpoints.ts';
import {
	ExpensesService,
	ExpensesServiceError,
} from '../src/services/expenses-service.ts';
import { SqliteExpensesRepository } from '../src/services/sqlite-repository.ts';
import { createExpensesRuntime } from '../src/server/runtime.ts';

type ExpenseRoute = ReturnType<typeof createExpensesRoutes>[number];
type ExpenseRouteContext = Parameters<ExpenseRoute['handler']>[0];

const input = (
	overrides: Partial<CreateExpensesClaimInput> = {},
): CreateExpensesClaimInput => ({
	title: 'Train to customer site',
	amountMinor: 12_500,
	currency: 'eur',
	category: 'travel',
	expenseDate: '2026-08-20',
	note: 'Return ticket',
	...overrides,
});

function service() {
	return new ExpensesService(new SqliteExpensesRepository(':memory:'));
}

function errorFrom(action: () => unknown): ExpensesServiceError {
	try {
		action();
	} catch (error) {
		expect(error).toBeInstanceOf(ExpensesServiceError);
		return error as ExpensesServiceError;
	}
	throw new Error('Expected an ExpensesServiceError.');
}

function principal(scopes: readonly string[]): AuthPrincipal {
	return {
		accountId: 'account-a',
		tenantId: 'tenant-a',
		email: 'employee@example.test',
		displayName: 'Employee',
		role: 'member',
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
		service: () => ({
			resolveSession: (token: string) => (token === 'token' ? session : null),
		}),
	} as unknown as AuthRuntime;
}

function context(request: Request, actor?: AuthPrincipal) {
	const state = new Map<string, unknown>();
	if (actor) state.set(AUTH_PRINCIPAL_STATE_KEY, actor);
	return {
		request,
		url: new URL(request.url),
		state,
	} as unknown as ExpenseRouteContext;
}

function mutationRequest(path: string, body: unknown, csrf = 'csrf-token') {
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
	routes: readonly ExpenseRoute[],
	path: string,
	method: string,
): ExpenseRoute {
	const found = routes.find(
		(entry) => entry.path === path && entry.methods.includes(method),
	);
	if (!found) throw new Error(`Missing ${method} ${path}.`);
	return found;
}

describe('expenses.core service', () => {
	it('exports its validated identity and permissions', () => {
		expect(moduleDefinition.manifest.id).toBe('expenses.core');
		expect(moduleDefinition.permissions).toEqual([
			'expenses.claims.read',
			'expenses.claims.manage',
			'expenses.claims.approve',
		]);
	});

	it('creates tenant-owned drafts with unique server identities', () => {
		const expenses = service();
		const first = expenses.create('tenant-a', 'account-a', input());
		const second = expenses.create('tenant-a', 'account-a', input());

		expect(first).toMatchObject({
			tenantId: 'tenant-a',
			claimantId: 'account-a',
			title: 'Train to customer site',
			amountMinor: 12_500,
			currency: 'EUR',
			category: 'travel',
			expenseDate: '2026-08-20',
			note: 'Return ticket',
			status: 'draft',
			decisionComment: null,
		});
		expect(first.id).not.toBe(second.id);
	});

	it('isolates employee lists and direct actions by tenant', () => {
		const expenses = service();
		const foreign = expenses.create('tenant-b', 'account-b', input());

		expect(expenses.list('tenant-a', 'account-a', null, false)).toEqual([]);
		expect(
			errorFrom(() => expenses.submit('tenant-a', 'account-b', foreign.id))
				.code,
		).toBe('CLAIM_NOT_FOUND');
	});

	it('filters employee claims by status and orders newest expense first', () => {
		const expenses = service();
		const older = expenses.create(
			'tenant-a',
			'account-a',
			input({ title: 'Older', expenseDate: '2026-08-01' }),
		);
		expenses.create(
			'tenant-a',
			'account-b',
			input({ title: 'Another employee', expenseDate: '2026-08-31' }),
		);
		const newer = expenses.create(
			'tenant-a',
			'account-a',
			input({ title: 'Newer', expenseDate: '2026-08-20' }),
		);
		expenses.submit('tenant-a', 'account-a', older.id);

		expect(
			expenses
				.list('tenant-a', 'account-a', null, false)
				.map((claim) => claim.title),
		).toEqual(['Newer', 'Older']);
		expect(
			expenses
				.list('tenant-a', 'account-a', 'draft', false)
				.map((claim) => claim.id),
		).toEqual([newer.id]);
	});

	it('shows approvers every submitted claim and counts only the active tenant', () => {
		const expenses = service();
		const first = expenses.create('tenant-a', 'account-a', input());
		const second = expenses.create('tenant-a', 'account-b', input());
		const foreign = expenses.create('tenant-b', 'account-c', input());
		expenses.submit('tenant-a', 'account-a', first.id);
		expenses.submit('tenant-a', 'account-b', second.id);
		expenses.submit('tenant-b', 'account-c', foreign.id);

		expect(
			expenses.list('tenant-a', 'manager', 'submitted', true),
		).toHaveLength(2);
		expect(expenses.countAwaitingApproval('tenant-a')).toBe(2);
	});

	it('allows only the claimant to update and submit a draft', () => {
		const expenses = service();
		const claim = expenses.create('tenant-a', 'account-a', input());

		expect(
			errorFrom(() =>
				expenses.update(
					'tenant-a',
					'account-b',
					claim.id,
					input({ title: 'Changed' }),
				),
			).code,
		).toBe('CLAIM_NOT_OWNED');

		const changed = expenses.update(
			'tenant-a',
			'account-a',
			claim.id,
			input({ title: 'Changed', note: null }),
		);
		expect(changed).toMatchObject({ title: 'Changed', note: null });
		expect(expenses.submit('tenant-a', 'account-a', claim.id).status).toBe(
			'submitted',
		);
		expect(
			errorFrom(() =>
				expenses.update('tenant-a', 'account-a', claim.id, input()),
			).code,
		).toBe('CLAIM_NOT_DRAFT');
	});

	it('approves or rejects submitted claims with a required comment', () => {
		const expenses = service();
		const approved = expenses.create('tenant-a', 'account-a', input());
		const rejected = expenses.create('tenant-a', 'account-b', input());
		expenses.submit('tenant-a', 'account-a', approved.id);
		expenses.submit('tenant-a', 'account-b', rejected.id);

		expect(
			expenses.decide('tenant-a', approved.id, 'approved', 'Within policy'),
		).toMatchObject({
			status: 'approved',
			decisionComment: 'Within policy',
		});
		expect(
			expenses.decide('tenant-a', rejected.id, 'rejected', 'Receipt missing'),
		).toMatchObject({
			status: 'rejected',
			decisionComment: 'Receipt missing',
		});
		expect(expenses.countAwaitingApproval('tenant-a')).toBe(0);
		expect(
			errorFrom(() =>
				expenses.decide('tenant-a', approved.id, 'rejected', 'Again'),
			).code,
		).toBe('CLAIM_NOT_SUBMITTED');
	});

	it.each([
		['blank title', input({ title: '' })],
		['oversized title', input({ title: 'x'.repeat(161) })],
		['negative amount', input({ amountMinor: -1 })],
		['fractional amount', input({ amountMinor: 1.5 })],
		['invalid currency', input({ currency: 'EU1' })],
		['short currency', input({ currency: 'EU' })],
		[
			'invalid category',
			input({ category: 'lodging' as CreateExpensesClaimInput['category'] }),
		],
		['invalid date', input({ expenseDate: '2026-02-30' })],
		['oversized note', input({ note: 'x'.repeat(2_001) })],
	])('rejects %s with INVALID_CLAIM_INPUT', (_label, invalid) => {
		expect(
			errorFrom(() =>
				service().create(
					'tenant-a',
					'account-a',
					invalid as CreateExpensesClaimInput,
				),
			).code,
		).toBe('INVALID_CLAIM_INPUT');
	});

	it('requires a bounded decision comment', () => {
		const expenses = service();
		const blank = expenses.create('tenant-a', 'account-a', input());
		const oversized = expenses.create('tenant-a', 'account-a', input());
		expenses.submit('tenant-a', 'account-a', blank.id);
		expenses.submit('tenant-a', 'account-a', oversized.id);

		expect(
			errorFrom(() => expenses.decide('tenant-a', blank.id, 'approved', ''))
				.code,
		).toBe('INVALID_DECISION_COMMENT');
		expect(
			errorFrom(() =>
				expenses.decide(
					'tenant-a',
					oversized.id,
					'rejected',
					'x'.repeat(2_001),
				),
			).code,
		).toBe('INVALID_DECISION_COMMENT');
	});
});

describe('expenses.core endpoints', () => {
	it('returns 401 for every endpoint without a principal', async () => {
		const routes = createExpensesRoutes(
			{} as AuthRuntime,
			createExpensesRuntime({ databasePath: ':memory:' }),
		);
		for (const endpoint of routes) {
			const method = endpoint.methods.includes('GET') ? 'GET' : 'POST';
			const response = await endpoint.handler(
				context(
					new Request(`https://erp.example${endpoint.path}`, {
						method,
						...(method === 'POST'
							? {
									headers: { 'content-type': 'application/json' },
									body: '{}',
								}
							: {}),
					}),
				),
			);
			expect(response.status, `${method} ${endpoint.path}`).toBe(401);
			expect(await response.json()).toMatchObject({
				error: { code: 'UNAUTHENTICATED' },
			});
		}
	});

	it('returns 403 for every endpoint without its permission', async () => {
		const actor = principal([]);
		const routes = createExpensesRoutes(
			{} as AuthRuntime,
			createExpensesRuntime({ databasePath: ':memory:' }),
		);
		for (const endpoint of routes) {
			const method = endpoint.methods.includes('GET') ? 'GET' : 'POST';
			const response = await endpoint.handler(
				context(
					new Request(`https://erp.example${endpoint.path}`, {
						method,
						...(method === 'POST'
							? {
									headers: { 'content-type': 'application/json' },
									body: '{}',
								}
							: {}),
					}),
					actor,
				),
			);
			expect(response.status, `${method} ${endpoint.path}`).toBe(403);
			expect(await response.json()).toMatchObject({
				error: { code: 'FORBIDDEN' },
			});
		}
	});

	it('derives claim ownership from the authenticated principal', async () => {
		const actor = principal([
			EXPENSES_PERMISSIONS.read,
			EXPENSES_PERMISSIONS.manage,
		]);
		const runtime = createExpensesRuntime({ databasePath: ':memory:' });
		const routes = createExpensesRoutes(authRuntime(actor), runtime);
		const response = await route(
			routes,
			'/api/expenses/claims',
			'POST',
		).handler(
			context(
				mutationRequest('/api/expenses/claims', {
					...input(),
					tenantId: 'tenant-b',
					claimantId: 'account-b',
				}),
				actor,
			),
		);

		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			claim: {
				tenantId: 'tenant-a',
				claimantId: 'account-a',
				status: 'draft',
			},
		});
	});

	it('rejects a mutation with a bad CSRF token before writing', async () => {
		const actor = principal([EXPENSES_PERMISSIONS.manage]);
		const runtime = createExpensesRuntime({ databasePath: ':memory:' });
		const routes = createExpensesRoutes(authRuntime(actor), runtime);
		const response = await route(
			routes,
			'/api/expenses/claims',
			'POST',
		).handler(
			context(
				mutationRequest('/api/expenses/claims', input(), 'wrong-token'),
				actor,
			),
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: { code: 'CSRF_REJECTED' },
		});
		expect(
			runtime.service().list('tenant-a', 'account-a', null, false),
		).toEqual([]);
	});

	it('returns stable errors for invalid claim input and status filters', async () => {
		const actor = principal([
			EXPENSES_PERMISSIONS.read,
			EXPENSES_PERMISSIONS.manage,
		]);
		const runtime = createExpensesRuntime({ databasePath: ':memory:' });
		const routes = createExpensesRoutes(authRuntime(actor), runtime);
		const createResponse = await route(
			routes,
			'/api/expenses/claims',
			'POST',
		).handler(
			context(
				mutationRequest('/api/expenses/claims', {
					...input(),
					note: 42,
				}),
				actor,
			),
		);
		const listResponse = await route(
			routes,
			'/api/expenses/claims',
			'GET',
		).handler(
			context(
				new Request('https://erp.example/api/expenses/claims?status=paid'),
				actor,
			),
		);

		expect(createResponse.status).toBe(400);
		expect(await createResponse.json()).toMatchObject({
			error: { code: 'INVALID_CLAIM_INPUT' },
		});
		expect(listResponse.status).toBe(400);
		expect(await listResponse.json()).toMatchObject({
			error: { code: 'INVALID_CLAIM_STATUS' },
		});
	});
});
