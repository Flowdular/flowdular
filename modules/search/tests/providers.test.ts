import { describe, expect, it } from 'vitest';
import { SEARCH_PROVIDERS_CAPABILITY } from '../src/domain/providers.ts';
import type { SearchCursor } from '../src/domain/types.ts';
import { normalizeQuery } from '../src/services/search-service.ts';
import { SearchServiceError } from '../src/services/service-error.ts';
import {
	createHarness,
	fakeProvider,
	hit,
	nullRepository,
	principal,
} from './support/harness.ts';

const MEMBERS = 'users.members.read';
const INBOX = 'notifications.inbox.read';
const FILES = 'documents.files.read';
const TRAIL = 'audit.trail.read';

function fourProviders() {
	return [
		{
			moduleId: 'users.core',
			providers: [
				fakeProvider({
					key: 'users.members',
					permission: MEMBERS,
					pages: [[hit('ada', 9), hit('alan', 4)]],
				}),
			],
		},
		{
			moduleId: 'notifications.core',
			providers: [
				fakeProvider({
					key: 'notifications.inbox',
					permission: INBOX,
					pages: [[hit('note-1', 7)]],
				}),
			],
		},
		{
			moduleId: 'documents.core',
			providers: [
				fakeProvider({
					key: 'documents.files',
					permission: FILES,
					pages: [[hit('file-1', 6)]],
				}),
			],
		},
		{
			moduleId: 'audit.core',
			providers: [
				fakeProvider({
					key: 'audit.classes',
					permission: TRAIL,
					pages: [[hit('trail-1', 8)]],
				}),
			],
		},
	];
}

describe('SEARCH-PROVIDERS', () => {
	it('merges the permitted providers and leaves the unpermitted one out entirely', async () => {
		const harness = createHarness({
			repository: nullRepository(),
			providers: fourProviders(),
		});

		const page = await harness.service.search({
			principal: principal([MEMBERS, INBOX, FILES]),
			query: 'record',
			limit: 50,
		});

		expect(page.hits.map((entry) => entry.provider + ':' + entry.ref)).toEqual([
			'users.members:ada',
			'users.members:alan',
			'notifications.inbox:note-1',
			'documents.files:file-1',
		]);
		expect(page.providers.map((entry) => entry.key)).toEqual([
			'users.members',
			'notifications.inbox',
			'documents.files',
		]);
		/* The fourth is not permitted, so it is absent rather than unavailable. */
		expect(page.unavailable).toEqual([]);
	});

	it('never asks a provider whose permission the member lacks', async () => {
		const calls: string[] = [];
		const harness = createHarness({
			repository: nullRepository(),
			providers: [
				{
					moduleId: 'audit.core',
					providers: [
						fakeProvider({
							key: 'audit.classes',
							permission: TRAIL,
							pages: [[hit('trail-1', 1)]],
							onCall: () => calls.push('audit.classes'),
						}),
					],
				},
			],
		});

		await harness.service.search({
			principal: principal([MEMBERS]),
			query: 'trail',
			limit: 50,
		});

		expect(calls).toEqual([]);
	});

	it('answers each hit with a reference, title, snippet, view and route only', async () => {
		const harness = createHarness({
			repository: nullRepository(),
			providers: fourProviders(),
		});

		const page = await harness.service.search({
			principal: principal([MEMBERS]),
			query: 'ada',
			limit: 50,
		});

		expect(Object.keys(page.hits[0]!).sort()).toEqual([
			'provider',
			'ref',
			'route',
			'score',
			'snippet',
			'title',
			'viewId',
		]);
	});

	it('orders hits inside a provider by score and keeps provider order between them', async () => {
		const harness = createHarness({
			repository: nullRepository(),
			providers: [
				{
					moduleId: 'users.core',
					providers: [
						fakeProvider({
							key: 'users.members',
							permission: MEMBERS,
							/* Deliberately low scores first: provider order wins over score
							   across providers, score orders only inside one. */
							pages: [[hit('low', 1), hit('high', 9)]],
						}),
					],
				},
				{
					moduleId: 'notifications.core',
					providers: [
						fakeProvider({
							key: 'notifications.inbox',
							permission: INBOX,
							pages: [[hit('loud', 99)]],
						}),
					],
				},
			],
		});

		const page = await harness.service.search({
			principal: principal([MEMBERS, INBOX]),
			query: 'anything',
			limit: 50,
		});

		expect(page.hits.map((entry) => entry.ref)).toEqual([
			'high',
			'low',
			'loud',
		]);
	});

	it('drops a provider whose hit carries an unusable destination', async () => {
		const harness = createHarness({
			repository: nullRepository(),
			providers: [
				{
					moduleId: 'documents.core',
					providers: [
						fakeProvider({
							key: 'documents.files',
							permission: FILES,
							malformed: true,
						}),
					],
				},
			],
		});

		const page = await harness.service.search({
			principal: principal([FILES]),
			query: 'report',
			limit: 50,
		});

		expect(page.hits).toEqual([]);
		expect(page.unavailable).toEqual(['documents.files']);
	});

	it('pages the merged stream provider by provider', async () => {
		const harness = createHarness({
			repository: nullRepository(),
			providers: [
				{
					moduleId: 'users.core',
					providers: [
						fakeProvider({
							key: 'users.members',
							permission: MEMBERS,
							pages: [[hit('a', 9), hit('b', 8)], [hit('c', 7)]],
						}),
					],
				},
				{
					moduleId: 'notifications.core',
					providers: [
						fakeProvider({
							key: 'notifications.inbox',
							permission: INBOX,
							pages: [[hit('n1', 5)]],
						}),
					],
				},
			],
		});
		const ask = (cursor: SearchCursor | null) =>
			harness.service.search({
				principal: principal([MEMBERS, INBOX]),
				query: 'anything',
				limit: 2,
				cursor,
			});

		const first = await ask(null);
		expect(first.hits.map((entry) => entry.ref)).toEqual(['a', 'b']);
		expect(first.nextCursor).toEqual({
			provider: 'users.members',
			cursor: '1',
			skip: 0,
		});

		const second = await ask(first.nextCursor);
		expect(second.hits.map((entry) => entry.ref)).toEqual(['c', 'n1']);
		expect(second.nextCursor).toBeNull();
	});

	it('resumes inside a provider batch when a page cuts it in half', async () => {
		const harness = createHarness({
			repository: nullRepository(),
			providers: [
				{
					moduleId: 'users.core',
					providers: [
						fakeProvider({
							key: 'users.members',
							permission: MEMBERS,
							pages: [[hit('a', 9), hit('b', 8), hit('c', 7)]],
						}),
					],
				},
			],
		});

		const first = await harness.service.search({
			principal: principal([MEMBERS]),
			query: 'anything',
			limit: 2,
		});
		expect(first.nextCursor).toEqual({
			provider: 'users.members',
			cursor: '',
			skip: 2,
		});

		const second = await harness.service.search({
			principal: principal([MEMBERS]),
			query: 'anything',
			limit: 2,
			cursor: first.nextCursor,
		});
		expect(second.hits.map((entry) => entry.ref)).toEqual(['c']);
		expect(second.nextCursor).toBeNull();
	});

	it('narrows the fan-out to one provider when the filter names it', async () => {
		const calls: string[] = [];
		const harness = createHarness({
			repository: nullRepository(),
			providers: [
				{
					moduleId: 'users.core',
					providers: [
						fakeProvider({
							key: 'users.members',
							permission: MEMBERS,
							pages: [[hit('ada', 9)]],
							onCall: () => calls.push('users.members'),
						}),
					],
				},
				{
					moduleId: 'notifications.core',
					providers: [
						fakeProvider({
							key: 'notifications.inbox',
							permission: INBOX,
							pages: [[hit('note', 9)]],
							onCall: () => calls.push('notifications.inbox'),
						}),
					],
				},
			],
		});

		const page = await harness.service.search({
			principal: principal([MEMBERS, INBOX]),
			query: 'anything',
			limit: 50,
			provider: 'users.members',
		});

		expect(calls).toEqual(['users.members']);
		expect(page.hits.map((entry) => entry.ref)).toEqual(['ada']);
	});
});

describe('SEARCH-PAGING', () => {
	/* A cursor at a later provider would move the position past hits the member
	   never saw: the failed provider is earlier in merge order, so its records
	   could never be reached again through that cursor. */
	it('answers no cursor once a provider of this page was unavailable', async () => {
		const harness = createHarness({
			repository: nullRepository(),
			providers: [
				{
					moduleId: 'users.core',
					providers: [
						fakeProvider({
							key: 'users.members',
							permission: MEMBERS,
							fails: true,
						}),
					],
				},
				{
					moduleId: 'notifications.core',
					providers: [
						fakeProvider({
							key: 'notifications.inbox',
							permission: INBOX,
							pages: [[hit('n1', 9), hit('n2', 8)]],
						}),
					],
				},
			],
		});

		const page = await harness.service.search({
			principal: principal([MEMBERS, INBOX]),
			query: 'anything',
			limit: 1,
		});

		expect(page.hits.map((entry) => entry.ref)).toEqual(['n1']);
		expect(page.unavailable).toEqual(['users.members']);
		expect(page.nextCursor).toBeNull();
	});

	it('keeps paging when every asked provider answered', async () => {
		const harness = createHarness({
			repository: nullRepository(),
			providers: [
				{
					moduleId: 'notifications.core',
					providers: [
						fakeProvider({
							key: 'notifications.inbox',
							permission: INBOX,
							pages: [[hit('n1', 9), hit('n2', 8)]],
						}),
					],
				},
			],
		});

		const page = await harness.service.search({
			principal: principal([INBOX]),
			query: 'anything',
			limit: 1,
		});

		expect(page.nextCursor).toEqual({
			provider: 'notifications.inbox',
			cursor: '',
			skip: 1,
		});
	});
});

describe('search provider registration', () => {
	it('publishes the capability under the identifier providers resolve', () => {
		expect(SEARCH_PROVIDERS_CAPABILITY).toBe('search.providers.v1');
	});

	it('refuses a second provider under a key another module already took', () => {
		const harness = createHarness({
			repository: nullRepository(),
			unsealed: true,
			providers: [
				{
					moduleId: 'users.core',
					providers: [
						fakeProvider({ key: 'users.members', permission: MEMBERS }),
					],
				},
			],
		});

		expect(() =>
			harness.registry.register('documents.core', [
				fakeProvider({ key: 'users.members', permission: FILES }),
			]),
		).toThrowError(expect.objectContaining({ code: 'PROVIDER_DUPLICATE' }));
	});

	it('keeps none of a module list when one entry of it is malformed', () => {
		const harness = createHarness({
			repository: nullRepository(),
			unsealed: true,
		});

		expect(() =>
			harness.registry.register('users.core', [
				fakeProvider({ key: 'users.members', permission: MEMBERS }),
				{ key: 'Users Roles', label: 'Roles', permission: MEMBERS } as never,
			]),
		).toThrowError(expect.objectContaining({ code: 'PROVIDER_INVALID' }));
		expect(harness.registry.list()).toEqual([]);
	});

	it('refuses a registration made after the module started', () => {
		const harness = createHarness({ repository: nullRepository() });

		expect(() =>
			harness.registry.register('documents.core', [
				fakeProvider({ key: 'documents.files', permission: FILES }),
			]),
		).toThrowError(
			expect.objectContaining({ code: 'PROVIDER_REGISTRY_SEALED' }),
		);
	});
});

describe('SEARCH-BOUNDS', () => {
	it('refuses a query over 200 characters with a stable code', () => {
		let refused: unknown;
		try {
			normalizeQuery('a'.repeat(201));
		} catch (error) {
			refused = error;
		}
		expect(refused).toBeInstanceOf(SearchServiceError);
		expect((refused as SearchServiceError).code).toBe('QUERY_TOO_LONG');
		expect((refused as SearchServiceError).status).toBe(400);
	});

	it('accepts a query of exactly 200 characters', () => {
		expect(normalizeQuery('a'.repeat(200))).toHaveLength(200);
	});

	it('asks no provider for a query shorter than two characters', async () => {
		const calls: string[] = [];
		const harness = createHarness({
			repository: nullRepository(),
			providers: [
				{
					moduleId: 'users.core',
					providers: [
						fakeProvider({
							key: 'users.members',
							permission: MEMBERS,
							pages: [[hit('ada', 9)]],
							onCall: () => calls.push('users.members'),
						}),
					],
				},
			],
		});

		const page = await harness.service.search({
			principal: principal([MEMBERS]),
			query: normalizeQuery('a'),
			limit: 50,
		});

		expect(calls).toEqual([]);
		expect(page.hits).toEqual([]);
		expect(page.nextCursor).toBeNull();
		/* The provider list still comes back: the palette needs it to label the
		   groups it will show once the query grows. */
		expect(page.providers.map((entry) => entry.key)).toEqual(['users.members']);
	});

	it('collapses whitespace so the same words are one query', () => {
		expect(normalizeQuery('  ada   lovelace \n')).toBe('ada lovelace');
	});
});
