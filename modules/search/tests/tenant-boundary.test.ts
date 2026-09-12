import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	openSearchTestDatabase,
	type SearchTestDatabase,
} from './support/database.ts';
import {
	createHarness,
	fakeProvider,
	hit,
	principal,
} from './support/harness.ts';

const MEMBERS = 'users.members.read';

let shared: SearchTestDatabase;

beforeAll(async () => {
	shared = await openSearchTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

function service(now: () => number) {
	return createHarness({
		repository: shared.repository,
		now,
		providers: [
			{
				moduleId: 'users.core',
				providers: [
					fakeProvider({
						key: 'users.members',
						permission: MEMBERS,
						pages: [[hit('ada', 9)]],
					}),
				],
			},
		],
	}).service;
}

describe('SEARCH-TENANT-BOUNDARY', () => {
	it('shows a member only the recent queries of the workspace they are in', async () => {
		let clock = 1_000;
		const search = service(() => (clock += 1_000));
		await search.search({
			principal: principal([MEMBERS], 'account-ada', 'tenant-a'),
			query: 'in-a',
			limit: 50,
			remember: true,
		});
		await search.search({
			principal: principal([MEMBERS], 'account-ada', 'tenant-b'),
			query: 'in-b',
			limit: 50,
			remember: true,
		});

		expect(
			(await search.recent('tenant-a', 'account-ada')).map(
				(entry) => entry.query,
			),
		).toEqual(['in-a']);
		expect(
			(await search.recent('tenant-b', 'account-ada')).map(
				(entry) => entry.query,
			),
		).toEqual(['in-b']);
	});

	it('hands every provider the tenant of the principal, never a request value', async () => {
		const seen: string[] = [];
		const harness = createHarness({
			repository: shared.repository,
			providers: [
				{
					moduleId: 'users.core',
					providers: [
						fakeProvider({
							key: 'users.members',
							permission: MEMBERS,
							pages: [[hit('ada', 9)]],
							onCall: (input) =>
								seen.push(input.tenantId + '/' + input.principal.tenantId),
						}),
					],
				},
			],
		});

		await harness.service.search({
			principal: principal([MEMBERS], 'account-ada', 'tenant-b'),
			query: 'ada',
			limit: 50,
		});

		expect(seen).toEqual(['tenant-b/tenant-b']);
	});

	it('refuses a row written under another workspace identifier', async () => {
		await expect(
			shared.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO search_recent_queries
						 (id, tenant_id, account_id, query, ran_at)
						 VALUES ('row-foreign', 'tenant-b', 'account-ada', 'ada', 1)`,
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			),
		).rejects.toThrow();
	});

	it('hides a row of another workspace from a tenant-scoped read', async () => {
		await shared.runtime.transaction(
			(transaction) =>
				transaction.execute({
					text: `INSERT INTO search_recent_queries
					 (id, tenant_id, account_id, query, ran_at)
					 VALUES ('row-b', 'tenant-b', 'account-ada', 'only-in-b', 1)`,
				}),
			{ access: 'write', tenantId: 'tenant-b' },
		);

		const rows = await shared.runtime.transaction(
			(transaction) =>
				transaction.query<{ id: string }>({
					text: 'SELECT id FROM search_recent_queries',
				}),
			{ access: 'read', tenantId: 'tenant-a' },
		);

		expect(rows.rows).toEqual([]);
	});
});
