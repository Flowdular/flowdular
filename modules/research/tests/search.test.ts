import { relative } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectorCalls } from '../src/services/capabilities.ts';
import {
	openResearchTestDatabase,
	type ResearchTestDatabase,
} from './support/database.ts';
import {
	fakeMeters,
	researchService,
	testSettings,
	writeFixtures,
	type Fixtures,
} from './support/service.ts';

const TENANT = 'tenant-search';
const MEMBER = 'account-member';

const RESULTS = [
	{
		url: 'https://registry.example.org/acme',
		title: 'Acme in the registry',
		snippet: 'Registered in 1999.',
		source: 'registry.example.org',
	},
	{
		url: 'https://news.blocked.example/acme',
		title: 'A blocked source',
		snippet: 'Should never be kept.',
		source: 'blocked.example',
	},
	{
		url: 'https://press.example.org/acme#section',
		title: 'Acme in the press',
		snippet: 'Acme expands.',
		publishedAt: '2026-09-01',
		source: 'press.example.org',
	},
];

let shared: ResearchTestDatabase;
let fixtures: Fixtures;

beforeAll(async () => {
	shared = await openResearchTestDatabase();
	fixtures = await writeFixtures({
		queries: { 'acme insurance': RESULTS },
		pages: {},
	});
});

afterEach(async () => {
	await shared.reset();
});

afterAll(async () => {
	await fixtures?.dispose();
	await shared?.dispose();
});

describe('research search', () => {
	it('RESEARCH-SEARCH-RECORDED keeps the admitted results as evidence linked to one counted query', async () => {
		const meters = fakeMeters();
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({
				recordedFixturesPath: fixtures.path,
				denyDomains: ['blocked.example'],
			}),
			meters,
		});

		const answer = await service.search(
			{
				tenantId: TENANT,
				query: 'acme insurance',
				caller: 'member',
				callerRef: MEMBER,
			},
			MEMBER,
		);

		expect(answer.adapter).toBe('recorded');
		expect(answer.results.map((result) => result.url)).toEqual([
			'https://registry.example.org/acme',
			'https://press.example.org/acme',
		]);
		expect(
			answer.results.every((result) => typeof result.evidenceId === 'string'),
		).toBe(true);
		const queries = await shared.repository.listQueries(TENANT, 10, null);
		expect(queries).toHaveLength(1);
		expect(queries[0]).toMatchObject({
			id: answer.queryId,
			query: 'acme insurance',
			adapter: 'recorded',
			caller: 'member',
			callerRef: MEMBER,
			resultCount: 2,
			costUnits: 1,
		});
		const evidence = await shared.repository.listEvidence(TENANT, 10, null);
		expect(evidence).toHaveLength(2);
		expect(
			evidence.every(
				(entry) => entry.createdBy === MEMBER && entry.runId === null,
			),
		).toBe(true);
		const linked = await shared.repository.listAttached(
			TENANT,
			'research.core',
			`query:${answer.queryId}`,
			10,
		);
		expect(linked.map((entry) => entry.id).sort()).toEqual(
			answer.results.map((result) => result.evidenceId).sort(),
		);
		expect(meters.recorded).toEqual([
			`research.core.queries:${answer.queryId}`,
		]);
	});

	it('RESEARCH-SEARCH-RECORDED narrows by site and freshness and answers no results for an unrecorded query', async () => {
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({ recordedFixturesPath: fixtures.path }),
			now: () => Date.parse('2026-09-16T00:00:00Z'),
		});

		const site = await service.search({
			tenantId: TENANT,
			query: 'acme insurance',
			site: 'example.org',
			freshness: 'week',
			caller: 'member',
		});
		const nothing = await service.search({
			tenantId: TENANT,
			query: 'unknown',
			caller: 'member',
		});

		/* The registry entry carries no date, so freshness keeps it; the press
		   entry is older than a week and goes. */
		expect(site.results.map((result) => result.url)).toEqual([
			'https://registry.example.org/acme',
		]);
		expect(nothing.results).toEqual([]);
	});

	it('RESEARCH-RECORDED-PATH reads an absolute or a workspace-relative research-fixtures.json and nothing else', async () => {
		const other = await writeFixtures(
			{ queries: { 'acme insurance': RESULTS } },
			'other.json',
		);
		try {
			const absolute = researchService({
				repository: shared.repository,
				settings: testSettings({ recordedFixturesPath: fixtures.path }),
			});
			const relativePath = researchService({
				repository: shared.repository,
				workspaceRoot: fixtures.directory,
				settings: testSettings({
					recordedFixturesPath: relative(fixtures.directory, fixtures.path),
				}),
			});
			const wrongName = researchService({
				repository: shared.repository,
				settings: testSettings({ recordedFixturesPath: other.path }),
			});
			const search = {
				tenantId: TENANT,
				query: 'acme insurance',
				caller: 'member',
			} as const;

			expect((await absolute.search(search)).results).toHaveLength(3);
			expect((await relativePath.search(search)).results).toHaveLength(3);
			await expect(wrongName.search(search)).rejects.toMatchObject({
				code: 'RESEARCH_FIXTURES_UNAVAILABLE',
				status: 409,
			});
			/* The refused search released its reservation. */
			expect(
				await shared.repository.listQueries(TENANT, 10, null),
			).toHaveLength(2);
		} finally {
			await other.dispose();
		}
	});

	it('RESEARCH-MODEL-NATIVE refuses outside a run and reads back what the native tool recorded inside one', async () => {
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({ adapter: 'model-native' }),
		});

		await expect(
			service.search({
				tenantId: TENANT,
				query: 'acme insurance',
				caller: 'member',
			}),
		).rejects.toMatchObject({
			code: 'RESEARCH_ADAPTER_UNAVAILABLE',
			status: 409,
		});
		expect(await shared.repository.listQueries(TENANT, 10, null)).toEqual([]);

		await service.recordNative(
			TENANT,
			'run-native',
			MEMBER,
			'acme insurance',
			RESULTS,
		);
		const [query] = await shared.repository.listQueries(TENANT, 10, null);
		expect(query).toMatchObject({
			adapter: 'model-native',
			caller: 'agent',
			callerRef: 'run-native',
			resultCount: 3,
			costUnits: 1,
		});

		const readBack = await service.search({
			tenantId: TENANT,
			query: 'acme insurance',
			caller: 'agent',
			callerRef: 'run-native',
		});
		expect(readBack.queryId).toBeNull();
		expect(readBack.results.map((result) => result.url)).toEqual([
			'https://registry.example.org/acme',
			'https://news.blocked.example/acme',
			'https://press.example.org/acme',
		]);
		const evidence = await shared.repository.listEvidence(TENANT, 10, null);
		expect(evidence.every((entry) => entry.runId === 'run-native')).toBe(true);
		expect(readBack.results.map((result) => result.evidenceId).sort()).toEqual(
			evidence.map((entry) => entry.id).sort(),
		);
		expect(await shared.repository.listQueries(TENANT, 10, null)).toHaveLength(
			1,
		);

		await expect(
			service.search({
				tenantId: TENANT,
				query: 'another query',
				caller: 'agent',
				callerRef: 'run-native',
			}),
		).rejects.toMatchObject({ code: 'RESEARCH_ADAPTER_UNAVAILABLE' });
	});

	it('RESEARCH-CONNECTOR calls the named instance and releases the unit when the call is refused', async () => {
		const requests: unknown[] = [];
		let outcome: 'succeeded' | 'refused' = 'succeeded';
		const calls: ConnectorCalls = {
			call: async (request) => {
				requests.push(request);
				return {
					callId: 'call-1',
					outcome,
					status: outcome === 'succeeded' ? 200 : null,
					errorClass: outcome === 'succeeded' ? null : 'consent-missing',
					body: {
						results: [
							{
								link: 'https://search.example.org/a',
								name: 'Result A',
								description: 'First',
							},
							{ title: 'No link' },
						],
					},
				};
			},
		};
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({
				adapter: 'connector',
				connectorInstanceId: 'instance-search',
			}),
			calls,
		});

		const answer = await service.search({
			tenantId: TENANT,
			query: 'acme',
			limit: 5,
			caller: 'member',
			callerRef: MEMBER,
		});
		expect(requests).toEqual([
			expect.objectContaining({
				tenantId: TENANT,
				instanceId: 'instance-search',
				operation: 'search',
				input: { q: 'acme', limit: 5 },
				caller: 'test',
				callerRef: MEMBER,
			}),
		]);
		expect(answer.results).toEqual([
			expect.objectContaining({
				url: 'https://search.example.org/a',
				title: 'Result A',
				snippet: 'First',
				source: 'search.example.org',
			}),
		]);

		outcome = 'refused';
		await expect(
			service.search({
				tenantId: TENANT,
				query: 'acme',
				caller: 'agent',
				callerRef: 'run-9',
			}),
		).rejects.toMatchObject({ code: 'RESEARCH_CONNECTOR_FAILED', status: 502 });
		expect(requests.at(-1)).toMatchObject({
			caller: 'agent',
			callerRef: 'run-9',
		});
		expect(await shared.repository.listQueries(TENANT, 10, null)).toHaveLength(
			1,
		);

		/* A result whose URL only fits before percent-encoding is dropped, so the
		   write never fails after the unit was reserved. */
		outcome = 'succeeded';
		const long = await researchService({
			repository: shared.repository,
			settings: testSettings({
				adapter: 'connector',
				connectorInstanceId: 'instance-search',
			}),
			calls: {
				call: async () => ({
					callId: 'call-2',
					outcome: 'succeeded',
					status: 200,
					errorClass: null,
					body: [
						{
							url:
								'https://search.example.org/' +
								String.fromCodePoint(0xe9).repeat(1_000),
						},
						{ url: 'https://search.example.org/short', title: 'Short' },
					],
				}),
			},
		}).search({ tenantId: TENANT, query: 'long', caller: 'member' });
		expect(long.results.map((result) => result.url)).toEqual([
			'https://search.example.org/short',
		]);

		const unconfigured = researchService({
			repository: shared.repository,
			settings: testSettings({ adapter: 'connector' }),
			calls,
		});
		await expect(
			unconfigured.search({
				tenantId: TENANT,
				query: 'acme',
				caller: 'member',
			}),
		).rejects.toMatchObject({ code: 'RESEARCH_ADAPTER_UNAVAILABLE' });
	});

	it('RESEARCH-BUDGET refuses past the monthly budget and when metering refuses, before the adapter is called', async () => {
		let adapterCalls = 0;
		const calls: ConnectorCalls = {
			call: async () => {
				adapterCalls += 1;
				return {
					callId: 'c',
					outcome: 'succeeded',
					status: 200,
					errorClass: null,
					body: [],
				};
			},
		};
		const meters = fakeMeters();
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({
				adapter: 'connector',
				connectorInstanceId: 'instance-search',
				monthlyQueryBudget: 2,
			}),
			calls,
			meters,
		});
		const search = {
			tenantId: TENANT,
			query: 'acme',
			caller: 'member',
		} as const;

		await service.search(search);
		await service.search(search);
		await expect(service.search(search)).rejects.toMatchObject({
			code: 'RESEARCH_BUDGET_EXCEEDED',
			status: 429,
		});
		expect(adapterCalls).toBe(2);

		await shared.reset();
		meters.refuse = true;
		await expect(service.search(search)).rejects.toMatchObject({
			code: 'RESEARCH_BUDGET_EXCEEDED',
		});
		expect(adapterCalls).toBe(2);
		expect(await shared.repository.listQueries(TENANT, 10, null)).toEqual([]);
	});

	it('RESEARCH-BUDGET never lets concurrent searches pass the budget together', async () => {
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({
				recordedFixturesPath: fixtures.path,
				monthlyQueryBudget: 3,
			}),
		});
		const outcomes = await Promise.allSettled(
			Array.from({ length: 8 }, () =>
				service.search({
					tenantId: TENANT,
					query: 'acme insurance',
					caller: 'member',
				}),
			),
		);
		expect(
			outcomes.filter((outcome) => outcome.status === 'fulfilled'),
		).toHaveLength(3);
		expect(await shared.repository.monthUsage(TENANT, 0)).toBe(3);
	});
});
