import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DataClassDeclaration } from '@flowdular/kernel';
import { researchDataClasses } from '../src/services/data-classes.ts';
import {
	openResearchTestDatabase,
	type ResearchTestDatabase,
} from './support/database.ts';
import {
	researchService,
	testSettings,
	writeFixtures,
	type Fixtures,
} from './support/service.ts';

const TENANT = 'tenant-retention';
const OTHER = 'tenant-kept';
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-16T12:00:00Z');

let shared: ResearchTestDatabase;
let fixtures: Fixtures;

beforeAll(async () => {
	shared = await openResearchTestDatabase();
	fixtures = await writeFixtures({
		queries: {
			acme: [
				{
					url: 'https://a.example.org/r',
					title: 'R',
					snippet: 'S',
					source: 'a',
				},
			],
		},
		pages: { 'https://a.example.org/p': { title: 'P', text: 'Page' } },
	});
});

afterEach(async () => {
	await shared.reset();
});

afterAll(async () => {
	await fixtures?.dispose();
	await shared?.dispose();
});

function byKey(classes: readonly DataClassDeclaration[], key: string) {
	return classes.find((entry) => entry.key === key)!;
}

describe('research data classes', () => {
	it('RESEARCH-RETENTION declares evidence, queries and pages with their periods', () => {
		const classes = researchDataClasses(async () =>
			researchService({ repository: shared.repository }),
		);
		expect(
			classes.map((entry) => [
				entry.key,
				entry.defaultRetentionDays,
				entry.exportable,
				typeof entry.sweep,
				typeof entry.erase,
			]),
		).toEqual([
			['evidence', 180, true, 'function', 'function'],
			['queries', 90, true, 'function', 'function'],
			['pages', 1, false, 'function', 'function'],
		]);
		expect(byKey(classes, 'pages').excludedReason).toMatch(/cache/);
		expect(byKey(classes, 'pages').export).toBeUndefined();
	});

	it('RESEARCH-RETENTION sweeps past the cutoff only, exports both classes and erases the member from the rows', async () => {
		let clock = NOW - 200 * DAY;
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({ recordedFixturesPath: fixtures.path }),
			now: () => clock,
		});
		const work = async (tenantId: string, runId: string) => {
			await service.search(
				{ tenantId, query: 'acme', caller: 'member', callerRef: 'account-ada' },
				'account-ada',
			);
			await service.fetch(
				{
					tenantId,
					url: 'https://a.example.org/p',
					caller: 'agent',
					callerRef: runId,
				},
				'account-ada',
			);
		};
		await work(TENANT, 'run-old');
		await work(OTHER, 'run-old');
		clock = NOW - DAY;
		await work(TENANT, 'run-new');
		await shared.repository.savePage(TENANT, {
			url: 'https://a.example.org/cached',
			title: 'Cached',
			contentSha256: 'a'.repeat(64),
			text: 'cached',
			fetchedAt: NOW - 3 * DAY,
			expiresAt: NOW - 2 * DAY,
		});
		const classes = researchDataClasses(async () => service);

		const evidence = byKey(classes, 'evidence');
		const queries = byKey(classes, 'queries');
		const pages = byKey(classes, 'pages');
		expect(
			await evidence.sweep!({
				tenantId: TENANT,
				cutoff: new Date(NOW - 180 * DAY),
				limit: 100,
			}),
		).toEqual({ removed: 2 });
		expect(
			await queries.sweep!({
				tenantId: TENANT,
				cutoff: new Date(NOW - 90 * DAY),
				limit: 100,
			}),
		).toEqual({ removed: 2 });
		expect(
			await pages.sweep!({
				tenantId: TENANT,
				cutoff: new Date(NOW - DAY),
				limit: 100,
			}),
		).toEqual({ removed: 1 });
		expect(await shared.repository.listEvidence(TENANT, 10, null)).toHaveLength(
			2,
		);
		expect(await shared.repository.listEvidence(OTHER, 10, null)).toHaveLength(
			2,
		);
		expect(await shared.repository.listQueries(OTHER, 10, null)).toHaveLength(
			1,
		);

		const rows: Record<string, unknown>[] = [];
		const sink = {
			write: async (row: Record<string, unknown>) => void rows.push(row),
		};
		expect((await evidence.export!({ tenantId: TENANT, sink })).rows).toBe(2);
		expect((await queries.export!({ tenantId: TENANT, sink })).rows).toBe(1);
		expect(
			rows.map(
				(row) => Object.keys(row).includes('contentSha256') || 'query' in row,
			),
		).toEqual([true, true, true]);

		const subject = { accountId: 'account-ada' };
		expect(await evidence.count!({ tenantId: TENANT, subject })).toBe(2);
		expect(await queries.count!({ tenantId: TENANT, subject })).toBe(1);
		expect(
			await evidence.erase!({ tenantId: TENANT, subject, limit: 100 }),
		).toEqual({
			removed: 0,
			redacted: 2,
			truncated: false,
		});
		expect(
			await queries.erase!({ tenantId: TENANT, subject, limit: 100 }),
		).toEqual({
			removed: 0,
			redacted: 1,
			truncated: false,
		});
		expect(await evidence.count!({ tenantId: TENANT, subject })).toBe(0);
		expect(await queries.count!({ tenantId: TENANT, subject })).toBe(0);
		expect(await shared.repository.listEvidence(TENANT, 10, null)).toHaveLength(
			2,
		);
		expect(await evidence.count!({ tenantId: OTHER, subject })).toBe(2);
		await shared.repository.savePage(TENANT, {
			url: 'https://a.example.org/fresh',
			title: 'Fresh',
			contentSha256: 'b'.repeat(64),
			text: 'fresh',
			fetchedAt: NOW,
			expiresAt: NOW + DAY,
		});
		expect(await pages.count!({ tenantId: TENANT, subject })).toBe(1);
		expect(
			await pages.erase!({ tenantId: TENANT, subject, limit: 100 }),
		).toEqual({
			removed: 1,
			truncated: false,
		});
	});
});
