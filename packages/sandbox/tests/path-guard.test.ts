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
});
