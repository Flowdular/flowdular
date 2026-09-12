import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SEARCH_LIMITS } from '../src/domain/types.ts';
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

function harness(now: () => number) {
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
	});
}

describe('SEARCH-RECENT', () => {
	it('keeps the newest 50 of 51 queries for that member only', async () => {
		let clock = 1_000;
		const service = harness(() => (clock += 1_000)).service;
		for (let index = 1; index <= 51; index += 1) {
			await service.search({
				principal: principal([MEMBERS]),
				query: 'query-' + String(index).padStart(3, '0'),
				limit: 50,
				remember: true,
			});
		}

		const recent = await service.recent('tenant-a', 'account-ada');

		expect(recent).toHaveLength(SEARCH_LIMITS.recentPerMember);
		expect(recent[0]?.query).toBe('query-051');
		expect(recent.at(-1)?.query).toBe('query-002');
		expect(recent.some((entry) => entry.query === 'query-001')).toBe(false);
		/* Another member of the same workspace sees none of them. */
		expect(await service.recent('tenant-a', 'account-alan')).toEqual([]);
	});

	it('moves a repeated query to the top instead of storing it twice', async () => {
		let clock = 1_000;
		const service = harness(() => (clock += 1_000)).service;
		for (const query of ['alpha', 'beta', 'alpha']) {
			await service.search({
				principal: principal([MEMBERS]),
				query,
				limit: 50,
				remember: true,
			});
		}

		expect(
			(await service.recent('tenant-a', 'account-ada')).map(
				(entry) => entry.query,
			),
		).toEqual(['alpha', 'beta']);
	});

	it('clears only the member own rows in this workspace', async () => {
		let clock = 1_000;
		const service = harness(() => (clock += 1_000)).service;
		await service.search({
			principal: principal([MEMBERS], 'account-ada', 'tenant-a'),
			query: 'ada',
			limit: 50,
			remember: true,
		});
		await service.search({
			principal: principal([MEMBERS], 'account-alan', 'tenant-a'),
			query: 'alan',
			limit: 50,
			remember: true,
		});
		await service.search({
			principal: principal([MEMBERS], 'account-ada', 'tenant-b'),
			query: 'elsewhere',
			limit: 50,
			remember: true,
		});

		expect(await service.clearRecent('tenant-a', 'account-ada')).toBe(1);

		expect(await service.recent('tenant-a', 'account-ada')).toEqual([]);
		expect(
			(await service.recent('tenant-a', 'account-alan')).map(
				(entry) => entry.query,
			),
		).toEqual(['alan']);
		expect(
			(await service.recent('tenant-b', 'account-ada')).map(
				(entry) => entry.query,
			),
		).toEqual(['elsewhere']);
	});

	it('records nothing for a page after the first', async () => {
		let clock = 1_000;
		const service = harness(() => (clock += 1_000)).service;

		await service.search({
			principal: principal([MEMBERS]),
			query: 'ada',
			limit: 50,
			cursor: { provider: 'users.members', cursor: '', skip: 1 },
			remember: true,
		});

		expect(await service.recent('tenant-a', 'account-ada')).toEqual([]);
	});

	/* SEARCH-RECENT-DELIBERATE: the screen and the palette search on every
	   debounced keystroke, and a prefix is not a query the member meant to run. */
	it('records nothing for a search that did not ask to be remembered', async () => {
		let clock = 1_000;
		const service = harness(() => (clock += 1_000)).service;

		for (const query of ['ad', 'ada']) {
			await service.search({
				principal: principal([MEMBERS]),
				query,
				limit: 50,
			});
		}
		await service.search({
			principal: principal([MEMBERS]),
			query: 'ada',
			limit: 50,
			remember: true,
		});

		expect(
			(await service.recent('tenant-a', 'account-ada')).map(
				(entry) => entry.query,
			),
		).toEqual(['ada']);
	});

	it('records nothing for a query shorter than two characters', async () => {
		let clock = 1_000;
		const service = harness(() => (clock += 1_000)).service;

		await service.search({
			principal: principal([MEMBERS]),
			query: 'a',
			limit: 50,
			remember: true,
		});

		expect(await service.recent('tenant-a', 'account-ada')).toEqual([]);
	});
});
