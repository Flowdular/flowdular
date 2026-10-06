import {
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { guardAgentPaths } from '../src/server/path-guard.ts';

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-path-guard-'));
	await mkdir(join(root, 'modules', 'catalog', 'src'), { recursive: true });
	await writeFile(
		join(root, 'modules', 'catalog', 'src', 'owned.ts'),
		'before\n',
	);
	await writeFile(join(root, 'flowdular.json'), '{"schemaVersion":1}\n');
	return root;
}

describe('agent path guard', () => {
	it('keeps an allowed module change', async () => {
		const root = await workspace();
		const sessionRoot = join(root, '..', `path-guard-session-${Date.now()}`);
		const guard = await guardAgentPaths({
			workspace: root,
			sessionRoot,
			allowedPaths: ['modules/catalog/src/**'],
		});
		await writeFile(
			join(root, 'modules', 'catalog', 'src', 'owned.ts'),
			'after\n',
		);
		expect((await guard.verify()).violations).toEqual([]);
		expect(await readdir(join(sessionRoot, 'path-violations'))).toEqual([]);
		expect(
			await readFile(
				join(root, 'modules', 'catalog', 'src', 'owned.ts'),
				'utf8',
			),
		).toBe('after\n');
	});

	/* Every turn snapshots afresh, so a spec an earlier turn drafted and the
	   files the scaffold wrote between turns are pre-existing by the time the
	   next role edits them. A clean turn used to put all of them back: one real
	   session lost its spec edits three turns running and looped on one gate. */
	it('keeps edits to files an earlier turn or the scaffold created', async () => {
		const root = await workspace();
		const sessionRoot = join(
			root,
			'..',
			`path-guard-session-turns-${Date.now()}`,
		);
		const spec = join(root, 'modules', 'catalog', 'spec', 'module.yaml');
		const routes = join(
			root,
			'modules',
			'catalog',
			'src',
			'server',
			'routes.ts',
		);
		const planner = [
			'modules/catalog/spec/**',
			'modules/catalog/translations/**',
		];

		const drafting = await guardAgentPaths({
			workspace: root,
			sessionRoot,
			allowedPaths: planner,
		});
		await mkdir(dirname(spec), { recursive: true });
		await writeFile(spec, 'status: draft\n');
		expect((await drafting.verify()).violations).toEqual([]);

		const answering = await guardAgentPaths({
			workspace: root,
			sessionRoot,
			allowedPaths: planner,
		});
		await writeFile(spec, 'status: draft\ndecisions: answered\n');
		expect((await answering.verify()).violations).toEqual([]);
		expect(await readFile(spec, 'utf8')).toBe(
			'status: draft\ndecisions: answered\n',
		);

		await mkdir(dirname(routes), { recursive: true });
		await writeFile(routes, 'export const routes = [];\n');
		const implementing = await guardAgentPaths({
			workspace: root,
			sessionRoot,
			allowedPaths: ['modules/catalog/src/server/**'],
		});
		await writeFile(routes, 'export const routes = [list];\n');
		const result = await implementing.verify();
		expect(result.violations).toEqual([]);
		expect(result.toolOwned).toEqual([]);
		expect(await readFile(routes, 'utf8')).toBe(
			'export const routes = [list];\n',
		);
	});

	it('quarantines and restores writes outside the active role and module', async () => {
		const root = await workspace();
		const guard = await guardAgentPaths({
			workspace: root,
			sessionRoot: join(root, '..', 'path-guard-session'),
			allowedPaths: ['modules/catalog/src/**'],
		});
		await writeFile(join(root, 'flowdular.json'), '{"changed":true}\n');
		const result = await guard.verify();
		expect(result.violations).toEqual([
			expect.objectContaining({ path: 'flowdular.json', change: 'modified' }),
		]);
		expect(result.quarantine).not.toBeNull();
		expect(await readFile(join(root, 'flowdular.json'), 'utf8')).toBe(
			'{"schemaVersion":1}\n',
		);
		await expect(
			stat(join(result.quarantine!, 'baseline')),
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('rejects a symlink that escapes the workspace even below an allowed path', async () => {
		const root = await workspace();
		const outside = join(root, '..', `outside-${Date.now()}.txt`);
		await writeFile(outside, 'outside\n');
		const guard = await guardAgentPaths({
			workspace: root,
			sessionRoot: join(root, '..', 'path-guard-session'),
			allowedPaths: ['modules/catalog/src/**'],
		});
		await symlink(
			outside,
			join(root, 'modules', 'catalog', 'src', 'escape.ts'),
		);
		const result = await guard.verify();
		expect(result.violations).toEqual([
			expect.objectContaining({
				path: 'modules/catalog/src/escape.ts',
				change: 'symlink-escape',
			}),
		]);
	});

	/* node_modules used to be skipped by the snapshot, which made a write into a
	   pnpm symlink farm invisible and unrestored. */
	it('detects and reverts a write into node_modules', async () => {
		const root = await workspace();
		const dependency = join(root, 'modules', 'catalog', 'node_modules', 'dep');
		await mkdir(dependency, { recursive: true });
		await writeFile(join(dependency, 'index.js'), 'original\n');
		const guard = await guardAgentPaths({
			workspace: root,
			sessionRoot: join(root, '..', 'path-guard-session-nm'),
			allowedPaths: ['modules/catalog/src/**'],
		});
		await writeFile(join(dependency, 'index.js'), 'tampered\n');
		const result = await guard.verify();
		expect(result.violations).toEqual([
			expect.objectContaining({
				path: 'modules/catalog/node_modules/dep/index.js',
				change: 'modified',
			}),
		]);
		expect(await readFile(join(dependency, 'index.js'), 'utf8')).toBe(
			'original\n',
		);
	});

	it('detects a file created inside node_modules', async () => {
		const root = await workspace();
		const dependency = join(root, 'modules', 'catalog', 'node_modules', 'dep');
		await mkdir(dependency, { recursive: true });
		const guard = await guardAgentPaths({
			workspace: root,
			sessionRoot: join(root, '..', 'path-guard-session-nm-new'),
			allowedPaths: ['modules/catalog/src/**'],
		});
		await writeFile(join(dependency, 'planted.js'), 'planted\n');
		const result = await guard.verify();
		expect(result.violations).toEqual([
			expect.objectContaining({ change: 'created' }),
		]);
		await expect(stat(join(dependency, 'planted.js'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('detects a write into dist and .git', async () => {
		for (const directory of ['dist', '.git']) {
			const root = await workspace();
			const target = join(root, 'modules', 'catalog', directory);
			await mkdir(target, { recursive: true });
			await writeFile(join(target, 'artifact'), 'built\n');
			const guard = await guardAgentPaths({
				workspace: root,
				sessionRoot: join(root, '..', `path-guard-session-${directory}`),
				allowedPaths: ['modules/catalog/src/**'],
			});
			await writeFile(join(target, 'artifact'), 'rebuilt\n');
			const result = await guard.verify();
			expect(result.violations).toEqual([
				expect.objectContaining({ change: 'modified' }),
			]);
			expect(await readFile(join(target, 'artifact'), 'utf8')).toBe('built\n');
		}
	});

	/* The copied offenders used to survive under path-violations/<id>/files, so
	   every flagged turn duplicated the tree it had just restored. */
	/* A real session wrote a complete specification and lost the whole turn
	   because pnpm restamped its lockfile on the way past. The toolchain owns
	   these files and the sandbox regenerates them itself. */
	it('restores toolchain churn without failing the turn', async () => {
		const root = await workspace();
		await mkdir(join(root, 'node_modules'), { recursive: true });
		await writeFile(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
		await writeFile(
			join(root, 'node_modules', '.package-map.json'),
			'{"before":true}\n',
		);
		const guard = await guardAgentPaths({
			workspace: root,
			sessionRoot: join(root, '..', 'path-guard-session-tool'),
			allowedPaths: ['modules/catalog/src/**'],
		});
		/* Exactly what pnpm does when the agent runs any command. */
		await writeFile(
			join(root, 'pnpm-lock.yaml'),
			"lockfileVersion: '9.0'\nrestamped: true\n",
		);
		await writeFile(
			join(root, 'node_modules', '.package-map.json'),
			'{"after":true}\n',
		);
		await writeFile(
			join(root, 'node_modules', '.pnpm-workspace-state-v1.json'),
			'{"restamped":true}\n',
		);
		const result = await guard.verify();
		expect(result.violations).toEqual([]);
		expect(result.quarantine).toBeNull();
		expect([...result.toolOwned].sort()).toEqual([
			'node_modules/.package-map.json',
			'node_modules/.pnpm-workspace-state-v1.json',
			'pnpm-lock.yaml',
		]);
		/* Undone, so the next turn starts from the same lockfile. */
		expect(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(
			"lockfileVersion: '9.0'\n",
		);
		expect(
			await readFile(join(root, 'node_modules', '.package-map.json'), 'utf8'),
		).toBe('{"before":true}\n');
	});

	/* Only what the guard reports as tool-owned is put back. The role's own
	   edits in the same turn stay. */
	it('reverts toolchain churn without undoing the role edits beside it', async () => {
		const root = await workspace();
		const owned = join(root, 'modules', 'catalog', 'src', 'owned.ts');
		await mkdir(join(root, 'node_modules'), { recursive: true });
		await writeFile(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
		await writeFile(
			join(root, 'node_modules', '.package-map.json'),
			'{"before":true}\n',
		);
		const guard = await guardAgentPaths({
			workspace: root,
			sessionRoot: join(root, '..', 'path-guard-session-mixed'),
			allowedPaths: ['modules/catalog/src/**'],
		});
		await writeFile(owned, 'after\n');
		await writeFile(
			join(root, 'pnpm-lock.yaml'),
			"lockfileVersion: '9.0'\nrestamped: true\n",
		);
		await writeFile(
			join(root, 'node_modules', '.package-map.json'),
			'{"after":true}\n',
		);
		const result = await guard.verify();
		expect(result.violations).toEqual([]);
		expect(result.quarantine).toBeNull();
		expect([...result.toolOwned].sort()).toEqual([
			'node_modules/.package-map.json',
			'pnpm-lock.yaml',
		]);
		expect(await readFile(owned, 'utf8')).toBe('after\n');
		expect(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(
			"lockfileVersion: '9.0'\n",
		);
		expect(
			await readFile(join(root, 'node_modules', '.package-map.json'), 'utf8'),
		).toBe('{"before":true}\n');
	});

	it('fails a turn that also wrote outside its paths and restores only the offender', async () => {
		const root = await workspace();
		const owned = join(root, 'modules', 'catalog', 'src', 'owned.ts');
		const guard = await guardAgentPaths({
			workspace: root,
			sessionRoot: join(root, '..', 'path-guard-session-offender'),
			allowedPaths: ['modules/catalog/src/**'],
		});
		await writeFile(owned, 'after\n');
		await writeFile(join(root, 'flowdular.json'), '{"changed":true}\n');
		const result = await guard.verify();
		expect(result.violations).toEqual([
			expect.objectContaining({ path: 'flowdular.json', change: 'modified' }),
		]);
		expect(result.quarantine).not.toBeNull();
		expect(await readFile(join(root, 'flowdular.json'), 'utf8')).toBe(
			'{"schemaVersion":1}\n',
		);
		expect(await readFile(owned, 'utf8')).toBe('after\n');
	});

	/* The same rule one level up: pnpm creating the dependency directory mid-turn
	   is not the model writing outside its role. */
	it('does not fail a turn because pnpm created node_modules', async () => {
		const root = await workspace();
		const guard = await guardAgentPaths({
			workspace: root,
			sessionRoot: join(root, '..', 'path-guard-session-newdeps'),
			allowedPaths: ['modules/catalog/src/**'],
		});
		await mkdir(join(root, 'node_modules', '.pnpm'), { recursive: true });
		await writeFile(
			join(root, 'node_modules', '.modules.yaml'),
			'hoistPattern: []\n',
		);
		await writeFile(
			join(root, 'node_modules', '.package-map.json'),
			'{"after":true}\n',
		);
		const result = await guard.verify();
		expect(result.violations).toEqual([]);
		expect(result.quarantine).toBeNull();
		expect(result.toolOwned).toContain('node_modules');
	});

	/* The distinction is authorship, not location: replacing an installed package
	   would make this session's own gates report on code they never checked. */
	it('still fails a change to the contents of an installed package', async () => {
		const root = await workspace();
		await mkdir(join(root, 'node_modules', 'dep'), { recursive: true });
		await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'real\n');
		const guard = await guardAgentPaths({
			workspace: root,
			sessionRoot: join(root, '..', 'path-guard-session-dep'),
			allowedPaths: ['modules/catalog/src/**'],
		});
		await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'swapped\n');
		const result = await guard.verify();
		expect(result.violations).toEqual([
			expect.objectContaining({
				path: 'node_modules/dep/index.js',
				change: 'modified',
			}),
		]);
		expect(
			await readFile(join(root, 'node_modules', 'dep', 'index.js'), 'utf8'),
		).toBe('real\n');
	});

	it('does not retain the quarantined file copies', async () => {
		const root = await workspace();
		const guard = await guardAgentPaths({
			workspace: root,
			sessionRoot: join(root, '..', 'path-guard-session-prune'),
			allowedPaths: ['modules/catalog/src/**'],
		});
		await writeFile(join(root, 'flowdular.json'), '{"changed":true}\n');
		const result = await guard.verify();
		expect(result.quarantine).not.toBeNull();
		await expect(stat(join(result.quarantine!, 'files'))).rejects.toMatchObject(
			{ code: 'ENOENT' },
		);
		expect(
			JSON.parse(
				await readFile(join(result.quarantine!, 'evidence.json'), 'utf8'),
			),
		).toMatchObject({
			violations: [expect.objectContaining({ path: 'flowdular.json' })],
		});
	});

	it('leaves an untouched dependency tree alone', async () => {
		const root = await workspace();
		const dependency = join(root, 'node_modules', 'shared');
		await mkdir(dependency, { recursive: true });
		await writeFile(join(dependency, 'index.js'), 'stable\n');
		const guard = await guardAgentPaths({
			workspace: root,
			sessionRoot: join(root, '..', 'path-guard-session-clean'),
			allowedPaths: ['modules/catalog/src/**'],
		});
		await writeFile(
			join(root, 'modules', 'catalog', 'src', 'owned.ts'),
			'after\n',
		);
		expect((await guard.verify()).violations).toEqual([]);
	});
});
