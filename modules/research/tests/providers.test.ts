import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	FIRECRAWL_DEFINITION,
	firecrawlSearchInput,
} from '../src/adapters/firecrawl.ts';
import { SEARXNG_DEFINITION } from '../src/adapters/searxng.ts';
import {
	openResearchTestDatabase,
	type ResearchTestDatabase,
} from './support/database.ts';
import { failed, stubConnectors, succeeded } from './support/connectors.ts';
import {
	fakeEgress,
	fakeTransport,
	researchService,
	testSettings,
} from './support/service.ts';

const TENANT = 'tenant-providers';
const MEMBER = 'account-providers';

let shared: ResearchTestDatabase;

beforeAll(async () => {
	shared = await openResearchTestDatabase();
});

afterEach(async () => {
	await shared.reset();
});

afterAll(async () => {
	await shared?.dispose();
});

async function configured(key: 'searxng' | 'firecrawl') {
	const stub = stubConnectors();
	await stub.instances.upsertModuleInstance({
		tenantId: TENANT,
		moduleId: 'research.core',
		key,
		definition: `research-${key}`,
		baseUrl:
			key === 'searxng'
				? 'https://search.example.org/searxng'
				: 'https://api.firecrawl.dev',
		allowedHosts: [],
		allowAgents: false,
		allowWorkflows: false,
		actor: 'owner',
	});
	return stub;
}

describe('SearXNG adapter', () => {
	it('declares its connector definition for research.core', () => {
		expect(SEARXNG_DEFINITION).toMatchObject({
			key: 'research-searxng',
			moduleId: 'research.core',
			authKinds: ['none', 'bearer', 'api-key'],
			operations: [{ key: 'search', method: 'GET', path: '/search' }],
			defaultAllowedHosts: [],
		});
	});

	it('RESEARCH-SEARXNG maps the request and the JSON answer and refuses a disabled JSON format permanently', async () => {
		const stub = await configured('searxng');
		stub.answer(() =>
			succeeded({
				query: 'acme',
				results: [
					{
						url: 'https://news.example.org/acme',
						title: 'Acme news',
						content: 'Acme grows.',
						publishedDate: '2026-09-10T00:00:00',
						engine: 'bing',
					},
					{ title: 'No address' },
				],
			}),
		);
		const service = researchService({
			repository: shared.repository,
			now: () => Date.parse('2026-09-16T00:00:00Z'),
			settings: testSettings({
				allowAgents: true,
				searchOrder: ['searxng'],
				limits: { searxng: { enabled: true } },
			}),
			calls: stub.calls,
			instances: stub.instances,
		});

		const answer = await service.search(
			{
				tenantId: TENANT,
				query: 'acme',
				freshness: 'month',
				site: 'example.org',
				caller: 'member',
				callerRef: MEMBER,
			},
			MEMBER,
		);

		expect(stub.requests).toEqual([
			expect.objectContaining({
				tenantId: TENANT,
				instanceId: `instance-searxng-${TENANT}`,
				operation: 'search',
				caller: 'test',
				callerRef: MEMBER,
				input: {
					query: {
						q: 'acme site:example.org',
						format: 'json',
						pageno: 1,
						categories: 'general',
						time_range: 'month',
					},
				},
			}),
		]);
		expect(answer.adapter).toBe('searxng');
		expect(answer.results).toEqual([
			expect.objectContaining({
				url: 'https://news.example.org/acme',
				title: 'Acme news',
				snippet: 'Acme grows.',
				publishedAt: '2026-09-10T00:00:00',
				source: 'bing',
			}),
		]);

		stub.answer(() => failed(403));
		await expect(
			service.search({
				tenantId: TENANT,
				query: 'acme',
				caller: 'agent',
				callerRef: 'run-1',
			}),
		).rejects.toMatchObject({ code: 'RESEARCH_SEARXNG_JSON_DISABLED' });
		expect(stub.requests).toHaveLength(2);
		expect(stub.requests[1]).toMatchObject({
			caller: 'agent',
			callerRef: 'run-1',
		});
	});

	it('retries a rate limited answer after the Retry-After it carried and refuses an unconfigured instance', async () => {
		const stub = await configured('searxng');
		let calls = 0;
		stub.answer(() => {
			calls += 1;
			return calls === 1 ? failed(429, 20) : succeeded({ results: [] });
		});
		const settings = testSettings({
			searchOrder: ['searxng'],
			limits: { searxng: { enabled: true } },
		});
		const service = researchService({
			repository: shared.repository,
			settings,
			calls: stub.calls,
			instances: stub.instances,
		});

		const answer = await service.search({
			tenantId: TENANT,
			query: 'acme',
			caller: 'member',
		});
		expect(
			answer.attempts.map((attempt) => [attempt.outcome, attempt.errorCode]),
		).toEqual([
			['retryable', 'RESEARCH_ADAPTER_RATE_LIMITED'],
			['empty', null],
		]);
		expect(stub.requests).toHaveLength(2);

		stub.answer(() => ({
			outcome: 'refused',
			status: null,
			errorClass: 'consent-missing',
			body: null,
		}));
		await expect(
			service.search({ tenantId: TENANT, query: 'acme', caller: 'member' }),
		).rejects.toMatchObject({ code: 'RESEARCH_CONNECTOR_FAILED' });
		expect(await service.adapterHealth(TENANT)).toEqual([
			expect.objectContaining({ adapter: 'searxng', consecutiveFailures: 0 }),
		]);

		const requests = stub.requests.length;
		await expect(
			service.search({
				tenantId: TENANT,
				query: 'acme',
				caller: 'workflow',
				callerRef: 'run-flow',
			}),
		).rejects.toMatchObject({ code: 'TOOL_NOT_CONSENTED' });
		expect(stub.requests).toHaveLength(requests);

		const bare = stubConnectors();
		await expect(
			researchService({
				repository: shared.repository,
				settings,
				calls: bare.calls,
				instances: bare.instances,
			}).search({ tenantId: TENANT, query: 'acme', caller: 'member' }),
		).rejects.toMatchObject({ code: 'RESEARCH_ADAPTER_UNAVAILABLE' });
		expect(bare.requests).toEqual([]);
	});
});

describe('Firecrawl adapter', () => {
	it('declares search and scrape on the v2 API', () => {
		expect(FIRECRAWL_DEFINITION).toMatchObject({
			key: 'research-firecrawl',
			moduleId: 'research.core',
			authKinds: ['bearer', 'none'],
			operations: [
				{ key: 'search', method: 'POST', path: '/v2/search' },
				{ key: 'scrape', method: 'POST', path: '/v2/scrape' },
			],
		});
		expect(
			firecrawlSearchInput(
				{ query: 'acme', limit: 5, freshness: null, site: null },
				15_000,
			),
		).toEqual({
			body: {
				query: 'acme',
				limit: 5,
				sources: [{ type: 'web' }],
				ignoreInvalidURLs: true,
				timeout: 15_000,
			},
		});
	});

	it('RESEARCH-FIRECRAWL searches through /v2/search and maps data.web', async () => {
		const stub = await configured('firecrawl');
		stub.answer(() =>
			succeeded({
				success: true,
				data: {
					web: [
						{
							url: 'https://web.example.org/acme',
							title: 'Acme on the web',
							description: 'A description.',
						},
					],
				},
				creditsUsed: 1,
			}),
		);
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({
				allowAgents: true,
				searchOrder: ['firecrawl'],
				limits: { firecrawl: { enabled: true, timeoutMs: 9_000 } },
			}),
			calls: stub.calls,
			instances: stub.instances,
		});

		const answer = await service.search({
			tenantId: TENANT,
			query: 'acme',
			limit: 3,
			freshness: 'week',
			site: 'web.example.org',
			caller: 'workflow',
			callerRef: 'run-flow',
		});

		expect(stub.requests).toEqual([
			expect.objectContaining({
				operation: 'search',
				caller: 'workflow',
				input: {
					body: {
						query: 'acme',
						limit: 3,
						sources: [{ type: 'web' }],
						ignoreInvalidURLs: true,
						timeout: 9_000,
						tbs: 'qdr:w',
						includeDomains: ['web.example.org'],
					},
				},
			}),
		]);
		expect(answer.results).toEqual([
			expect.objectContaining({
				url: 'https://web.example.org/acme',
				title: 'Acme on the web',
				snippet: 'A description.',
				source: 'web.example.org',
			}),
		]);

		stub.answer(() => failed(401));
		await expect(
			service.search({ tenantId: TENANT, query: 'acme', caller: 'member' }),
		).rejects.toMatchObject({ code: 'RESEARCH_ADAPTER_UNAUTHORIZED' });
	});

	it('RESEARCH-FIRECRAWL asks robots.txt first, keeps the markdown as evidence and refuses a page on a denied host', async () => {
		const stub = await configured('firecrawl');
		const order: string[] = [];
		const transport = fakeTransport({
			'https://blocked.example.org/robots.txt': {
				status: 200,
				contentType: 'text/plain',
				body: 'User-agent: *\nDisallow: /private',
			},
		});
		const calls = {
			call: async (request: Parameters<typeof stub.calls.call>[0]) => {
				order.push(
					`scrape ${String((request.input.body as { url: string }).url)}`,
				);
				return stub.calls.call(request);
			},
		};
		const page = (url: string) =>
			succeeded({
				success: true,
				data: {
					markdown: '# Acme\n\nRendered with JavaScript.',
					metadata: {
						title: 'Acme page',
						sourceURL: url,
						url,
						statusCode: 200,
						contentType: 'text/html',
					},
				},
			});
		stub.answer((request) => page((request.input.body as { url: string }).url));
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({
				adapter: 'model-native',
				fetchOrder: ['firecrawl'],
				denyDomains: ['denied.example'],
				limits: { firecrawl: { timeoutMs: 20_000 } },
			}),
			calls,
			instances: stub.instances,
			egress: fakeEgress(),
			transport: async (request) => {
				order.push(`transport ${request.url.toString()}`);
				return transport.transport(request);
			},
		});

		const fetched = await service.fetch(
			{
				tenantId: TENANT,
				url: 'https://pages.example.org/acme',
				caller: 'member',
				callerRef: MEMBER,
			},
			MEMBER,
		);

		expect(order).toEqual([
			'transport https://pages.example.org/robots.txt',
			'scrape https://pages.example.org/acme',
		]);
		expect(stub.requests[0]).toMatchObject({
			operation: 'scrape',
			caller: 'test',
			input: {
				body: {
					url: 'https://pages.example.org/acme',
					formats: ['markdown'],
					onlyMainContent: true,
					timeout: 20_000,
				},
			},
		});
		expect(fetched).toMatchObject({
			title: 'Acme page',
			text: '# Acme\n\nRendered with JavaScript.',
			truncated: false,
		});
		expect(
			(await service.listAttempts(TENANT, fetched.evidenceId)).map(
				(attempt) => [attempt.kind, attempt.adapter, attempt.outcome],
			),
		).toEqual([['fetch', 'firecrawl', 'ok']]);
		expect(
			await shared.repository.findPage(
				TENANT,
				'https://pages.example.org/acme',
				Date.now(),
			),
		).not.toBeNull();

		stub.answer(() => page('https://news.denied.example/moved'));
		await expect(
			service.fetch({
				tenantId: TENANT,
				url: 'https://pages.example.org/other',
				caller: 'member',
			}),
		).rejects.toMatchObject({ code: 'RESEARCH_DOMAIN_DENIED' });

		const scrapes = stub.requests.length;
		await expect(
			service.fetch({
				tenantId: TENANT,
				url: 'https://blocked.example.org/private/page',
				caller: 'member',
			}),
		).rejects.toMatchObject({ code: 'RESEARCH_ROBOTS_DISALLOWED' });
		expect(stub.requests).toHaveLength(scrapes);

		/* Firecrawl followed a redirect onto a path its robots.txt disallows. */
		stub.answer(() => page('https://blocked.example.org/private/moved'));
		await expect(
			service.fetch({
				tenantId: TENANT,
				url: 'https://pages.example.org/redirecting',
				caller: 'member',
			}),
		).rejects.toMatchObject({ code: 'RESEARCH_ROBOTS_DISALLOWED' });
		expect(await shared.repository.listEvidence(TENANT, 10, null)).toHaveLength(
			1,
		);
	});
});

describe('fetch chain', () => {
	const firecrawlPage = succeeded({
		success: true,
		data: {
			markdown: 'Rendered text',
			metadata: {
				title: 'Rendered',
				url: 'https://site.example.org/page',
				statusCode: 200,
			},
		},
	});

	it('RESEARCH-FETCH-CHAIN falls back to Firecrawl after the direct read times out on every attempt or reads no text', async () => {
		const stub = await configured('firecrawl');
		stub.answer(() => firecrawlPage);
		const hanging = fakeTransport({
			'https://site.example.org/page': (request) =>
				new Promise((_, reject) =>
					request.signal.addEventListener('abort', () =>
						reject(new Error('aborted')),
					),
				),
		});
		const settings = testSettings({
			adapter: 'model-native',
			fetchOrder: ['direct', 'firecrawl'],
			fetchTimeoutMs: 1_000,
			limits: { direct: { maxAttempts: 2 } },
		});
		const service = researchService({
			repository: shared.repository,
			settings,
			calls: stub.calls,
			instances: stub.instances,
			egress: fakeEgress(),
			transport: hanging.transport,
		});

		const fetched = await service.fetch({
			tenantId: TENANT,
			url: 'https://site.example.org/page',
			caller: 'member',
		});

		expect(fetched.text).toBe('Rendered text');
		expect(
			(await service.listAttempts(TENANT, fetched.evidenceId)).map(
				(attempt) => [
					attempt.adapter,
					attempt.attempt,
					attempt.outcome,
					attempt.errorCode,
				],
			),
		).toEqual([
			['direct', 1, 'retryable', 'RESEARCH_FETCH_TIMEOUT'],
			['direct', 2, 'retryable', 'RESEARCH_FETCH_TIMEOUT'],
			['firecrawl', 1, 'ok', null],
		]);

		await shared.reset();
		const blank = fakeTransport({
			'https://site.example.org/page': {
				body: '<html><head></head><body><script>render()</script></body></html>',
			},
		});
		const empty = await researchService({
			repository: shared.repository,
			settings,
			calls: stub.calls,
			instances: stub.instances,
			egress: fakeEgress(),
			transport: blank.transport,
		}).fetch({
			tenantId: TENANT,
			url: 'https://site.example.org/page',
			caller: 'member',
		});
		expect(empty.text).toBe('Rendered text');
	});

	it('RESEARCH-FETCH-CHAIN never falls back past a robots.txt refusal', async () => {
		const stub = await configured('firecrawl');
		stub.answer(() => firecrawlPage);
		const transport = fakeTransport({
			'https://site.example.org/robots.txt': {
				status: 200,
				contentType: 'text/plain',
				body: 'User-agent: *\nDisallow: /',
			},
		});
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({
				adapter: 'model-native',
				fetchOrder: ['direct', 'firecrawl'],
			}),
			calls: stub.calls,
			instances: stub.instances,
			egress: fakeEgress(),
			transport: transport.transport,
		});

		await expect(
			service.fetch({
				tenantId: TENANT,
				url: 'https://site.example.org/page',
				caller: 'member',
			}),
		).rejects.toMatchObject({ code: 'RESEARCH_ROBOTS_DISALLOWED' });
		expect(stub.requests).toEqual([]);
		expect(await shared.repository.listEvidence(TENANT, 10, null)).toEqual([]);
	});

	it('answers a scrape of a missing page as a page failure that never opens the circuit', async () => {
		const stub = await configured('firecrawl');
		stub.answer(() =>
			succeeded({
				success: true,
				data: { markdown: '', metadata: { statusCode: 404 } },
			}),
		);
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({
				adapter: 'model-native',
				fetchOrder: ['firecrawl'],
				circuitFailureThreshold: 1,
			}),
			calls: stub.calls,
			instances: stub.instances,
			egress: fakeEgress(),
			transport: fakeTransport({}).transport,
		});

		await expect(
			service.fetch({
				tenantId: TENANT,
				url: 'https://site.example.org/missing',
				caller: 'member',
			}),
		).rejects.toMatchObject({ code: 'RESEARCH_FETCH_FAILED' });
		expect(await service.adapterHealth(TENANT)).toEqual([]);
	});
});
