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
import { join } from 'node:path';
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
