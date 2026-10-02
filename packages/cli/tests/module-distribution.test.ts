import {
	mkdtemp,
	mkdir,
	writeFile,
	readFile,
	rename,
	readdir,
	rm,
	access,
	symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type {
	ModuleArtifact,
	ModuleCatalog,
	ModuleManifest,
	ModuleReviewEvidence,
	ModuleRelease,
} from '@flowdular/contracts';
import { PLATFORM_API_VERSION } from '@flowdular/contracts';
import {
	hashBytes,
	packModule,
	readModuleSource,
	sourceDigest,
} from '../src/module-artifact.ts';
import {
	loadModuleCatalog,
	readRelease,
	resolveModuleReleases,
} from '../src/module-catalog.ts';
import {
	installModule,
	validateInstalledModules,
	recoverModuleInstall,
} from '../src/module-install.ts';
import { runCommand } from '../src/runner.ts';
import { parseArguments } from '../src/arguments.ts';
import type { Workspace } from '../src/workspace.ts';
import {
	applyModulePlan,
	createModulePlan,
	readModulePlan,
} from '../src/module-plans.ts';
import { addModuleSource } from '../src/module-sources.ts';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});
function manifest(
	id = 'sample.core',
	version = '1.0.0',
	dependencies: ModuleManifest['dependencies'] = [],
): ModuleManifest {
	return {
		schemaVersion: 1,
		id,
		package: `@flowdular/module-${id.split('.')[0]}`,
		version,
		platformApi: `^${PLATFORM_API_VERSION}`,
		profile: 'headless',
		capabilities: [],
		dependencies,
		tenancy: 'required',
		locales: ['en'],
		stability: 'experimental',
	};
}
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-distribution-'));
	roots.push(root);
	const source = join(root, 'publisher');
	await mkdir(join(source, 'spec'), { recursive: true });
	const workspaceRoot = join(root, 'consumer');
	await mkdir(workspaceRoot);
	const config = { modules: { roots: ['extensions'], enabled: [] } };
	const workspace: Workspace = {
		root: workspaceRoot,
		configPath: join(workspaceRoot, 'flowdular.json'),
		config,
	};
	await writeFile(workspace.configPath, JSON.stringify(config));
	const registry = join(root, 'index.json');
	async function release(
		m = manifest(),
		alter?: (artifact: ModuleArtifact) => unknown,
		specStatus: 'draft' | 'approved' = 'approved',
	) {
		await writeFile(join(source, 'module.json'), JSON.stringify(m));
		await writeFile(
			join(source, 'package.json'),
			JSON.stringify({ name: m.package, version: m.version, type: 'module' }),
		);
		await writeFile(
			join(source, 'spec/module.yaml'),
			JSON.stringify({
				schemaVersion: 1,
				id: m.id,
				specVersion: m.version,
				status: specStatus,
				name: 'Sample',
				description: 'A sample module for installation tests.',
				profile: m.profile,
				capabilities: m.capabilities,
				dependencies: m.dependencies,
				tenancy: m.tenancy,
				locales: m.locales,
			}),
		);
		const review: ModuleReviewEvidence = {
			sourceSha256: sourceDigest(await readModuleSource(source)),
			requirements: ['The sample can be installed without activation.'],
			findings: [],
			checks: [
				{ name: 'typecheck', command: 'pnpm typecheck', exitCode: 0 },
				{ name: 'test', command: 'pnpm test', exitCode: 0 },
				{ name: 'validate', command: 'pnpm validate', exitCode: 0 },
			],
		};
		const artifact = await packModule(source, review);
		const bytes = JSON.stringify(alter ? alter(artifact) : artifact);
		const filename = `${m.id}-${m.version}.json`;
		await writeFile(join(root, filename), bytes);
		const record: ModuleRelease = {
			manifest: m,
			artifact: filename,
			sha256: hashBytes(bytes),
			sourceCommit: 'a'.repeat(40),
			license: 'MIT',
		};
		return { record, artifact };
	}
	async function catalog(records: ModuleRelease[]) {
		await writeFile(
			registry,
			JSON.stringify({ schemaVersion: 1, releases: records }),
		);
	}
	return { root, source, workspace, registry, release, catalog };
}

describe('module distribution', () => {
	it('saves one pinned plan and installs exactly that plan', async () => {
		const f = await fixture();
		const { record } = await f.release();
		await f.catalog([record]);
		const sourceAdded = await runCommand(
			parseArguments([
				'--root',
				f.workspace.root,
				'module',
				'source',
				'add',
				'local',
				f.registry,
				'--apply',
			]),
		);
		expect(sourceAdded.ok).toBe(true);
		const planned = await runCommand(
			parseArguments([
				'--root',
				f.workspace.root,
				'module',
				'plan',
				'sample.core',
				'--source',
				'local',
				'--apply',
			]),
		);
		expect(planned.ok).toBe(true);
		const plan = (
			planned.data as { plan: import('@flowdular/contracts').ModuleChangePlan }
		).plan;
		expect(plan.changes.map((change) => [change.id, change.action])).toEqual([
			['sample.core', 'install'],
		]);
		expect(plan.releases[0]?.sha256).toBe(record.sha256);
		expect((await readModulePlan(f.workspace, plan.id)).id).toBe(plan.id);
		expect((await applyModulePlan(f.workspace, plan.id, false)).applied).toBe(
			false,
		);
		const applied = await runCommand(
			parseArguments([
				'--root',
				f.workspace.root,
				'module',
				'apply',
				plan.id,
				'--apply',
			]),
		);
		expect(applied.ok).toBe(true);
		expect(
			(await validateInstalledModules(f.workspace)).modules[0]?.sha256,
		).toBe(record.sha256);
	});
	it('refuses a stale or edited plan before installing source', async () => {
		const f = await fixture();
		const { record } = await f.release();
		await f.catalog([record]);
		await addModuleSource(
			f.workspace,
			{ name: 'local', source: { kind: 'catalog', location: f.registry } },
			true,
		);
		const plan = await createModulePlan(f.workspace, {
			target: 'sample.core',
			sourceName: 'local',
			update: false,
			save: true,
		});
		const path = join(f.workspace.root, 'module-plans', `${plan.id}.json`);
		await writeFile(path, JSON.stringify({ ...plan, target: 'other.core' }));
		await expect(readModulePlan(f.workspace, plan.id)).rejects.toMatchObject({
			code: 'MODULE_PLAN_INVALID',
		});
		await writeFile(path, JSON.stringify(plan));
		await writeFile(
			join(f.workspace.root, 'flowdular.modules.lock.json'),
			JSON.stringify({ schemaVersion: 1, modules: [] }),
		);
		await expect(
			applyModulePlan(f.workspace, plan.id, true),
		).rejects.toMatchObject({ code: 'MODULE_PLAN_STALE' });
		await expect(
			access(join(f.workspace.root, 'extensions')),
		).rejects.toThrow();
	});
	it('refuses a plan directory linked outside the workspace', async () => {
		const f = await fixture();
		const { record } = await f.release();
		await f.catalog([record]);
		await addModuleSource(
			f.workspace,
			{ name: 'local', source: { kind: 'catalog', location: f.registry } },
			true,
		);
		const plan = await createModulePlan(f.workspace, {
			target: 'sample.core',
			sourceName: 'local',
			update: false,
			save: true,
		});
		const directory = join(f.workspace.root, 'module-plans');
		await rename(directory, join(f.root, 'outside-plans'));
		await symlink(join(f.root, 'outside-plans'), directory);
		await expect(readModulePlan(f.workspace, plan.id)).rejects.toMatchObject({
			code: 'MODULE_PLAN_INVALID',
		});
	});
	it('refuses a plan whose permission impact was rewritten with a new id', async () => {
		const f = await fixture();
		const { record } = await f.release();
		await f.catalog([record]);
		await addModuleSource(
			f.workspace,
			{ name: 'local', source: { kind: 'catalog', location: f.registry } },
			true,
		);
		const plan = await createModulePlan(f.workspace, {
			target: 'sample.core',
			sourceName: 'local',
			update: false,
			save: true,
		});
		const edited = {
			...plan,
			changes: [{ ...plan.changes[0]!, permissions: ['sample.admin'] }],
		};
		const { id: _oldId, createdAt: _createdAt, ...content } = edited;
		const id = hashBytes(JSON.stringify(content));
		await writeFile(
			join(f.workspace.root, 'module-plans', `${id}.json`),
			JSON.stringify({ ...edited, id }),
		);
		await expect(applyModulePlan(f.workspace, id, true)).rejects.toMatchObject({
			code: 'MODULE_PLAN_CHANGED',
		});
		await expect(
			access(join(f.workspace.root, 'extensions')),
		).rejects.toThrow();
	});
	it('refuses a self-hashed plan with no releases or mismatched visible impact', async () => {
		const f = await fixture();
		const { record } = await f.release();
		await f.catalog([record]);
		await addModuleSource(
			f.workspace,
			{ name: 'local', source: { kind: 'catalog', location: f.registry } },
			true,
		);
		const plan = await createModulePlan(f.workspace, {
			target: 'sample.core',
			sourceName: 'local',
			update: false,
			save: true,
		});
		for (const edited of [
			{ ...plan, releases: [], changes: [] },
			{
				...plan,
				changes: [{ ...plan.changes[0]!, sha256: '0'.repeat(64) }],
			},
		]) {
			const { id: _id, createdAt, ...content } = edited;
			const id = hashBytes(JSON.stringify(content));
			await writeFile(
				join(f.workspace.root, 'module-plans', `${id}.json`),
				JSON.stringify({ ...content, id, createdAt }),
			);
			await expect(readModulePlan(f.workspace, id)).rejects.toMatchObject({
				code: 'MODULE_PLAN_INVALID',
			});
		}
	});
	it('rejects draft module specifications in a new plan', async () => {
		const f = await fixture();
		const { record } = await f.release(manifest(), undefined, 'draft');
		await f.catalog([record]);
		await addModuleSource(
			f.workspace,
			{ name: 'local', source: { kind: 'catalog', location: f.registry } },
			true,
		);
		await expect(
			createModulePlan(f.workspace, {
				target: 'sample.core',
				sourceName: 'local',
				update: false,
				save: true,
			}),
		).rejects.toMatchObject({ code: 'MODULE_SPEC_NOT_APPROVED' });
	});
	it('does not lose a source update while another host command owns the lock', async () => {
		const f = await fixture();
		await mkdir(join(f.workspace.root, 'flowdular.module-sources.json.lock'));
		await expect(
			addModuleSource(
				f.workspace,
				{
					name: 'local',
					source: { kind: 'catalog', location: f.registry },
				},
				true,
			),
		).rejects.toMatchObject({ code: 'MODULE_SOURCE_BUSY' });
		await expect(
			access(join(f.workspace.root, 'flowdular.module-sources.json')),
		).rejects.toThrow();
	});
	it('rejects a Git catalog path that the Module Studio reader cannot show', async () => {
		const f = await fixture();
		await expect(
			addModuleSource(
				f.workspace,
				{
					name: 'git',
					source: {
						kind: 'git',
						location: f.root,
						commit: 'a'.repeat(40),
						catalogPath: `${'a'.repeat(240)}.json`,
					},
				},
				true,
			),
		).rejects.toMatchObject({ code: 'MODULE_SOURCE_INVALID' });
	});
	it('publishes a plan only after owning its write lock', async () => {
		const f = await fixture();
		const { record } = await f.release();
		await f.catalog([record]);
		await addModuleSource(
			f.workspace,
			{ name: 'local', source: { kind: 'catalog', location: f.registry } },
			true,
		);
		const lock = join(f.workspace.root, 'module-plans.lock');
		await mkdir(lock);
		await expect(
			createModulePlan(f.workspace, {
				target: 'sample.core',
				sourceName: 'local',
				update: false,
				save: true,
			}),
		).rejects.toMatchObject({ code: 'MODULE_PLAN_BUSY' });
		await expect(
			access(join(f.workspace.root, 'module-plans')),
		).rejects.toThrow();
		await rm(lock, { recursive: true });
		const plan = await createModulePlan(f.workspace, {
			target: 'sample.core',
			sourceName: 'local',
			update: false,
			save: true,
		});
		expect(await readdir(join(f.workspace.root, 'module-plans'))).toEqual([
			`${plan.id}.json`,
		]);
		expect((await readModulePlan(f.workspace, plan.id)).id).toBe(plan.id);
	});
	it('refuses to publish plans beyond the UI read budget', async () => {
		const f = await fixture();
		const { record } = await f.release();
		await f.catalog([record]);
		await addModuleSource(
			f.workspace,
			{ name: 'local', source: { kind: 'catalog', location: f.registry } },
			true,
		);
		const plan = await createModulePlan(f.workspace, {
			target: 'sample.core',
			sourceName: 'local',
			update: false,
			save: false,
		});
		const directory = join(f.workspace.root, 'module-plans');
		await mkdir(directory);
		const { id: _id, createdAt, ...base } = plan;
		for (let index = 0; index < 3; index++) {
			const content = { ...base, note: 'x'.repeat(3 * 1024 * 1024) + index };
			const id = hashBytes(JSON.stringify(content));
			await writeFile(
				join(directory, `${id}.json`),
				JSON.stringify({ ...content, id, createdAt }),
			);
			if (index === 0)
				expect((await readModulePlan(f.workspace, id)).id).toBe(id);
		}
		await expect(
			createModulePlan(f.workspace, {
				target: 'sample.core',
				sourceName: 'local',
				update: false,
				save: true,
			}),
		).rejects.toMatchObject({ code: 'MODULE_PLAN_LIMIT' });
		expect(await readdir(directory)).toHaveLength(3);
	});
	it('uses the pinned Git commit after the source branch advances', async () => {
		const f = await fixture();
		const { record } = await f.release();
		const repository = join(f.root, 'git-source');
		await mkdir(join(repository, 'registry'), { recursive: true });
		await writeFile(
			join(repository, 'registry/index.json'),
			JSON.stringify({ schemaVersion: 1, releases: [record] }),
		);
		await writeFile(
			join(repository, 'registry', record.artifact),
			await readFile(join(f.root, record.artifact)),
		);
		const git = (...args: string[]) =>
			execFileSync('git', ['-C', repository, ...args], {
				encoding: 'utf8',
			}).trim();
		git('init', '-q');
		git('config', 'user.email', 'test@example.test');
		git('config', 'user.name', 'Test');
		git('add', '.');
		git('commit', '-qm', 'first');
		const commit = git('rev-parse', 'HEAD');
		await addModuleSource(
			f.workspace,
			{
				name: 'git',
				source: {
					kind: 'git',
					location: repository,
					commit,
					catalogPath: 'registry/index.json',
				},
			},
			true,
		);
		const plan = await createModulePlan(f.workspace, {
			target: 'sample.core',
			sourceName: 'git',
			update: false,
			save: true,
		});
		await writeFile(
			join(repository, 'registry/index.json'),
			JSON.stringify({ schemaVersion: 1, releases: [] }),
		);
		git('add', '.');
		git('commit', '-qm', 'second');
		const applied = await applyModulePlan(f.workspace, plan.id, true);
		expect(applied.applied).toBe(true);
		expect(
			(await validateInstalledModules(f.workspace)).modules[0]?.sha256,
		).toBe(record.sha256);
	});
	it('previews without writes, installs into configured roots, locks and retries without activation', async () => {
		const f = await fixture();
		const { record } = await f.release();
		await f.catalog([record]);
		const preview = await installModule(f.workspace, {
			target: 'sample.core',
			registry: f.registry,
			apply: false,
		});
		expect(preview.applied).toBe(false);
		await expect(
			access(join(f.workspace.root, 'extensions')),
		).rejects.toThrow();
		const result = await installModule(f.workspace, {
			target: 'sample.core',
			registry: f.registry,
			apply: true,
		});
		expect(result.modules[0]?.directory).toBe('extensions/sample');
		expect(await readFile(f.workspace.configPath, 'utf8')).toBe(
			JSON.stringify(f.workspace.config),
		);
		expect((await validateInstalledModules(f.workspace)).modules).toHaveLength(
			1,
		);
		expect(
			(
				await installModule(f.workspace, {
					target: 'sample.core',
					registry: f.registry,
					apply: true,
				})
			).modules,
		).toEqual([]);
	});
	it('routes CLI installation and locked validation', async () => {
		const f = await fixture();
		const { record } = await f.release();
		await f.catalog([record]);
		const result = await runCommand(
			parseArguments([
				'--root',
				f.workspace.root,
				'module',
				'install',
				'sample.core',
				'--registry',
				f.registry,
				'--apply',
			]),
		);
		expect(result.ok).toBe(true);
		const validated = await runCommand(
			parseArguments([
				'--root',
				f.workspace.root,
				'module',
				'validate',
				'--locked',
			]),
		);
		expect(validated.ok).toBe(true);
	});
	it('rejects tampered artifacts and stale review evidence before changing the workspace', async () => {
		const f = await fixture();
		const { record } = await f.release();
		await f.catalog([{ ...record, sha256: '0'.repeat(64) }]);
		await expect(
			installModule(f.workspace, {
				target: 'sample.core',
				registry: f.registry,
				apply: true,
			}),
		).rejects.toMatchObject({ code: 'MODULE_ARTIFACT_DIGEST' });
		const bad = await f.release(manifest(), (artifact) => ({
			...artifact,
			review: { ...artifact.review, sourceSha256: '0'.repeat(64) },
		}));
		await f.catalog([bad.record]);
		await expect(
			installModule(f.workspace, {
				target: 'sample.core',
				registry: f.registry,
				apply: true,
			}),
		).rejects.toMatchObject({ code: 'MODULE_REVIEW_INVALID' });
		await expect(
			access(join(f.workspace.root, 'extensions')),
		).rejects.toThrow();
	});
	it('rejects path traversal even with a correct outer digest', async () => {
		const f = await fixture();
		const bad = await f.release(manifest(), (artifact) => ({
			...artifact,
			files: [
				...artifact.files,
				{ path: '../../escaped', content: '', sha256: hashBytes('') },
			],
		}));
		await f.catalog([bad.record]);
		await expect(
			installModule(f.workspace, {
				target: 'sample.core',
				registry: f.registry,
				apply: true,
			}),
		).rejects.toMatchObject({ code: 'MODULE_ARTIFACT_PATH' });
	});
	it('rejects a symlinked destination root', async () => {
		const f = await fixture();
		const { record } = await f.release();
		await f.catalog([record]);
		await symlink(f.source, join(f.workspace.root, 'extensions'));
		await expect(
			installModule(f.workspace, {
				target: 'sample.core',
				registry: f.registry,
				apply: true,
			}),
		).rejects.toMatchObject({ code: 'MODULE_DESTINATION_LINK' });
	});
	it('preserves local edits and extra files on update', async () => {
		const f = await fixture();
		const first = await f.release();
		await f.catalog([first.record]);
		await installModule(f.workspace, {
			target: 'sample.core',
			registry: f.registry,
			apply: true,
		});
		await writeFile(
			join(f.workspace.root, 'extensions/sample/README.md'),
			'Local work',
		);
		const next = await f.release(manifest('sample.core', '1.1.0'));
		await f.catalog([first.record, next.record]);
		await expect(
			installModule(f.workspace, {
				target: 'sample.core',
				registry: f.registry,
				apply: true,
				update: true,
			}),
		).rejects.toMatchObject({ code: 'MODULE_LOCAL_CHANGES' });
		expect(
			await readFile(
				join(f.workspace.root, 'extensions/sample/README.md'),
				'utf8',
			),
		).toBe('Local work');
	});
	it('updates unchanged source, preserves history and rejects downgrades', async () => {
		const f = await fixture();
		const first = await f.release();
		await f.catalog([first.record]);
		await installModule(f.workspace, {
			target: 'sample.core',
			registry: f.registry,
			apply: true,
		});
		const next = await f.release(manifest('sample.core', '1.1.0'));
		await f.catalog([first.record, next.record]);
		await installModule(f.workspace, {
			target: 'sample.core',
			registry: f.registry,
			apply: true,
			update: true,
		});
		expect(
			(await validateInstalledModules(f.workspace)).modules[0]?.version,
		).toBe('1.1.0');
		await expect(
			installModule(f.workspace, {
				target: 'sample.core@1.0.0',
				registry: f.registry,
				apply: true,
				update: true,
			}),
		).rejects.toMatchObject({ code: 'MODULE_DOWNGRADE_FORBIDDEN' });
	});
	it('does not discard an existing module when update layout validation fails', async () => {
		const f = await fixture();
		const first = await f.release();
		await f.catalog([first.record]);
		await installModule(f.workspace, {
			target: 'sample.core',
			registry: f.registry,
			apply: true,
		});
		const nextManifest = {
			...manifest('sample.core', '1.1.0'),
			platform: { server: true },
		};
		const next = await f.release(nextManifest);
		await f.catalog([first.record, next.record]);
		await expect(
			installModule(f.workspace, {
				target: 'sample.core',
				registry: f.registry,
				apply: true,
				update: true,
			}),
		).rejects.toMatchObject({ code: 'MODULE_LAYOUT_INVALID' });
		expect(
			(await validateInstalledModules(f.workspace)).modules[0]?.version,
		).toBe('1.0.0');
	});
	it('resolves diamond constraints by backtracking and rejects dependency cycles', () => {
		const release = (m: ModuleManifest): ModuleRelease => ({
			manifest: m,
			artifact: 'x',
			sha256: 'a'.repeat(64),
			sourceCommit: 'a'.repeat(40),
			license: 'MIT',
		});
		const records = [
			release(
				manifest('app.core', '1.0.0', [
					{ id: 'left.core', range: '*' },
					{ id: 'right.core', range: '*' },
				]),
			),
			release(
				manifest('left.core', '1.0.0', [{ id: 'shared.core', range: '*' }]),
			),
			release(
				manifest('right.core', '1.0.0', [
					{ id: 'shared.core', range: '^1.0.0' },
				]),
			),
			release(manifest('shared.core', '2.0.0')),
			release(manifest('shared.core', '1.0.0')),
		];
		const result = resolveModuleReleases(
			{ schemaVersion: 1, releases: records },
			'app.core',
			[],
		);
		expect(
			result.find((entry) => entry.manifest.id === 'shared.core')?.manifest
				.version,
		).toBe('1.0.0');
		expect(() =>
			resolveModuleReleases(
				{
					schemaVersion: 1,
					releases: [
						release(
							manifest('app.core', '1.0.0', [{ id: 'app.core', range: '*' }]),
						),
					],
				},
				'app.core',
				[],
			),
		).toThrow(/cycle/i);
	});
	it('resolves a required capability to its newest compatible provider', async () => {
		const f = await fixture();
		const release = (m: ModuleManifest): ModuleRelease => ({
			manifest: m,
			artifact: `${m.id}-${m.version}.json`,
			sha256: 'b'.repeat(64),
			sourceCommit: 'a'.repeat(40),
			license: 'MIT',
		});
		void f;
		const consumer: ModuleManifest = {
			...manifest('automations.core', '1.0.0'),
			requires: [
				{ id: 'agents.run-queue' },
				{ id: 'workflows.execution.v1', optional: true },
			],
		};
		const records = [
			release(consumer),
			release({
				...manifest('agents.core', '1.0.0'),
				provides: ['agents.run-queue'],
			}),
			release({
				...manifest('agents.core', '1.1.0'),
				provides: ['agents.run-queue'],
			}),
		];
		const result = resolveModuleReleases(
			{ schemaVersion: 1, releases: records },
			'automations.core',
			[],
		);
		expect(
			result.map((entry) => `${entry.manifest.id}@${entry.manifest.version}`),
		).toEqual(['agents.core@1.1.0', 'automations.core@1.0.0']);
		expect(
			resolveModuleReleases(
				{ schemaVersion: 1, releases: records },
				'automations.core',
				[
					{
						...manifest('agents.core', '1.0.0'),
						provides: ['agents.run-queue'],
					},
				],
			).map((entry) => entry.manifest.id),
		).toEqual(['automations.core']);
		expect(() =>
			resolveModuleReleases(
				{ schemaVersion: 1, releases: [release(consumer)] },
				'automations.core',
				[],
			),
		).toThrow(/No compatible dependency closure/);
	});

	it('rejects unpinned or cross-origin HTTPS artifacts', async () => {
		const f = await fixture();
		const { record } = await f.release();
		await f.catalog([record]);
		const source = await loadModuleCatalog(f.registry);
		await expect(
			loadModuleCatalog('http://example.com/catalog.json'),
		).rejects.toMatchObject({ code: 'MODULE_SOURCE_UNTRUSTED' });
		await expect(
			readRelease(
				{ ...source, location: 'https://modules.example/index.json' },
				{
					...record,
					artifact: `https://other.example/${record.sourceCommit}/artifact.json`,
				},
			),
		).rejects.toMatchObject({ code: 'MODULE_SOURCE_UNTRUSTED' });
	});
});

it('recovers an interrupted install and refuses recovery while its owner is alive', async () => {
	const f = await fixture();
	const { record } = await f.release();
	await f.catalog([record]);
	await installModule(f.workspace, {
		target: 'sample.core',
		registry: f.registry,
		apply: true,
	});
	const raw = await readFile(
		join(f.workspace.root, 'flowdular.modules.lock.json'),
		'utf8',
	);
	const lock = JSON.parse(raw);
	const transaction = join(f.workspace.root, '.flowdular-module-install');
	await mkdir(transaction);
	const journal = {
		schemaVersion: 1,
		pid: process.pid,
		previous: null,
		next: raw,
		entries: lock.modules.map((installed: unknown) => ({
			installed,
			previous: null,
		})),
	};
	await writeFile(join(transaction, 'journal.json'), JSON.stringify(journal));
	await expect(recoverModuleInstall(f.workspace, true)).rejects.toMatchObject({
		code: 'MODULE_INSTALL_BUSY',
	});
	journal.pid = 2_000_000_000;
	await writeFile(join(transaction, 'journal.json'), JSON.stringify(journal));
	expect(await recoverModuleInstall(f.workspace, false)).toEqual({
		pending: true,
		recovered: false,
	});
	await access(join(f.workspace.root, 'extensions/sample/module.json'));
	expect(await recoverModuleInstall(f.workspace, true)).toEqual({
		pending: false,
		recovered: true,
	});
	await expect(
		access(join(f.workspace.root, 'extensions/sample')),
	).rejects.toThrow();
	await expect(
		access(join(f.workspace.root, 'flowdular.modules.lock.json')),
	).rejects.toThrow();
});

it('preserves installed migrations when an upstream update changes their bytes', async () => {
	const f = await fixture();
	await mkdir(join(f.source, 'migrations'));
	await writeFile(join(f.source, 'migrations/0001_init.up.sql'), 'SELECT 1;');
	const first = await f.release();
	await f.catalog([first.record]);
	await installModule(f.workspace, {
		target: 'sample.core',
		registry: f.registry,
		apply: true,
	});
	await writeFile(join(f.source, 'migrations/0001_init.up.sql'), 'SELECT 2;');
	const next = await f.release(manifest('sample.core', '1.1.0'));
	await f.catalog([first.record, next.record]);
	await expect(
		installModule(f.workspace, {
			target: 'sample.core',
			registry: f.registry,
			apply: true,
			update: true,
		}),
	).rejects.toMatchObject({ code: 'MODULE_MIGRATION_CHANGED' });
	expect(
		await readFile(
			join(f.workspace.root, 'extensions/sample/migrations/0001_init.up.sql'),
			'utf8',
		),
	).toBe('SELECT 1;');
});
