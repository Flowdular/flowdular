import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { researchNativeTool } from '../src/agent/tools.ts';
import type { ResearchRuntime } from '../src/server/runtime.ts';
import { ResearchAdapterAdmin } from '../src/services/adapter-admin.ts';
import type { ChainAttempt } from '../src/services/adapter-chain.ts';
import {
	openResearchTestDatabase,
	type ResearchTestDatabase,
} from './support/database.ts';
import { failed, stubConnectors, succeeded } from './support/connectors.ts';
import {
	researchService,
	testSettings,
	writeFixtures,
	type Fixtures,
} from './support/service.ts';

const TENANT = 'tenant-chain';
const OTHER = 'tenant-chain-other';
const MEMBER = 'account-chain';

let shared: ResearchTestDatabase;
let fixtures: Fixtures;

beforeAll(async () => {
	shared = await openResearchTestDatabase();
	fixtures = await writeFixtures({
		queries: {
			acme: [
				{
					url: 'https://recorded.example.org/acme',
					title: 'Recorded',
					snippet: 'From the fixtures.',
					source: 'recorded.example.org',
				},
			],
		},
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

async function configure(
	stub: ReturnType<typeof stubConnectors>,
	tenantId: string,
	key: 'searxng' | 'firecrawl',
): Promise<void> {
	await stub.instances.upsertModuleInstance({
		tenantId,
		moduleId: 'research.core',
		key,
		definition: `research-${key}`,
		baseUrl:
			key === 'searxng'
				? 'https://search.example.org'
				: 'https://api.firecrawl.dev',
		allowedHosts: [],
		allowAgents: false,
		allowWorkflows: false,
		actor: 'owner',
	});
}

const SEARXNG_RESULT = {
	results: [
		{
			url: 'https://searxng.example.org/acme',
			title: 'From SearXNG',
			content: 'Found by SearXNG.',
			engine: 'duckduckgo',
		},
	],
};

describe('research search chain', () => {
	it('RESEARCH-CHAIN-ORDER follows searchOrder and the switches, and keeps the single adapter while the order is empty', async () => {
		const stub = stubConnectors();
		await configure(stub, TENANT, 'searxng');
		await configure(stub, TENANT, 'firecrawl');
		stub.answer(() => succeeded({ results: [] }));
		const chained = researchService({
			repository: shared.repository,
			settings: testSettings({
				searchOrder: ['firecrawl', 'searxng', 'recorded'],
				recordedFixturesPath: fixtures.path,
				limits: {
					firecrawl: { enabled: false },
					searxng: { enabled: true },
					recorded: { enabled: true },
				},
			}),
			calls: stub.calls,
			instances: stub.instances,
		});

		const answer = await chained.search(
			{ tenantId: TENANT, query: 'acme', caller: 'member', callerRef: MEMBER },
			MEMBER,
		);

		expect(answer.adapter).toBe('recorded');
		expect(stub.requests.map((request) => request.instanceId)).toEqual([
			`instance-searxng-${TENANT}`,
		]);
		expect(
			answer.attempts.map((attempt) => [attempt.adapter, attempt.outcome]),
		).toEqual([
			['searxng', 'empty'],
			['recorded', 'ok'],
		]);
		const [query] = await shared.repository.listQueries(TENANT, 10, null);
		expect(query).toMatchObject({ adapter: 'recorded', resultCount: 1 });
		expect(
			(await chained.listAttempts(TENANT, answer.queryId!)).map((attempt) => [
				attempt.kind,
				attempt.adapter,
				attempt.attempt,
				attempt.outcome,
			]),
		).toEqual([
			['search', 'searxng', 1, 'empty'],
			['search', 'recorded', 1, 'ok'],
		]);

		const legacy = researchService({
			repository: shared.repository,
			settings: testSettings({
				adapter: 'recorded',
				recordedFixturesPath: fixtures.path,
			}),
			calls: stub.calls,
			instances: stub.instances,
		});
		expect(
			(
				await legacy.search({
					tenantId: TENANT,
					query: 'acme',
					caller: 'member',
				})
			).adapter,
		).toBe('recorded');
		expect(stub.requests).toHaveLength(1);
	});

	it('keeps page reads on the recorded fixtures under the chain settings the sandbox preview pins', async () => {
		const pages = await writeFixtures({
			queries: {},
			pages: {
				'https://pinned.example.org/page': { title: 'Pinned', text: 'Offline' },
			},
		});
		try {
			const service = researchService({
				repository: shared.repository,
				settings: testSettings({
					adapter: 'recorded',
					searchOrder: ['recorded'],
					fetchOrder: ['direct'],
					recordedFixturesPath: pages.path,
					limits: { recorded: { enabled: true } },
				}),
			});
			const page = await service.fetch({
				tenantId: TENANT,
				url: 'https://pinned.example.org/page',
				caller: 'member',
			});
			expect(page).toMatchObject({ title: 'Pinned', text: 'Offline' });
			await expect(
				service.fetch({
					tenantId: TENANT,
					url: 'https://pinned.example.org/other',
					caller: 'member',
				}),
			).rejects.toMatchObject({ code: 'RESEARCH_PAGE_NOT_RECORDED' });
		} finally {
			await pages.dispose();
		}
	});

	it('RESEARCH-BUDGET-ONCE counts one unit for a query two retries and a fallback answered', async () => {
		const stub = stubConnectors();
		await configure(stub, TENANT, 'searxng');
		stub.answer(() => failed(503));
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({
				searchOrder: ['searxng', 'recorded'],
				recordedFixturesPath: fixtures.path,
				monthlyQueryBudget: 1,
				limits: {
					searxng: { enabled: true, maxAttempts: 2 },
					recorded: { enabled: true },
				},
			}),
			calls: stub.calls,
			instances: stub.instances,
		});
		const search = {
			tenantId: TENANT,
			query: 'acme',
			caller: 'member',
		} as const;

		const answer = await service.search(search);

		expect(answer.adapter).toBe('recorded');
		expect(
			answer.attempts.map((attempt) => [
				attempt.adapter,
				attempt.outcome,
				attempt.errorCode,
			]),
		).toEqual([
			['searxng', 'retryable', 'RESEARCH_CONNECTOR_FAILED'],
			['searxng', 'retryable', 'RESEARCH_CONNECTOR_FAILED'],
			['recorded', 'ok', null],
		]);
		expect(await shared.repository.monthUsage(TENANT, 0)).toBe(1);
		const [query] = await shared.repository.listQueries(TENANT, 10, null);
		expect(query).toMatchObject({ adapter: 'recorded', costUnits: 1 });

		await expect(service.search(search)).rejects.toMatchObject({
			code: 'RESEARCH_BUDGET_EXCEEDED',
			status: 429,
		});
		expect(stub.requests).toHaveLength(2);
		expect(await shared.repository.monthUsage(TENANT, 0)).toBe(1);
	});

	it('releases the unit and keeps the attempts when no adapter answers', async () => {
		const stub = stubConnectors();
		await configure(stub, TENANT, 'searxng');
		stub.answer(() => failed(401));
		const attempts: ChainAttempt[] = [];
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({
				searchOrder: ['searxng'],
				limits: { searxng: { enabled: true } },
			}),
			calls: stub.calls,
			instances: stub.instances,
		});

		await expect(
			service.search(
				{ tenantId: TENANT, query: 'acme', caller: 'member' },
				null,
				{ attempts },
			),
		).rejects.toMatchObject({ code: 'RESEARCH_ADAPTER_UNAUTHORIZED' });

		expect(stub.requests).toHaveLength(1);
		expect(await shared.repository.listQueries(TENANT, 10, null)).toEqual([]);
		const stored = await shared.runtime.transaction(
			(transaction) =>
				transaction.query<{ outcome: string; error_code: string }>({
					text: 'SELECT outcome, error_code FROM research_attempts',
				}),
			{ access: 'read', tenantId: TENANT },
		);
		expect(stored.rows).toEqual([
			{ outcome: 'permanent', error_code: 'RESEARCH_ADAPTER_UNAUTHORIZED' },
		]);
		expect(attempts).toHaveLength(1);
	});

	it('RESEARCH-NATIVE-UNSUPPORTED treats a provider report of NATIVE_TOOL_UNSUPPORTED as unsupported and a permanent failure the chain passes over', async () => {
		const settings = testSettings({
			searchOrder: ['model-native', 'recorded'],
			recordedFixturesPath: fixtures.path,
			limits: {
				'model-native': { enabled: true },
				recorded: { enabled: true },
			},
		});
		const service = researchService({
			repository: shared.repository,
			settings,
		});
		const tool = researchNativeTool({
			service: async () => service,
		} as unknown as ResearchRuntime);
		const admin = new ResearchAdapterAdmin({
			service: async () => service,
			settings: async () => settings,
			instances: () => undefined,
			calls: () => undefined,
			egress: () => undefined,
		});
		const context = {
			tenantId: TENANT,
			runId: 'run-unsupported',
			requestedBy: MEMBER,
		} as never;

		await tool.record!(
			{
				query: null,
				results: [],
				unsupported: {
					code: 'NATIVE_TOOL_UNSUPPORTED',
					detail: 'PROVIDER_WEB_SEARCH_DISABLED',
				},
			},
			context,
		);

		expect((await admin.overview(TENANT)).search[0]).toMatchObject({
			key: 'model-native',
			status: 'unsupported',
			lastErrorCode: 'NATIVE_TOOL_UNSUPPORTED',
		});
		const answer = await service.search({
			tenantId: TENANT,
			query: 'acme',
			caller: 'agent',
			callerRef: 'run-unsupported',
		});
		expect(answer.adapter).toBe('recorded');
		expect(
			answer.attempts.map((attempt) => [
				attempt.adapter,
				attempt.outcome,
				attempt.errorCode,
			]),
		).toEqual([
			['model-native', 'permanent', 'NATIVE_TOOL_UNSUPPORTED'],
			['recorded', 'ok', null],
		]);
		expect((await service.adapterHealth(TENANT))[0]).toMatchObject({
			consecutiveFailures: 1,
		});

		await tool.record!(
			{
				query: 'acme',
				results: [
					{
						url: 'https://native.example.org/acme',
						title: 'Native',
						snippet: 'From the provider.',
						source: 'native.example.org',
					},
				],
			},
			context,
		);
		expect((await admin.overview(TENANT)).search[0]).toMatchObject({
			status: 'ready',
		});
		const readBack = await service.search({
			tenantId: TENANT,
			query: 'acme',
			caller: 'agent',
			callerRef: 'run-unsupported',
		});
		expect(readBack.adapter).toBe('model-native');
		const nativeId = await shared.repository.nativeQueryId(
			TENANT,
			'run-unsupported',
			'acme',
		);
		expect(
			(await service.listAttempts(TENANT, nativeId!)).map((attempt) => [
				attempt.adapter,
				attempt.outcome,
			]),
		).toEqual([['model-native', 'ok']]);
	});

	it('RESEARCH-CIRCUIT hands a probe back in the database only while the probe still holds it', async () => {
		const repository = shared.repository;
		await repository.recordAdapterFailure(
			TENANT,
			'searxng',
			'X_FAILED',
			1_000,
			1,
			500,
		);
		expect(
			await repository.claimAdapterProbe(TENANT, 'searxng', 2_000, 2_500),
		).toBe(true);
		await repository.releaseAdapterProbe(TENANT, 'searxng', 2_500, 1_500);
		expect((await repository.adapterHealth(TENANT))[0]?.openUntil).toBe(1_500);

		expect(
			await repository.claimAdapterProbe(TENANT, 'searxng', 3_000, 3_500),
		).toBe(true);
		await repository.recordAdapterFailure(
			TENANT,
			'searxng',
			'X_FAILED',
			3_100,
			1,
			500,
		);
		await repository.releaseAdapterProbe(TENANT, 'searxng', 3_500, 1_500);
		expect((await repository.adapterHealth(TENANT))[0]?.openUntil).toBe(3_600);
	});

	it('RESEARCH-CIRCUIT opens after the threshold, lets one probe through after the cooldown and stays per workspace', async () => {
		let clock = Date.parse('2026-09-16T10:00:00Z');
		const stub = stubConnectors();
		await configure(stub, TENANT, 'searxng');
		await configure(stub, OTHER, 'searxng');
		let searxngWorks = false;
		stub.answer(() => (searxngWorks ? succeeded(SEARXNG_RESULT) : failed(401)));
		const service = researchService({
			repository: shared.repository,
			now: () => clock,
			settings: testSettings({
				searchOrder: ['searxng', 'recorded'],
				recordedFixturesPath: fixtures.path,
				circuitFailureThreshold: 2,
				circuitCooldownMs: 60_000,
				limits: {
					searxng: { enabled: true },
					recorded: { enabled: true },
				},
			}),
			calls: stub.calls,
			instances: stub.instances,
		});
		const search = (tenantId: string) =>
			service.search({ tenantId, query: 'acme', caller: 'member' });

		await search(TENANT);
		await search(TENANT);
		expect(stub.requests).toHaveLength(2);
		const [health] = await service.adapterHealth(TENANT);
		expect(health).toEqual({
			adapter: 'searxng',
			consecutiveFailures: 2,
			openUntil: clock + 60_000,
			lastErrorCode: 'RESEARCH_ADAPTER_UNAUTHORIZED',
			lastSuccessAt: null,
		});

		const skipped = await search(TENANT);
		expect(stub.requests).toHaveLength(2);
		expect(skipped.attempts[0]).toMatchObject({
			adapter: 'searxng',
			attempt: 0,
			outcome: 'skipped-circuit',
		});
		await search(OTHER);
		expect(stub.requests).toHaveLength(3);

		clock += 60_000;
		searxngWorks = true;
		const probes = await Promise.all([search(TENANT), search(TENANT)]);
		expect(stub.requests).toHaveLength(4);
		expect(probes.map((answer) => answer.adapter).sort()).toEqual([
			'recorded',
			'searxng',
		]);
		expect((await service.adapterHealth(TENANT))[0]).toMatchObject({
			consecutiveFailures: 0,
			openUntil: null,
			lastErrorCode: 'RESEARCH_ADAPTER_UNAUTHORIZED',
			lastSuccessAt: clock,
		});
		await search(TENANT);
		expect(stub.requests).toHaveLength(5);
	});
});
