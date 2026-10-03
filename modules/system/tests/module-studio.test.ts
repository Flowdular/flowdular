import { createHash } from 'node:crypto';
import {
	access,
	mkdtemp,
	mkdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModuleChangePlan } from '@flowdular/contracts';
import { readModuleStudioState } from '../src/server/module-studio.ts';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-module-studio-'));
	roots.push(root);
	await mkdir(join(root, 'module-plans'));
	const content = {
		schemaVersion: 1 as const,
		target: 'sample.core',
		sourceName: 'local',
		source: { kind: 'catalog' as const, location: './registry/index.json' },
		update: false,
		expectedLockSha256: null,
		expectedWorkspaceSha256: 'a'.repeat(64),
		releases: [
			{
				manifest: {
					schemaVersion: 1 as const,
					id: 'sample.core',
					package: '@flowdular/module-sample',
					version: '1.0.0',
					profile: 'full' as const,
					capabilities: ['api', 'client'] as const,
					dependencies: [{ id: 'reports.core', range: '^1.0.0' }],
					tenancy: 'required' as const,
					locales: ['en'],
					stability: 'stable' as const,
				},
				artifact: 'sample.json',
				sha256: 'b'.repeat(64),
				sourceCommit: 'c'.repeat(40),
				license: 'MIT',
			},
		],
		changes: [
			{
				id: 'sample.core',
				version: '1.0.0',
				sha256: 'b'.repeat(64),
				action: 'install' as const,
				dependencies: ['reports.core'],
				permissions: ['sample.read'],
				migrations: [
					{ path: 'migrations/0001_init.up.sql', sha256: 'd'.repeat(64) },
				],
				surfaces: { server: true, client: true },
			},
		],
		requiresBuild: true as const,
		requiresRestart: true as const,
		activation: 'host-cli' as const,
	};
	const id = createHash('sha256').update(JSON.stringify(content)).digest('hex');
	const plan: ModuleChangePlan = {
		...content,
		id,
		createdAt: new Date().toISOString(),
	};
	await writeFile(
		join(root, 'module-plans', `${id}.json`),
		JSON.stringify(plan),
	);
	return { root, plan };
}

describe('Module Studio state', () => {
	it('SYSTEM-MODULE-STUDIO-READ: exposes pinned impact and installed state from the host checkout', async () => {
		const { root, plan } = await fixture();
		await writeFile(
			join(root, 'flowdular.module-sources.json'),
			JSON.stringify({
				schemaVersion: 1,
				sources: [{ name: 'local', source: plan.source }],
			}),
		);
		await writeFile(
			join(root, 'flowdular.modules.lock.json'),
			JSON.stringify({
				schemaVersion: 1,
				modules: [
					{ id: 'sample.core', version: '1.0.0', sha256: 'b'.repeat(64) },
				],
			}),
		);
		const state = readModuleStudioState(root);
		expect(state.plans.map((entry) => entry.id)).toEqual([plan.id]);
		expect(state.sources.map((entry) => entry.name)).toEqual(['local']);
		expect(state.installed.map((entry) => entry.id)).toEqual(['sample.core']);
		expect(state.plans[0]?.changes[0]).toMatchObject({
			sha256: 'b'.repeat(64),
			dependencies: ['reports.core'],
			permissions: ['sample.read'],
			migrations: [
				{ path: 'migrations/0001_init.up.sql', sha256: 'd'.repeat(64) },
			],
		});
		expect(state.issues).toEqual([]);
		await expect(access(join(root, 'modules'))).rejects.toThrow();
	});
	it('refuses an edited or linked plan without blocking the module catalog', async () => {
		const { root, plan } = await fixture();
		const path = join(root, 'module-plans', `${plan.id}.json`);
		await writeFile(path, JSON.stringify({ ...plan, target: 'other.core' }));
		expect(readModuleStudioState(root)).toMatchObject({
			plans: [],
			issues: [expect.stringContaining('could not be verified')],
		});
		await rm(path);
		const outside = join(root, 'outside.json');
		await writeFile(outside, JSON.stringify(plan));
		await symlink(outside, path);
		expect(readModuleStudioState(root).plans).toEqual([]);
		expect(await readFile(outside, 'utf8')).toContain(plan.id);
	});
	it('never includes credential-bearing source URLs in the response', async () => {
		const { root } = await fixture();
		await writeFile(
			join(root, 'flowdular.module-sources.json'),
			JSON.stringify({
				schemaVersion: 1,
				sources: [
					{
						name: 'private',
						source: {
							kind: 'catalog',
							location: 'https://user:secret@example.test/index.json',
						},
					},
				],
			}),
		);
		const state = readModuleStudioState(root);
		expect(state.sources).toEqual([]);
		expect(JSON.stringify(state)).not.toContain('secret');
	});
	it('does not read a plan directory linked outside the workspace', async () => {
		const { root } = await fixture();
		const directory = join(root, 'module-plans');
		await rename(directory, join(root, 'outside-plans'));
		await symlink(join(root, 'outside-plans'), directory);
		const state = readModuleStudioState(root);
		expect(state.plans).toEqual([]);
		expect(state.issues).toContain('Module plan directory is invalid.');
	});
	it('rejects self-hashed plan data that the view cannot render safely', async () => {
		const { root, plan } = await fixture();
		await rm(join(root, 'module-plans', `${plan.id}.json`));
		const edited = {
			...plan,
			changes: [{ ...plan.changes[0]!, migrations: [null] }],
		};
		const { id: _id, createdAt: _createdAt, ...content } = edited;
		const id = createHash('sha256')
			.update(JSON.stringify(content))
			.digest('hex');
		await writeFile(
			join(root, 'module-plans', `${id}.json`),
			JSON.stringify({ ...edited, id }),
		);
		expect(readModuleStudioState(root).plans).toEqual([]);
		await rm(join(root, 'module-plans', `${id}.json`));
		const empty = { ...plan, releases: [], changes: [] };
		const { id: _emptyId, createdAt: emptyCreatedAt, ...emptyContent } = empty;
		const emptyId = createHash('sha256')
			.update(JSON.stringify(emptyContent))
			.digest('hex');
		await writeFile(
			join(root, 'module-plans', `${emptyId}.json`),
			JSON.stringify({
				...emptyContent,
				id: emptyId,
				createdAt: emptyCreatedAt,
			}),
		);
		expect(readModuleStudioState(root).plans).toEqual([]);
		await writeFile(
			join(root, 'flowdular.modules.lock.json'),
			JSON.stringify({ schemaVersion: 1, modules: [null] }),
		);
		expect(readModuleStudioState(root).installed).toEqual([]);
	});
});
