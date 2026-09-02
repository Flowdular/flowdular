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
const TEST_ACTOR = {
	kind: 'user',
	id: 'account-a',
	label: 'Employee',
} as const;

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
		authorizeAgentToolAccess: () => [],
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
		const first = expenses.create('tenant-a', 'account-a', input(), TEST_ACTOR);
		const second = expenses.create(
			'tenant-a',
			'account-a',
			input(),
			TEST_ACTOR,
		);

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

	it('resolves a linked note once while retaining the raw template', () => {
		const expenses = service();
		const claim = expenses.create(
			'tenant-a',
			'account-a',
			input({ note: 'Receipt for {{ expense.title }} on {{ expense.date }}.' }),
			TEST_ACTOR,
		);
		expect(claim.noteTemplate).toBe(
			'Receipt for {{ expense.title }} on {{ expense.date }}.',
		);
		expect(claim.note).toBe(
			'Receipt for Train to customer site on 2026-08-20.',
		);
		expect(
			expenses.list('tenant-a', 'account-a', null, false)[0],
		).toMatchObject({
			noteTemplate: 'Receipt for {{ expense.title }} on {{ expense.date }}.',
			note: 'Receipt for Train to customer site on 2026-08-20.',
		});
	});

	it('rejects unknown linked-note variables before persisting the claim', () => {
		expect(
			errorFrom(() =>
				service().create(
					'tenant-a',
					'account-a',
					input({ note: '{{ party.name }}' }),
					TEST_ACTOR,
				),
			).code,
		).toBe('UNKNOWN_TEMPLATE_VARIABLE');
	});

	it('isolates employee lists and direct actions by tenant', () => {
		const expenses = service();
		const foreign = expenses.create(
			'tenant-b',
			'account-b',
			input(),
			TEST_ACTOR,
		);

		expect(expenses.list('tenant-a', 'account-a', null, false)).toEqual([]);
		expect(
			errorFrom(() =>
				expenses.submit('tenant-a', 'account-b', foreign.id, TEST_ACTOR),
			).code,
		).toBe('CLAIM_NOT_FOUND');
	});

	it('filters employee claims by status and orders newest expense first', () => {
		const expenses = service();
		const older = expenses.create(
			'tenant-a',
			'account-a',
			input({ title: 'Older', expenseDate: '2026-08-01' }),
			TEST_ACTOR,
		);
		expenses.create(
			'tenant-a',
			'account-b',
			input({ title: 'Another employee', expenseDate: '2026-08-31' }),
			TEST_ACTOR,
		);
		const newer = expenses.create(
			'tenant-a',
			'account-a',
			input({ title: 'Newer', expenseDate: '2026-08-20' }),
			TEST_ACTOR,
		);
		expenses.submit('tenant-a', 'account-a', older.id, TEST_ACTOR);

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
		const first = expenses.create('tenant-a', 'account-a', input(), TEST_ACTOR);
		const second = expenses.create(
			'tenant-a',
			'account-b',
			input(),
			TEST_ACTOR,
		);
		const foreign = expenses.create(
			'tenant-b',
			'account-c',
			input(),
			TEST_ACTOR,
		);
		expenses.submit('tenant-a', 'account-a', first.id, TEST_ACTOR);
		expenses.submit('tenant-a', 'account-b', second.id, TEST_ACTOR);
		expenses.submit('tenant-b', 'account-c', foreign.id, TEST_ACTOR);

		expect(
			expenses.list('tenant-a', 'manager', 'submitted', true),
		).toHaveLength(2);
		expect(expenses.countAwaitingApproval('tenant-a')).toBe(2);
	});

	it('allows only the claimant to update and submit a draft', () => {
		const expenses = service();
		const claim = expenses.create('tenant-a', 'account-a', input(), TEST_ACTOR);

		expect(
			errorFrom(() =>
				expenses.update(
					'tenant-a',
					'account-b',
					claim.id,
					input({ title: 'Changed' }),
					TEST_ACTOR,
				),
			).code,
		).toBe('CLAIM_NOT_OWNED');

		const changed = expenses.update(
			'tenant-a',
			'account-a',
			claim.id,
			input({ title: 'Changed', note: null }),
			TEST_ACTOR,
		);
		expect(changed).toMatchObject({ title: 'Changed', note: null });
		expect(
			expenses.submit('tenant-a', 'account-a', claim.id, TEST_ACTOR).status,
		).toBe('submitted');
		expect(
			errorFrom(() =>
				expenses.update('tenant-a', 'account-a', claim.id, input(), TEST_ACTOR),
			).code,
		).toBe('CLAIM_NOT_DRAFT');
	});

	it('deletes only the claimant own draft and retains its audit history', () => {
		const repository = new SqliteExpensesRepository(':memory:');
		const expenses = new ExpensesService(repository);
		const draft = expenses.create('tenant-a', 'account-a', input(), TEST_ACTOR);
		const submitted = expenses.create(
			'tenant-a',
			'account-a',
			input({ title: 'Submitted' }),
			TEST_ACTOR,
		);
		expenses.submit('tenant-a', 'account-a', submitted.id, TEST_ACTOR);
		const approved = expenses.create(
			'tenant-a',
			'account-a',
			input({ title: 'Approved' }),
			TEST_ACTOR,
		);
		expenses.submit('tenant-a', 'account-a', approved.id, TEST_ACTOR);
		expenses.decide(
			'tenant-a',
			approved.id,
			'approved',
			'Within policy',
			TEST_ACTOR,
		);
		const rejected = expenses.create(
			'tenant-a',
			'account-a',
			input({ title: 'Rejected' }),
			TEST_ACTOR,
		);
		expenses.submit('tenant-a', 'account-a', rejected.id, TEST_ACTOR);
		expenses.decide(
			'tenant-a',
			rejected.id,
			'rejected',
			'Missing receipt',
			TEST_ACTOR,
		);

		expect(
			errorFrom(() =>
				expenses.delete('tenant-a', 'account-b', draft.id, TEST_ACTOR),
			).code,
		).toBe('CLAIM_NOT_OWNED');
		expect(
			errorFrom(() =>
				expenses.delete('tenant-b', 'account-a', draft.id, TEST_ACTOR),
			).code,
		).toBe('CLAIM_NOT_FOUND');
		expect(
			errorFrom(() =>
				expenses.delete('tenant-a', 'account-a', submitted.id, TEST_ACTOR),
			).code,
		).toBe('CLAIM_NOT_DRAFT');
		for (const decided of [approved, rejected]) {
			expect(
				errorFrom(() =>
					expenses.delete('tenant-a', 'account-a', decided.id, TEST_ACTOR),
				).code,
			).toBe('CLAIM_NOT_DRAFT');
		}

		expenses.delete('tenant-a', 'account-a', draft.id, TEST_ACTOR);
		expect(
			expenses
				.list('tenant-a', 'account-a', null, false)
				.map((claim) => claim.id),
		).toEqual(expect.arrayContaining([submitted.id, approved.id, rejected.id]));
		const history = repository.history({
			tenantId: 'tenant-a',
			recordId: draft.id,
			limit: 20,
			cursor: null,
		});
		expect(history.entries[0]).toMatchObject({
			action: 'deleted',
			actor: TEST_ACTOR,
		});
	});

	it('approves or rejects submitted claims with a required comment', () => {
		const expenses = service();
		const approved = expenses.create(
			'tenant-a',
			'account-a',
			input(),
			TEST_ACTOR,
		);
		const rejected = expenses.create(
			'tenant-a',
			'account-b',
			input(),
			TEST_ACTOR,
		);
		expenses.submit('tenant-a', 'account-a', approved.id, TEST_ACTOR);
		expenses.submit('tenant-a', 'account-b', rejected.id, TEST_ACTOR);

		expect(
			expenses.decide(
				'tenant-a',
				approved.id,
				'approved',
				'Within policy',
				TEST_ACTOR,
			),
		).toMatchObject({
			status: 'approved',
			decisionComment: 'Within policy',
		});
		expect(
			expenses.decide(
				'tenant-a',
				rejected.id,
				'rejected',
				'Receipt missing',
				TEST_ACTOR,
			),
		).toMatchObject({
			status: 'rejected',
			decisionComment: 'Receipt missing',
		});
		expect(expenses.countAwaitingApproval('tenant-a')).toBe(0);
		expect(
			errorFrom(() =>
				expenses.decide(
					'tenant-a',
					approved.id,
					'rejected',
					'Again',
					TEST_ACTOR,
				),
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
					TEST_ACTOR,
				),
			).code,
		).toBe('INVALID_CLAIM_INPUT');
	});

	it('requires a bounded decision comment', () => {
		const expenses = service();
		const blank = expenses.create('tenant-a', 'account-a', input(), TEST_ACTOR);
		const oversized = expenses.create(
			'tenant-a',
			'account-a',
			input(),
			TEST_ACTOR,
		);
		expenses.submit('tenant-a', 'account-a', blank.id, TEST_ACTOR);
		expenses.submit('tenant-a', 'account-a', oversized.id, TEST_ACTOR);

		expect(
			errorFrom(() =>
				expenses.decide('tenant-a', blank.id, 'approved', '', TEST_ACTOR),
			).code,
		).toBe('INVALID_DECISION_COMMENT');
		expect(
			errorFrom(() =>
				expenses.decide(
					'tenant-a',
					oversized.id,
					'rejected',
					'x'.repeat(2_001),
					TEST_ACTOR,
				),
			).code,
		).toBe('INVALID_DECISION_COMMENT');
	});

	it('records claim revisions with actors and hides them from other claimants', () => {
		const expenses = service();
		const claim = expenses.create('tenant-a', 'account-a', input(), TEST_ACTOR);
		expenses.update(
			'tenant-a',
			'account-a',
			claim.id,
			input({ title: 'Train ticket', note: null }),
			TEST_ACTOR,
		);
		expenses.submit('tenant-a', 'account-a', claim.id, TEST_ACTOR);
		expenses.decide('tenant-a', claim.id, 'approved', 'Within policy', {
			kind: 'agent',
			id: 'approval-agent',
			label: 'Expense approver',
			runId: 'run-1',
		});

		const history = expenses.history('tenant-a', 'account-a', false, {
			recordId: claim.id,
			limit: 20,
			cursor: null,
		});
		expect(history.entries.map((entry) => entry.action)).toEqual([
			'approved',
			'submitted',
			'updated',
			'created',
		]);
		expect(history.entries[0]?.actor).toEqual({
			kind: 'agent',
			id: 'approval-agent',
			label: 'Expense approver',
			runId: 'run-1',
		});
		expect(history.entries[0]?.changes).toEqual({
			status: { from: 'submitted', to: 'approved' },
			decisionComment: { from: null, to: 'Within policy' },
		});
		expect(
			errorFrom(() =>
				expenses.history('tenant-a', 'account-b', false, {
					recordId: claim.id,
					limit: 20,
					cursor: null,
				}),
			).code,
		).toBe('CLAIM_NOT_FOUND');
		expect(
			errorFrom(() =>
				expenses.history('tenant-b', 'account-a', true, {
					recordId: claim.id,
					limit: 20,
					cursor: null,
				}),
			).code,
		).toBe('CLAIM_NOT_FOUND');
	});
});

describe('expenses.core endpoints', () => {
	it('returns 401 for every endpoint without a principal', async () => {
		const routes = createExpensesRoutes(
			{ authorizeAgentToolAccess: () => [] } as unknown as AuthRuntime,
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
			{ authorizeAgentToolAccess: () => [] } as unknown as AuthRuntime,
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

	it('deletes an owned draft through the guarded endpoint', async () => {
		const actor = principal([
			EXPENSES_PERMISSIONS.read,
			EXPENSES_PERMISSIONS.manage,
		]);
		const runtime = createExpensesRuntime({ databasePath: ':memory:' });
		const claim = runtime
			.service()
			.create('tenant-a', 'account-a', input(), TEST_ACTOR);
		const routes = createExpensesRoutes(authRuntime(actor), runtime);

		const badCsrf = await route(
			routes,
			'/api/expenses/claims/delete',
			'POST',
		).handler(
			context(
				mutationRequest(
					'/api/expenses/claims/delete',
					{ claimId: claim.id },
					'wrong-token',
				),
				actor,
			),
		);
		expect(badCsrf.status).toBe(403);
		expect(
			runtime.service().list('tenant-a', 'account-a', null, false),
		).toHaveLength(1);

		const response = await route(
			routes,
			'/api/expenses/claims/delete',
			'POST',
		).handler(
			context(
				mutationRequest('/api/expenses/claims/delete', { claimId: claim.id }),
				actor,
			),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ deleted: true });
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
