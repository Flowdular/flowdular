import { describe, expect, it } from 'vitest';
import type { TenantMember } from '@flowdular/module-auth';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	createSearchProviderRegistry,
	SearchService,
} from '@flowdular/module-search/server';
import {
	SEARCH_PROVIDERS_CAPABILITY,
	type SearchProvider,
} from '@flowdular/module-search';
import { USER_PERMISSIONS } from '../src/acl/permissions.ts';
import { createServerComposition } from '../src/platform.ts';
import {
	createMemberSearchProvider,
	matchMembers,
	memberScore,
	MEMBER_SEARCH_PROVIDER_KEY,
	MEMBER_SEARCH_PUSHDOWN_LIMIT,
	MEMBER_SEARCH_SCAN_LIMIT,
} from '../src/services/member-search.ts';

function member(
	accountId: string,
	displayName: string,
	email: string,
): TenantMember {
	return {
		accountId,
		email,
		displayName,
		role: 'member',
		roleId: null,
		status: 'active',
		membershipStatus: 'active',
		scopes: [],
		passwordChangeRequired: false,
		createdAt: 1,
	};
}

const DIRECTORY: Readonly<Record<string, readonly TenantMember[]>> = {
	'tenant-a': [
		member('account-ada', 'Ada Lovelace', 'ada@example.com'),
		member('account-alan', 'Alan Turing', 'alan@example.com'),
		member('account-grace', 'Grace Hopper', 'grace@navy.example'),
	],
	'tenant-b': [
		member('account-edsger', 'Edsger Dijkstra', 'ada@other.example'),
	],
};

/** The address as auth.core stores it in `email_normalized`. */
function normalized(value: string): string {
	return value.trim().normalize('NFKC').toLowerCase();
}

/**
 * What auth.core applies in SQL: the lower-cased display name or the
 * normalised address starts with the term, ordered by name then account id and
 * cut to the limit. The bound and the predicate are asserted against the
 * database in auth.core; here they stand in so the provider's own term
 * selection, ranking and paging are what the cases exercise.
 */
function matchingMembers(
	members: readonly TenantMember[],
	query: string,
	limit: number,
): readonly TenantMember[] {
	const term = normalized(query);
	return [...members]
		.filter(
			(entry) =>
				entry.displayName.toLowerCase().startsWith(term) ||
				normalized(entry.email).startsWith(term),
		)
		.sort(
			(left, right) =>
				left.displayName
					.toLowerCase()
					.localeCompare(right.displayName.toLowerCase()) ||
				left.accountId.localeCompare(right.accountId),
		)
		.slice(0, limit);
}

interface SearchCall {
	readonly tenantId: string;
	readonly query: string;
	readonly limit: number;
}

/** The administration port, answering the tenant it is asked about and no other. */
function authRuntime(
	calls: string[] = [],
	seen: SearchCall[] = [],
	directory: Readonly<Record<string, readonly TenantMember[]>> = DIRECTORY,
): AuthRuntime {
	return {
		service: async () => ({
			searchTenantMembers: async (
				tenantId: string,
				input: { readonly query: string; readonly limit: number },
			) => {
				calls.push(tenantId);
				seen.push({ tenantId, ...input });
				return matchingMembers(
					directory[tenantId] ?? [],
					input.query,
					input.limit,
				);
			},
		}),
	} as unknown as AuthRuntime;
}

function principal(scopes: readonly string[], tenantId = 'tenant-a') {
	return { accountId: 'account-ada', tenantId, scopes };
}

function searchService(auth: AuthRuntime) {
	const registry = createSearchProviderRegistry();
	registry.register('users.core', [createMemberSearchProvider(auth)]);
	registry.seal();
	return new SearchService({
		registry,
		repository: {
			recordQuery: async () => undefined,
			listRecent: async () => [],
			clearRecent: async () => 0,
			sweepRecent: async () => 0,
			exportRecent: async () => [],
		},
		budget: () => ({ providerTimeoutMs: 1_000, hitsPerProvider: 20 }),
	});
}

describe('USERS-SEARCH', () => {
	it('answers members of the principal own workspace and routes them to Users', async () => {
		const calls: string[] = [];
		const page = await searchService(authRuntime(calls)).search({
			principal: principal([USER_PERMISSIONS.read]),
			query: 'ada',
			limit: 50,
		});

		expect(page.hits.map((hit) => hit.ref)).toEqual(['account-ada']);
		expect(page.hits[0]).toMatchObject({
			provider: MEMBER_SEARCH_PROVIDER_KEY,
			title: 'Ada Lovelace',
			snippet: 'ada@example.com',
			viewId: 'users',
			route: '/users?member=account-ada',
		});
		expect(calls).toEqual(['tenant-a']);
	});

	it('reads the workspace of the searching principal and no other', async () => {
		const calls: string[] = [];
		const page = await searchService(authRuntime(calls)).search({
			principal: principal([USER_PERMISSIONS.read], 'tenant-b'),
			query: 'ada',
			limit: 50,
		});

		expect(page.hits.map((hit) => hit.ref)).toEqual(['account-edsger']);
		expect(calls).toEqual(['tenant-b']);
	});

	it('is never asked by a principal without users.members.read', async () => {
		const calls: string[] = [];
		const page = await searchService(authRuntime(calls)).search({
			principal: principal(['search.records.read']),
			query: 'ada',
			limit: 50,
		});

		expect(page.hits).toEqual([]);
		expect(page.providers).toEqual([]);
		expect(calls).toEqual([]);
	});

	it('pages with its own cursor without repeating a member', async () => {
		const service = searchService(
			authRuntime([], [], {
				'tenant-a': [
					member('account-ada', 'Delta Ada', 'ada@example.com'),
					member('account-alan', 'Delta Alan', 'alan@example.com'),
					member('account-grace', 'Delta Grace', 'grace@navy.example'),
				],
			}),
		);
		const first = await service.search({
			principal: principal([USER_PERMISSIONS.read]),
			query: 'delta',
			limit: 2,
		});
		expect(first.hits).toHaveLength(2);
		expect(first.nextCursor).not.toBeNull();

		const second = await service.search({
			principal: principal([USER_PERMISSIONS.read]),
			query: 'delta',
			limit: 2,
			cursor: first.nextCursor,
		});

		const refs = [...first.hits, ...second.hits].map((hit) => hit.ref);
		expect(new Set(refs).size).toBe(refs.length);
		expect(second.nextCursor).toBeNull();
	});
});

describe('member matching', () => {
	it('ranks an exact address above a name that merely contains the term', () => {
		expect(
			memberScore(
				member('a', 'Ada Lovelace', 'ada@example.com'),
				'ada@example.com',
			),
		).toBeGreaterThan(
			memberScore(member('b', 'Amadeus', 'other@example.com'), 'ada'),
		);
	});

	it('requires every term of a multi-word query to land', () => {
		const members = DIRECTORY['tenant-a']!;
		expect(
			matchMembers(members, 'ada lovelace').map((e) => e.member.accountId),
		).toEqual(['account-ada']);
		expect(matchMembers(members, 'ada turing')).toEqual([]);
	});

	it('answers nothing for a query of only whitespace', () => {
		expect(matchMembers(DIRECTORY['tenant-a']!, '   ')).toEqual([]);
	});

	/* The read is bounded where the rows are, so a workspace of unknown size is
	   never listed on a request path however large a page the caller asks for. */
	it('hands auth.core the documented bound whatever page it was asked for', async () => {
		const many = Array.from(
			{ length: MEMBER_SEARCH_SCAN_LIMIT + 25 },
			(_, index) =>
				member(
					`account-${String(index).padStart(4, '0')}`,
					`Person ${String(index).padStart(4, '0')}`,
					`person${index}@example.com`,
				),
		);
		const seen: SearchCall[] = [];
		const auth = authRuntime([], seen, { 'tenant-a': many });

		const page = await createMemberSearchProvider(auth).search({
			tenantId: 'tenant-a',
			principal: principal([USER_PERMISSIONS.read]),
			query: 'person',
			limit: 1_000,
		});

		expect(seen).toEqual([
			{
				tenantId: 'tenant-a',
				query: 'person',
				limit: MEMBER_SEARCH_SCAN_LIMIT,
			},
		]);
		expect(page.hits).toHaveLength(MEMBER_SEARCH_SCAN_LIMIT);
	});

	/* The port matches a prefix, so a term that opens no name and no address
	   answers nothing; falling through to the next term in turn keeps the word
	   order a person typed from changing what is found. */
	it('pushes the terms in order until one answers and finds the member either way', async () => {
		const seen: SearchCall[] = [];
		const provider = createMemberSearchProvider(authRuntime([], seen));
		const query = (text: string) =>
			provider.search({
				tenantId: 'tenant-a',
				principal: principal([USER_PERMISSIONS.read]),
				query: text,
				limit: 20,
			});

		expect((await query('ada lovelace')).hits.map((hit) => hit.ref)).toEqual([
			'account-ada',
		]);
		expect(seen.map((call) => call.query)).toEqual(['ada']);

		seen.length = 0;
		expect((await query('lovelace ada')).hits.map((hit) => hit.ref)).toEqual([
			'account-ada',
		]);
		expect(seen.map((call) => call.query)).toEqual(['lovelace', 'ada']);
	});

	/* The fall-through is bounded, so a query of many terms is a bounded number
	   of reads and a member only its fourth term opens is missed rather than
	   read for. */
	it('pushes at most the documented number of terms, each under the bound', async () => {
		const seen: SearchCall[] = [];
		const provider = createMemberSearchProvider(authRuntime([], seen));

		const page = await provider.search({
			tenantId: 'tenant-a',
			principal: principal([USER_PERMISSIONS.read]),
			query: 'countess of lovelace ada',
			limit: 20,
		});

		expect(page.hits).toEqual([]);
		expect(seen.map((call) => call.query)).toEqual([
			'countess',
			'of',
			'lovelace',
		]);
		expect(seen).toHaveLength(MEMBER_SEARCH_PUSHDOWN_LIMIT);
		expect([...new Set(seen.map((call) => call.limit))]).toEqual([
			MEMBER_SEARCH_SCAN_LIMIT,
		]);
	});

	it('asks auth.core nothing for a query of only whitespace', async () => {
		const seen: SearchCall[] = [];

		const page = await createMemberSearchProvider(authRuntime([], seen)).search(
			{
				tenantId: 'tenant-a',
				principal: principal([USER_PERMISSIONS.read]),
				query: '   ',
				limit: 20,
			},
		);

		expect(page).toEqual({ hits: [], nextCursor: null });
		expect(seen).toEqual([]);
	});

	it('answers nothing once its signal is aborted', async () => {
		const controller = new AbortController();
		controller.abort();

		const page = await createMemberSearchProvider(authRuntime()).search({
			tenantId: 'tenant-a',
			principal: principal([USER_PERMISSIONS.read]),
			query: 'ada',
			limit: 20,
			signal: controller.signal,
		});

		expect(page).toEqual({ hits: [], nextCursor: null });
	});
});

describe('users.core composition', () => {
	it('registers the member provider when search.core is composed', () => {
		const registered: { moduleId: string; keys: string[] }[] = [];
		createServerComposition({
			auth: authRuntime(),
			capabilities: {
				get: (id: string) =>
					id === SEARCH_PROVIDERS_CAPABILITY
						? {
								register: (
									moduleId: string,
									providers: readonly SearchProvider[],
								) =>
									registered.push({
										moduleId,
										keys: providers.map((provider) => provider.key),
									}),
							}
						: null,
			},
		} as never);

		expect(registered).toEqual([
			{ moduleId: 'users.core', keys: [MEMBER_SEARCH_PROVIDER_KEY] },
		]);
	});

	/* The capability is optional, so a deployment that leaves search.core out
	   still composes this module rather than failing at boot. */
	it('composes without the search capability', () => {
		const composition = createServerComposition({
			auth: authRuntime(),
			capabilities: { get: () => null },
		} as never);

		expect(composition.routes.length).toBeGreaterThan(0);
	});
});
