import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import {
	createModuleSettingsRuntime,
	type ModuleSettingsRuntime,
	type ModuleSettingsStore,
} from '@flowdular/kernel';
import { RESEARCH_PERMISSIONS } from '../src/acl/permissions.ts';
import type { ResearchAdaptersOverview } from '../src/domain/types.ts';
import {
	readResearchSettings,
	RESEARCH_MODULE_SETTINGS,
} from '../src/settings.ts';
import { failed, stubConnectors, succeeded } from './support/connectors.ts';
import {
	openHarness,
	type Harness,
	type Workspace,
} from './support/harness.ts';
import { fakeEgress, INSTANT_CHAIN } from './support/service.ts';

const SLUG = 'research-adapters';
const PASSWORD_SECRET = ' correct-horse-9f3a ';
const FIRECRAWL_SECRET = 'fc-6b1d0c9e44f2';

let harness: Harness;
let owner: Workspace;
let member: Workspace;
let settings: ModuleSettingsRuntime;
let stub: ReturnType<typeof stubConnectors>;
let tenantId = '';
const logged: string[] = [];
const written: string[] = [];

function memoryStore(): ModuleSettingsStore {
	const values = new Map<string, Record<string, string | number | boolean>>();
	return {
		load: async (tenant, moduleId) => ({
			...values.get(`${tenant}/${moduleId}`),
		}),
		save: async (record) => {
			const key = `${record.tenantId}/${record.moduleId}`;
			values.set(key, { ...values.get(key), [record.key]: record.value });
		},
		clear: async (tenant, moduleId, key) => {
			const stored = values.get(`${tenant}/${moduleId}`);
			if (stored) delete stored[key];
		},
	};
}

beforeAll(async () => {
	for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			logged.push(args.map((arg) => String(arg)).join(' '));
		});
	}
	settings = createModuleSettingsRuntime(memoryStore());
	settings.declare(RESEARCH_MODULE_SETTINGS);
	stub = stubConnectors();
	let current = await readResearchSettings(settings, 'bootstrap');
	harness = await openHarness(() => current, {
		settings: async (tenant) => {
			current = await readResearchSettings(settings, tenant);
			return current;
		},
		writeSetting: (tenant, key, value, actor) => {
			written.push(key);
			return settings.set(tenant, 'research.core', key, value, actor);
		},
		calls: () => stub.calls,
		instances: () => stub.instances,
		egress: () => fakeEgress(),
		chain: INSTANT_CHAIN,
	});
	owner = await harness.signUp('owner@adapters.example', SLUG);
	tenantId = owner.tenantId;
	await settings.prime(tenantId);
	member = await harness.member(owner, SLUG, 'member@adapters.example', [
		RESEARCH_PERMISSIONS.read,
		RESEARCH_PERMISSIONS.run,
	]);
});

afterEach(() => {
	stub.answer(() => succeeded({ results: [] }));
});

afterAll(async () => {
	vi.restoreAllMocks();
	await harness?.dispose();
});

const post = (path: string, session: Workspace | undefined, body: unknown) =>
	harness.call(path, {
		method: 'POST',
		session,
		body,
		...(session ? { csrfToken: session.csrfToken } : {}),
	});

async function overviewOf(
	response: Response,
): Promise<ResearchAdaptersOverview> {
	expect(response.status).toBe(200);
	return ((await response.json()) as { adapters: ResearchAdaptersOverview })
		.adapters;
}

describe('RESEARCH-ADAPTER-CONFIGURATION owner routes', () => {
	it('refuses anonymous callers and members before anything is read or written', async () => {
		const anonymous = await Promise.all([
			harness.call('/api/research/adapters'),
			post('/api/research/settings', undefined, { fallback: 'fail' }),
			post('/api/research/adapters/configure', undefined, {
				adapter: 'searxng',
			}),
			post('/api/research/adapters/test', undefined, {
				adapter: 'searxng',
				query: 'acme',
			}),
			harness.call('/api/research/queries/some-id/attempts'),
		]);
		expect(anonymous.map((response) => response.status)).toEqual([
			401, 401, 401, 401, 401,
		]);

		const refused = await Promise.all([
			harness.call('/api/research/adapters', { session: member }),
			post('/api/research/settings', member, { fallback: 'fail' }),
			post('/api/research/adapters/configure', member, {
				adapter: 'searxng',
				baseUrl: 'https://search.example.org',
			}),
			post('/api/research/adapters/test', member, {
				adapter: 'searxng',
				query: 'acme',
			}),
		]);
		expect(refused.map((response) => response.status)).toEqual([
			403, 403, 403, 403,
		]);
		expect(stub.upserts).toEqual([]);
		expect(stub.requests).toEqual([]);
		expect(settings.get(tenantId, 'research.core', 'fallback')).toBe(
			'next-adapter',
		);

		const noProof = await harness.call('/api/research/settings', {
			method: 'POST',
			session: owner,
			body: { fallback: 'fail' },
		});
		expect(noProof.status).toBe(403);
		expect(settings.get(tenantId, 'research.core', 'fallback')).toBe(
			'next-adapter',
		);
	});

	it('configures SearXNG and Firecrawl with sealed credentials that no answer or log line carries', async () => {
		const initial = await overviewOf(
			await harness.call('/api/research/adapters', { session: owner }),
		);
		expect(initial.legacy).toBe(true);
		expect(
			initial.search.map((view) => [view.key, view.enabled, view.status]),
		).toEqual([
			['model-native', true, 'ready'],
			['searxng', false, 'not-configured'],
			['firecrawl', false, 'not-configured'],
			['connector', false, 'not-configured'],
			['recorded', false, 'not-configured'],
		]);

		const searxng = await post('/api/research/adapters/configure', owner, {
			adapter: 'searxng',
			baseUrl: 'https://search.example.org/searxng',
			credential: {
				kind: 'basic',
				username: 'research',
				password: PASSWORD_SECRET,
			},
			maxAttempts: 3,
			timeoutMs: 8_000,
		});
		const searxngText = await searxng.clone().text();
		const afterSearxng = await overviewOf(searxng);
		const basic = Buffer.from(`research:${PASSWORD_SECRET}`).toString('base64');
		expect(stub.upserts.at(-1)).toMatchObject({
			tenantId,
			moduleId: 'research.core',
			key: 'searxng',
			definition: 'research-searxng',
			baseUrl: 'https://search.example.org/searxng',
			allowedHosts: ['search.example.org'],
			allowAgents: false,
			allowWorkflows: false,
			actor: owner.accountId,
		});
		expect(stub.sealed.get(`${tenantId}/research.core/searxng`)).toEqual({
			kind: 'api-key',
			header: 'authorization',
			value: `Basic ${basic}`,
		});
		expect(
			afterSearxng.search.find((view) => view.key === 'searxng'),
		).toMatchObject({
			status: 'ready',
			maxAttempts: 3,
			timeoutMs: 8_000,
			configuration: {
				baseUrl: 'https://search.example.org/searxng',
				authKind: 'api-key',
				hasCredentials: true,
			},
		});

		const firecrawl = await post('/api/research/adapters/configure', owner, {
			adapter: 'firecrawl',
			credential: { kind: 'bearer', token: FIRECRAWL_SECRET },
		});
		const firecrawlText = await firecrawl.clone().text();
		const afterFirecrawl = await overviewOf(firecrawl);
		expect(stub.upserts.at(-1)).toMatchObject({
			key: 'firecrawl',
			baseUrl: 'https://api.firecrawl.dev',
			allowedHosts: ['api.firecrawl.dev'],
		});
		expect(
			afterFirecrawl.fetch.map((view) => [view.key, view.enabled, view.status]),
		).toEqual([
			['direct', true, 'ready'],
			['firecrawl', false, 'ready'],
		]);

		/* Saving again without a credential keeps the one connectors.core holds. */
		await overviewOf(
			await post('/api/research/adapters/configure', owner, {
				adapter: 'firecrawl',
				timeoutMs: 20_000,
			}),
		);
		expect(stub.upserts.at(-1)).not.toHaveProperty('credentials');
		expect(stub.sealed.get(`${tenantId}/research.core/firecrawl`)).toEqual({
			kind: 'bearer',
			token: FIRECRAWL_SECRET,
		});

		const read = await (
			await harness.call('/api/research/adapters', { session: owner })
		).text();
		for (const text of [searxngText, firecrawlText, read, logged.join('\n')]) {
			expect(text).not.toContain(PASSWORD_SECRET.trim());
			expect(text).not.toContain(basic);
			expect(text).not.toContain(FIRECRAWL_SECRET);
		}

		const invalid = await post('/api/research/adapters/configure', owner, {
			adapter: 'firecrawl',
			credential: { kind: 'basic', username: 'a', password: 'b' },
		});
		expect(invalid.status).toBe(400);
		expect(
			((await invalid.json()) as { error: { code: string } }).error.code,
		).toBe('INVALID_INPUT');
	});

	it('writes the chain settings as validated, refuses an empty fetch order whole, and runs a test query through one adapter', async () => {
		const refused = await post('/api/research/settings', owner, {
			fallback: 'fail',
			fetchOrder: [],
		});
		expect(refused.status).toBe(400);
		expect(settings.get(tenantId, 'research.core', 'fallback')).toBe(
			'next-adapter',
		);

		written.length = 0;
		const saved = await overviewOf(
			await post('/api/research/settings', owner, {
				searchOrder: [
					'searxng',
					'firecrawl',
					'model-native',
					'connector',
					'recorded',
				],
				enabled: {
					searxng: true,
					firecrawl: false,
					'model-native': false,
					connector: false,
					recorded: false,
				},
				fetchOrder: ['direct', 'firecrawl'],
				fallback: 'fail',
				fallbackOnEmpty: false,
				retryBackoffMs: 0,
				circuitFailureThreshold: 3,
				circuitCooldownMs: 120_000,
			}),
		);
		expect(saved.legacy).toBe(false);
		/* The switches land before the order that makes them count. */
		expect(written.indexOf('searchOrder')).toBeGreaterThan(
			Math.max(
				...written.map((key, index) => (key.endsWith('Enabled') ? index : -1)),
			),
		);
		expect(written.filter((key) => key.endsWith('Enabled'))).toHaveLength(5);
		expect(saved.search.map((view) => [view.key, view.enabled])).toEqual([
			['searxng', true],
			['firecrawl', false],
			['model-native', false],
			['connector', false],
			['recorded', false],
		]);
		expect(saved.fetch.map((view) => [view.key, view.enabled])).toEqual([
			['direct', true],
			['firecrawl', true],
		]);
		expect(saved.reliability).toEqual({
			fallback: 'fail',
			fallbackOnEmpty: false,
			retryBackoffMs: 0,
			circuitFailureThreshold: 3,
			circuitCooldownMs: 120_000,
		});
		expect(settings.get(tenantId, 'research.core', 'searchOrder')).toBe(
			'searxng,firecrawl,model-native,connector,recorded',
		);

		stub.answer(() =>
			succeeded({
				results: [
					{ url: 'https://news.example.org/acme', title: 'Acme', content: 'A' },
				],
			}),
		);
		const tested = await post('/api/research/adapters/test', owner, {
			adapter: 'searxng',
			query: 'acme',
		});
		expect(tested.status).toBe(200);
		const result = (
			(await tested.json()) as {
				test: {
					outcome: string;
					resultCount: number;
					durationMs: number;
					attempts: { adapter: string; outcome: string }[];
				};
			}
		).test;
		expect(result).toMatchObject({
			outcome: 'ok',
			resultCount: 1,
			attempts: [
				expect.objectContaining({ adapter: 'searxng', outcome: 'ok' }),
			],
		});
		expect(result.durationMs).toBeGreaterThanOrEqual(0);

		stub.answer(() => failed(403));
		const disabled = (
			(await (
				await post('/api/research/adapters/test', owner, {
					adapter: 'searxng',
					query: 'acme json',
				})
			).json()) as { test: { outcome: string; errorCode: string } }
		).test;
		expect(disabled).toMatchObject({
			outcome: 'failed',
			errorCode: 'RESEARCH_SEARXNG_JSON_DISABLED',
		});

		const queries = (await (
			await harness.call('/api/research/queries', { session: member })
		).json()) as { items: { id: string; adapter: string }[] };
		expect(queries.items).toEqual([
			expect.objectContaining({ adapter: 'searxng' }),
		]);
		const attempts = await harness.call(
			`/api/research/queries/${queries.items[0]!.id}/attempts`,
			{ session: member },
		);
		expect(attempts.status).toBe(200);
		expect(
			(
				(await attempts.json()) as {
					attempts: { adapter: string; outcome: string }[];
				}
			).attempts,
		).toEqual([expect.objectContaining({ adapter: 'searxng', outcome: 'ok' })]);
	});

	it('moves the consent of the module instances with allowAgents', async () => {
		await settings.set(
			tenantId,
			'research.core',
			'allowAgents',
			true,
			owner.accountId,
		);
		const before = stub.upserts.length;

		await harness.research.admin.syncConsent(tenantId, owner.accountId);

		const synced = stub.upserts.slice(before);
		expect(
			synced.map((entry) => [
				entry.key,
				entry.allowAgents,
				entry.allowWorkflows,
			]),
		).toEqual([
			['searxng', true, true],
			['firecrawl', true, true],
		]);
		expect(synced.every((entry) => entry.credentials === undefined)).toBe(true);
		await harness.research.admin.syncConsent(tenantId, owner.accountId);
		expect(stub.upserts).toHaveLength(before + 2);
	});
});
