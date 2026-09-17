import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	createModuleSettingsRuntime,
	type ModuleSettingsStore,
} from '@flowdular/kernel';
import type { PlatformServerContext } from '@flowdular/module-auth/server';
import { runListExport, type DefinedListExport } from '@flowdular/server';
import { RESEARCH_PERMISSIONS } from '../src/acl/permissions.ts';
import { createServerComposition } from '../src/platform.ts';
import { researchListExports } from '../src/services/list-exports.ts';
import {
	readResearchSettings,
	RESEARCH_MODULE_SETTINGS,
} from '../src/settings.ts';
import manifest from '../module.json' with { type: 'json' };
import {
	openResearchTestDatabase,
	type ResearchTestDatabase,
} from './support/database.ts';
import { stubConnectors } from './support/connectors.ts';
import { researchService } from './support/service.ts';

function context(
	present: ReadonlySet<string>,
	overrides: {
		readonly settings?: unknown;
		readonly capabilities?: Readonly<Record<string, unknown>>;
	} = {},
) {
	const registered = new Map<string, unknown>();
	const declaredMeters: unknown[] = [];
	const lists: { moduleId: string; exports: readonly DefinedListExport[] }[] =
		[];
	const tools: { id: string }[] = [];
	const native: { id: string }[] = [];
	const classes: string[] = [];
	const value = {
		environment: { NODE_ENV: 'test' },
		workspaceRoot: process.cwd(),
		auth: { service: async () => ({}) },
		settings: overrides.settings ?? { onChange: () => () => undefined },
		databases: {
			acquire: () => Promise.reject(new Error('No database in this case.')),
			dispose: () => Promise.resolve(),
		},
		agentTools: {
			register: (entries: readonly { id: string }[]) => tools.push(...entries),
			registerNative: (entry: { id: string }) => native.push(entry),
		},
		dataClasses: {
			declare: (moduleId: string, declared: readonly { key: string }[]) =>
				classes.push(...declared.map((entry) => `${moduleId}.${entry.key}`)),
		},
		capabilities: {
			register: (id: string, capability: unknown) =>
				registered.set(id, capability),
			get: (id: string) => {
				if (!present.has(id)) return null;
				if (overrides.capabilities?.[id]) return overrides.capabilities[id];
				if (id === 'metering.meters.v1') {
					return {
						declare: (_: string, meters: unknown) =>
							declaredMeters.push(meters),
					};
				}
				if (id === 'exports.lists.v1') {
					return {
						register: (
							moduleId: string,
							exports: readonly DefinedListExport[],
						) => lists.push({ moduleId, exports }),
					};
				}
				return {};
			},
		},
	};
	return {
		context: value as unknown as PlatformServerContext,
		registered,
		declaredMeters,
		lists,
		tools,
		native,
		classes,
	};
}

let shared: ResearchTestDatabase;

beforeAll(async () => {
	shared = await openResearchTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

describe('research.core composition', () => {
	it('publishes its capabilities, tools, native tool, data classes, settings and routes', () => {
		const platform = context(new Set());
		const composition = createServerComposition(platform.context);

		expect([...platform.registered.keys()]).toEqual(manifest.provides);
		expect(platform.tools.map((tool) => tool.id)).toEqual([
			'research.search',
			'research.fetch',
		]);
		expect(platform.native.map((tool) => tool.id)).toEqual([
			'research.web-search',
		]);
		expect(platform.classes).toEqual([
			'research.core.evidence',
			'research.core.attempts',
			'research.core.queries',
			'research.core.pages',
		]);
		expect(composition.settings).toBe(RESEARCH_MODULE_SETTINGS);
		expect(composition.routes.map((route) => route.path)).toEqual([
			'/api/research/evidence',
			'/api/research/evidence/attach',
			'/api/research/evidence/:id',
			'/api/research/queries',
			'/api/research/search',
			'/api/research/fetch',
			'/api/research/queries/:id/attempts',
			'/api/research/adapters',
			'/api/research/settings',
			'/api/research/adapters/configure',
			'/api/research/adapters/test',
		]);
		composition.start?.();
		expect(platform.declaredMeters).toEqual([]);
		expect(platform.lists).toEqual([]);
	});

	it('RESEARCH-EXPORT declares the meter and registers the evidence export once, at composition or at start', () => {
		const early = context(new Set(['metering.meters.v1', 'exports.lists.v1']));
		const composed = createServerComposition(early.context);
		composed.start?.();
		expect(early.declaredMeters).toEqual([
			[
				{
					key: 'queries',
					label: 'Research queries',
					labelKey: 'research.meter.queries',
					unit: 'queries',
					unitKey: 'research.meter.queries.unit',
					kind: 'cumulative',
				},
			],
		]);
		expect(
			early.lists.map((entry) => [
				entry.moduleId,
				entry.exports.map((e) => [e.id, e.permission]),
			]),
		).toEqual([
			[
				'research.core',
				[['research.core.evidence', RESEARCH_PERMISSIONS.read]],
			],
		]);
	});

	it('RESEARCH-EXPORT walks every evidence row of the workspace once with formula-like cells neutralised', async () => {
		const service = researchService({ repository: shared.repository });
		for (let index = 0; index < 5; index += 1) {
			await shared.repository.insertEvidence({
				tenantId: 'tenant-export',
				id: `evidence-${index}`,
				url: `https://a.example.org/${index}`,
				title: index === 0 ? '=HYPERLINK("x")' : `Title ${index}`,
				excerpt: 'Excerpt',
				contentSha256: 'd'.repeat(64),
				retrievedAt: 1_000 + index,
				runId: null,
				documentId: null,
				createdBy: null,
				fullText: null,
			});
		}
		await shared.repository.insertEvidence({
			tenantId: 'tenant-other',
			id: 'evidence-other',
			url: 'https://other.example.org/',
			title: 'Other',
			excerpt: 'Other',
			contentSha256: 'e'.repeat(64),
			retrievedAt: 1,
			runId: null,
			documentId: null,
			createdBy: null,
			fullText: null,
		});
		const [definition] = researchListExports(async () => service);

		const result = await runListExport({
			definition: definition!,
			principal: { accountId: 'a', tenantId: 'tenant-export', scopes: [] },
			bounds: { maxRows: 100, maxBytes: 1_000_000, pageLimit: 2 },
		});

		const text = Buffer.from(result.body).toString('utf8');
		expect(result.rows).toBe(5);
		expect(result.pages).toBe(3);
		expect(text).toContain(`'=HYPERLINK`);
		expect(text).not.toContain('other.example.org');
		for (let index = 0; index < 5; index += 1) {
			expect(text.split(`https://a.example.org/${index}`)).toHaveLength(2);
		}
	});

	it('RESEARCH-ADAPTER-CONFIGURATION registers both connector definitions and moves the instance consent when allowAgents changes anywhere', async () => {
		const stub = stubConnectors();
		const values = new Map<string, Record<string, string | number | boolean>>();
		const settings = createModuleSettingsRuntime({
			load: async (tenantId, moduleId) => ({
				...values.get(`${tenantId}/${moduleId}`),
			}),
			save: async (record) => {
				const key = `${record.tenantId}/${record.moduleId}`;
				values.set(key, { ...values.get(key), [record.key]: record.value });
			},
			clear: async () => undefined,
		});
		settings.declare(RESEARCH_MODULE_SETTINGS);
		await settings.prime('tenant-consent');
		await stub.instances.upsertModuleInstance({
			tenantId: 'tenant-consent',
			moduleId: 'research.core',
			key: 'searxng',
			definition: 'research-searxng',
			baseUrl: 'https://search.example.org',
			allowedHosts: ['search.example.org'],
			allowAgents: false,
			allowWorkflows: false,
			actor: 'owner',
		});
		const platform = context(
			new Set(['connectors.definitions.v1', 'connectors.instances.v1']),
			{
				settings,
				capabilities: {
					'connectors.definitions.v1': stub.definitions,
					'connectors.instances.v1': stub.instances,
				},
			},
		);
		const composition = createServerComposition(platform.context);
		composition.start?.();
		expect(stub.definitions.get('research-searxng')?.moduleId).toBe(
			'research.core',
		);
		expect(stub.definitions.get('research-firecrawl')?.moduleId).toBe(
			'research.core',
		);

		await settings.set(
			'tenant-consent',
			'research.core',
			'allowAgents',
			true,
			'owner-account',
		);
		await vi.waitFor(() =>
			expect(stub.upserts.at(-1)).toMatchObject({
				key: 'searxng',
				allowAgents: true,
				allowWorkflows: true,
				actor: 'owner-account',
			}),
		);
		expect(stub.upserts).toHaveLength(2);

		await composition.dispose?.();
		await settings.set(
			'tenant-consent',
			'research.core',
			'allowAgents',
			false,
			'owner-account',
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(stub.upserts).toHaveLength(2);
	});

	it('reads the workspace settings live and parses the domain lists', async () => {
		const values = new Map<string, Record<string, string | number | boolean>>();
		const store: ModuleSettingsStore = {
			load: async (tenantId, moduleId) =>
				values.get(`${tenantId}/${moduleId}`) ?? {},
			save: async (record) => {
				const key = `${record.tenantId}/${record.moduleId}`;
				values.set(key, {
					...(values.get(key) ?? {}),
					[record.key]: record.value,
				});
			},
			clear: async () => undefined,
		};
		const settings = createModuleSettingsRuntime(store);
		settings.declare(RESEARCH_MODULE_SETTINGS);
		await settings.prime('tenant-settings');
		await settings.set(
			'tenant-settings',
			'research.core',
			'denyDomains',
			' *.Blocked.example, bad host, .other.example ',
			'owner',
		);

		const read = await readResearchSettings(settings, 'tenant-settings');

		expect(read).toMatchObject({
			adapter: 'model-native',
			monthlyQueryBudget: 500,
			storeFullText: false,
			fetchMaxBytes: 2_000_000,
			fetchTimeoutMs: 20_000,
			allowAgents: false,
			allowDomains: [],
			denyDomains: ['blocked.example', 'other.example'],
		});
	});
});
