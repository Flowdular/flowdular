import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	SEARCH_RECENT_QUERY_CLASS,
	SEARCH_RECENT_RETENTION_DAYS,
	searchDataClasses,
} from '../src/domain/data-classes.ts';
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

const DAY = 86_400_000;

describe('search.core data class', () => {
	/* The qualified class id is what an operator's retention policy names, and
	   the spec calls it search.core.recent-queries. */
	it('declares the recent queries class under the key the spec names', () => {
		const [declaration, ...rest] = searchDataClasses(
			async () => shared.repository,
		);
		expect(rest).toEqual([]);
		expect(declaration?.key).toBe('recent-queries');
		expect(SEARCH_RECENT_QUERY_CLASS).toBe('recent-queries');
		expect(declaration?.defaultRetentionDays).toBe(90);
		expect(SEARCH_RECENT_RETENTION_DAYS).toBe(90);
		expect(declaration?.exportable).toBe(true);
	});

	it('sweeps only rows older than the cutoff in the given tenant', async () => {
		let clock = 0;
		const service = harness(() => clock).service;
		for (const [tenantId, query, at] of [
			['tenant-a', 'old', 1 * DAY],
			['tenant-a', 'fresh', 100 * DAY],
			['tenant-b', 'old-elsewhere', 1 * DAY],
		] as const) {
			clock = at;
			await service.search({
				principal: principal([MEMBERS], 'account-ada', tenantId),
				query,
				limit: 50,
				remember: true,
			});
		}
		const [declaration] = searchDataClasses(async () => shared.repository);

		if (!declaration?.sweep) throw new Error('sweep missing');
		const swept = await declaration.sweep({
			tenantId: 'tenant-a',
			cutoff: new Date(10 * DAY),
			limit: 100,
		});

		expect(swept.removed).toBe(1);
		expect(
			(await service.recent('tenant-a', 'account-ada')).map((row) => row.query),
		).toEqual(['fresh']);
		expect(
			(await service.recent('tenant-b', 'account-ada')).map((row) => row.query),
		).toEqual(['old-elsewhere']);
	});

	it('exports the tenant rows only', async () => {
		let clock = 0;
		const service = harness(() => (clock += DAY)).service;
		await service.search({
			principal: principal([MEMBERS], 'account-ada', 'tenant-a'),
			query: 'mine',
			limit: 50,
			remember: true,
		});
		await service.search({
			principal: principal([MEMBERS], 'account-ada', 'tenant-b'),
			query: 'theirs',
			limit: 50,
			remember: true,
		});
		const [declaration] = searchDataClasses(async () => shared.repository);
		const written: unknown[] = [];

		if (!declaration?.export) throw new Error('export missing');
		const summary = await declaration.export({
			tenantId: 'tenant-a',
			sink: { write: async (row) => void written.push(row) },
		});

		expect(summary.rows).toBe(1);
		expect(written).toEqual([
			{
				accountId: 'account-ada',
				query: 'mine',
				ranAt: new Date(DAY).toISOString(),
			},
		]);
	});

	/* Re-running a query rewrites its ran_at, so a walk keyed on the timestamp
	   moves the row behind the cursor and hands it out on a later page too. */
	it('hands the export no row twice when a query is re-run while it walks', async () => {
		let clock = 0;
		const service = harness(() => (clock += DAY)).service;
		for (const query of ['alpha', 'beta', 'gamma']) {
			await service.search({
				principal: principal([MEMBERS], 'account-ada', 'tenant-a'),
				query,
				limit: 50,
				remember: true,
			});
		}

		const first = await shared.repository.exportRecent('tenant-a', '', 2);
		const oldest = first[0]!;
		await service.search({
			principal: principal([MEMBERS], 'account-ada', 'tenant-a'),
			query: oldest.query,
			limit: 50,
			remember: true,
		});
		const second = await shared.repository.exportRecent(
			'tenant-a',
			first.at(-1)!.id,
			2,
		);

		expect(first.length + second.length).toBe(3);
		expect(
			[...first, ...second]
				.map((row) => row.id)
				.filter((id, index, all) => all.indexOf(id) !== index),
		).toEqual([]);
	});

	/* The registry decides the batch; the module still owns what one pass may
	   delete, so an unusable number never reaches the statement. */
	it('clamps a sweep batch the registry could not have meant', async () => {
		let clock = 0;
		const service = harness(() => clock).service;
		for (const [query, at] of [
			['old', 1 * DAY],
			['older', 2 * DAY],
		] as const) {
			clock = at;
			await service.search({
				principal: principal([MEMBERS], 'account-ada', 'tenant-a'),
				query,
				limit: 50,
				remember: true,
			});
		}
		const [declaration] = searchDataClasses(async () => shared.repository);

		if (!declaration?.sweep) throw new Error('sweep missing');
		const swept = await declaration.sweep({
			tenantId: 'tenant-a',
			cutoff: new Date(10 * DAY),
			limit: 1.5,
		});

		expect(swept.removed).toBe(1);
	});
});
