import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLATFORM_SETTINGS_TENANT } from '@flowdular/kernel';
import { runGates } from '../src/server/gates.ts';
import { resolvePreviewModules } from '../src/server/preview-modules.ts';
import { memorySettings } from '../src/server/preview-runtime.ts';
import { createIsolatedPreviewRuntime } from '../src/server/preview-worker-manager.ts';
import {
	LIVE_ADAPTER_REFUSED,
	liveAdapterRefusal,
	readSessionAdapters,
	recordedAdapterSettings,
} from '../src/server/recorded-adapters.ts';
import { createSession, sessionPaths } from '../src/server/sessions.ts';

const SPEC = `schemaVersion: 2
id: underwriting.core
specVersion: 0.1.0
status: draft
name: Underwriting
`;

const researchSpec = (adapter: string) =>
	`${SPEC}research:\n  adapter: ${adapter}\n  evidenceOwner: case\n`;

const adapterSpec = (recorded: string | null) =>
	`${SPEC}adapters:\n  - id: underwriting.core.broker-cases\n    direction: source\n    connector: http-json\n    operation: list\n    port: underwriting.core.cases\n${recorded === null ? '' : `    recorded: ${recorded}\n`}`;

async function sessionWithSpec(spec: string | null) {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-recorded-adapters-'));
	await writeFile(
		join(root, 'flowdular.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
		'utf8',
	);
	const session = await createSession({
		workspaceRoot: root,
		kind: 'new-module',
		moduleId: 'underwriting.core',
		title: 'Underwriting',
		brief: 'Research a company before an offer.',
		blueprint: 'new-module@1.0.0',
		role: 'business-manager',
		driver: 'fake',
		install: false,
	});
	const paths = sessionPaths(root, session.id, session.moduleSuffix);
	if (spec !== null) {
		await mkdir(join(paths.modulePath, 'spec'), { recursive: true });
		await writeFile(join(paths.modulePath, 'spec', 'module.yaml'), spec);
	}
	return { root, session, paths };
}

describe('recorded adapters in a session spec', () => {
	it('reads the research section and names live adapters', async () => {
		const recorded = await sessionWithSpec(researchSpec('recorded'));
		const location = [
			{
				directory: recorded.session.moduleSuffix,
				path: recorded.paths.modulePath,
			},
		];
		const adapters = await readSessionAdapters(location);
		expect(adapters).toEqual({
			research: {
				module: recorded.session.moduleSuffix,
				fixturesPath: join(recorded.paths.modulePath, 'research-fixtures.json'),
			},
			live: [],
		});
		expect(recordedAdapterSettings(adapters)).toEqual({
			'research.core': {
				adapter: 'recorded',
				searchOrder: 'recorded',
				recordedEnabled: true,
				fetchOrder: 'direct',
				recordedFixturesPath: join(
					recorded.paths.modulePath,
					'research-fixtures.json',
				),
			},
		});

		for (const adapter of [
			'model-native',
			'searxng',
			'firecrawl',
			'connector',
		]) {
			const live = await sessionWithSpec(researchSpec(adapter));
			const declared = (
				await readSessionAdapters([
					{ directory: 'underwriting', path: live.paths.modulePath },
				])
			).live;
			expect(declared).toEqual([
				{ module: 'underwriting', field: 'research.adapter', value: adapter },
			]);
			expect(liveAdapterRefusal(declared)).toContain(
				`${LIVE_ADAPTER_REFUSED}: a sandbox session may declare only recorded adapters.`,
			);
			expect(liveAdapterRefusal(declared)).toContain(
				`- modules/underwriting/spec/module.yaml research.adapter: ${adapter}`,
			);
		}

		const unrecorded = await sessionWithSpec(adapterSpec(null));
		expect(
			(
				await readSessionAdapters([
					{ directory: 'underwriting', path: unrecorded.paths.modulePath },
				])
			).live,
		).toMatchObject([
			{ field: 'adapters[underwriting.core.broker-cases].recorded' },
		]);
		const withFixture = await sessionWithSpec(
			adapterSpec('adapters/broker-cases.recorded.json'),
		);
		expect(
			await readSessionAdapters([
				{ directory: 'underwriting', path: withFixture.paths.modulePath },
			]),
		).toEqual({ research: null, live: [] });

		const unreadable = await sessionWithSpec('research: [unclosed\n');
		expect(
			await readSessionAdapters([
				{ directory: 'underwriting', path: unreadable.paths.modulePath },
			]),
		).toEqual({ research: null, live: [] });
	});

	it('fails the spec-schema gate with SANDBOX_LIVE_ADAPTER_REFUSED', async () => {
		const live = await sessionWithSpec(researchSpec('model-native'));
		const [refused] = await runGates({
			workspaceRoot: live.root,
			paths: live.paths,
			session: live.session,
			gates: ['spec-schema'],
		});
		expect(refused).toMatchObject({ id: 'spec-schema', status: 'failed' });
		expect(refused!.output).toMatch(
			new RegExp(
				`^${LIVE_ADAPTER_REFUSED}: .*\\n- modules/underwriting/spec/module.yaml research.adapter: model-native`,
			),
		);

		const recorded = await sessionWithSpec(researchSpec('recorded'));
		const [checked] = await runGates({
			workspaceRoot: recorded.root,
			paths: recorded.paths,
			session: recorded.session,
			gates: ['spec-schema'],
		});
		expect(checked!.output).not.toContain(LIVE_ADAPTER_REFUSED);
	}, 60_000);

	it('composes research.core ahead of the draft and refuses a live adapter before a worker starts', async () => {
		const support = await mkdtemp(join(tmpdir(), 'flowdular-support-'));
		for (const [directory, manifest] of [
			['system', { id: 'system.core' }],
			[
				'research',
				{ id: 'research.core', dependencies: [{ id: 'system.core' }] },
			],
		] as const) {
			await mkdir(join(support, directory), { recursive: true });
			await writeFile(
				join(support, directory, 'module.json'),
				JSON.stringify(manifest),
			);
		}
		const recorded = await sessionWithSpec(researchSpec('recorded'));
		expect(
			(
				await resolvePreviewModules(recorded.root, recorded.session, support)
			).map((module) => [module.id, module.support]),
		).toEqual([
			['system.core', true],
			['research.core', true],
			['underwriting.core', false],
		]);
		const plain = await sessionWithSpec(SPEC);
		expect(
			(await resolvePreviewModules(plain.root, plain.session, support)).map(
				(module) => module.id,
			),
		).toEqual(['underwriting.core']);

		for (const adapter of ['searxng', 'firecrawl']) {
			const paid = await sessionWithSpec(researchSpec(adapter));
			await expect(
				resolvePreviewModules(paid.root, paid.session, support),
			).rejects.toMatchObject({ code: LIVE_ADAPTER_REFUSED });
		}
		const live = await sessionWithSpec(researchSpec('connector'));
		await expect(
			resolvePreviewModules(live.root, live.session, support),
		).rejects.toMatchObject({ code: LIVE_ADAPTER_REFUSED });
		const lifecycle: string[] = [];
		const runtime = createIsolatedPreviewRuntime(live.root, {
			onWorkerLifecycle: (event) => lifecycle.push(event),
		});
		try {
			await expect(runtime.compose(live.session)).rejects.toMatchObject({
				code: LIVE_ADAPTER_REFUSED,
			});
			expect(lifecycle).toEqual([]);
		} finally {
			runtime.dispose();
		}
	});

	it('composes documents.core ahead of a draft that declares templates', async () => {
		const support = await mkdtemp(join(tmpdir(), 'flowdular-support-'));
		for (const [directory, manifest] of [
			['system', { id: 'system.core' }],
			[
				'documents',
				{
					id: 'documents.core',
					dependencies: [{ id: 'system.core' }, { id: 'auth.core' }],
				},
			],
		] as const) {
			await mkdir(join(support, directory), { recursive: true });
			await writeFile(
				join(support, directory, 'module.json'),
				JSON.stringify(manifest),
			);
		}
		const templated = await sessionWithSpec(
			`${SPEC}templates:\n  - id: offer\n    title: Offer\n    inputEntity: case\n    format: pdf\n    body: templates/offer.md\n`,
		);
		expect(
			(
				await resolvePreviewModules(templated.root, templated.session, support)
			).map((module) => [module.id, module.support]),
		).toEqual([
			['system.core', true],
			['documents.core', true],
			['underwriting.core', false],
		]);
		const empty = await sessionWithSpec(`${SPEC}templates: []\n`);
		expect(
			(await resolvePreviewModules(empty.root, empty.session, support)).map(
				(module) => module.id,
			),
		).toEqual(['underwriting.core']);
	});

	it('holds the recorded research settings in the preview for every workspace', async () => {
		const settings = memorySettings(
			recordedAdapterSettings({
				research: {
					module: 'underwriting',
					fixturesPath: '/session/modules/underwriting/research-fixtures.json',
				},
				live: [],
			}),
		);
		settings.declare({
			moduleId: 'research.core',
			settings: {
				adapter: {
					type: 'string',
					defaultValue: 'model-native',
					visibility: 'private',
					client: false,
					enum: ['model-native', 'connector', 'recorded'],
				},
				recordedFixturesPath: {
					type: 'string',
					defaultValue: '',
					visibility: 'private',
					client: false,
				},
				searchOrder: {
					type: 'string',
					defaultValue: '',
					visibility: 'private',
					client: false,
				},
				fetchOrder: {
					type: 'string',
					defaultValue: 'direct',
					visibility: 'private',
					client: false,
				},
				recordedEnabled: {
					type: 'boolean',
					defaultValue: false,
					visibility: 'private',
					client: false,
				},
				monthlyQueryBudget: {
					type: 'number',
					defaultValue: 500,
					visibility: 'private',
					client: false,
				},
			},
		});
		await settings.prime('tenant-a');
		await settings.prime(PLATFORM_SETTINGS_TENANT);
		expect(settings.get('tenant-a', 'research.core', 'adapter')).toBe(
			'recorded',
		);
		expect(
			settings.get('tenant-a', 'research.core', 'recordedFixturesPath'),
		).toBe('/session/modules/underwriting/research-fixtures.json');

		await expect(
			settings.set('tenant-a', 'research.core', 'adapter', 'connector', 'a'),
		).rejects.toMatchObject({ code: LIVE_ADAPTER_REFUSED, status: 409 });
		expect(settings.get('tenant-a', 'research.core', 'searchOrder')).toBe(
			'recorded',
		);
		expect(settings.get('tenant-a', 'research.core', 'recordedEnabled')).toBe(
			true,
		);
		expect(settings.get('tenant-a', 'research.core', 'fetchOrder')).toBe(
			'direct',
		);
		for (const [key, value] of [
			['searchOrder', 'searxng,recorded'],
			['searchOrder', 'firecrawl'],
			['searchOrder', 'recorded,model-native'],
			['recordedEnabled', false],
			['fetchOrder', 'firecrawl'],
			['fetchOrder', 'direct,firecrawl'],
		] as const) {
			await expect(
				settings.set('tenant-a', 'research.core', key, value, 'a'),
			).rejects.toMatchObject({ code: LIVE_ADAPTER_REFUSED, status: 409 });
		}
		expect(settings.get('tenant-a', 'research.core', 'searchOrder')).toBe(
			'recorded',
		);
		expect(settings.get('tenant-a', 'research.core', 'fetchOrder')).toBe(
			'direct',
		);
		await settings.set('tenant-a', 'research.core', 'adapter', null, 'a');
		expect(settings.get('tenant-a', 'research.core', 'adapter')).toBe(
			'recorded',
		);
		await settings.set(
			'tenant-a',
			'research.core',
			'monthlyQueryBudget',
			20,
			'a',
		);
		expect(
			settings.get('tenant-a', 'research.core', 'monthlyQueryBudget'),
		).toBe(20);
		await settings.prime('tenant-b');
		expect(settings.get('tenant-b', 'research.core', 'adapter')).toBe(
			'recorded',
		);
	});
});
