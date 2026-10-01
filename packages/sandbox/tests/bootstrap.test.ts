import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	BootstrapError,
	assertBootstrapPrerequisites,
	assertRefIsPinned,
	assertTargetIsSafe,
	directoryEntries,
	workspaceTarget,
} from '../src/server/bootstrap.ts';

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function empty(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), 'flowdular-bootstrap-'));
	directories.push(path);
	return path;
}

/* The first run of a business user is `npx @flowdular/sandbox` in an empty
   directory. Everything here exists so that produces a working workspace
   without a checkout, a lockfile decision or a git remote. */
describe('workspace bootstrap', () => {
	it('refuses a moving ref and accepts a tag or a commit', () => {
		expect(() => assertRefIsPinned('v0.4.3')).not.toThrow();
		expect(() => assertRefIsPinned('main')).toThrow(BootstrapError);
		expect(() => assertRefIsPinned('release/next')).toThrow(BootstrapError);
		expect(() => assertRefIsPinned('a'.repeat(40))).not.toThrow();
	});

	it('names the missing tools instead of failing half way through', async () => {
		await expect(
			assertBootstrapPrerequisites(async () => true),
		).resolves.toBeUndefined();
		await expect(
			assertBootstrapPrerequisites(async (command) => command === 'git'),
		).rejects.toMatchObject({ code: 'BOOTSTRAP_PREREQUISITE_MISSING' });
		await expect(
			assertBootstrapPrerequisites(async () => false),
		).rejects.toThrow(/git and pnpm/);
	});

	it('refuses a directory that already holds something', async () => {
		const target = await empty();
		await mkdir(join(target, 'my-notes'), { recursive: true });
		await expect(
			assertTargetIsSafe(target, async () => true, directoryEntries),
		).rejects.toMatchObject({ code: 'BOOTSTRAP_TARGET_NOT_EMPTY' });
	});

	it('accepts a missing directory, an empty one, and one holding only state', async () => {
		const target = await empty();
		const exists = async () => false;
		await expect(
			assertTargetIsSafe(target, exists, directoryEntries),
		).resolves.toBeUndefined();

		await expect(
			assertTargetIsSafe(target, async () => true, directoryEntries),
		).resolves.toBeUndefined();

		for (const name of ['.git', '.flowdular', 'node_modules']) {
			await writeFile(join(target, name), '');
		}
		await expect(
			assertTargetIsSafe(target, async () => true, directoryEntries),
		).resolves.toBeUndefined();
	});

	it('names the offending entries so the operator can move them', async () => {
		const target = await empty();
		await writeFile(join(target, 'notes.txt'), 'hello');
		await writeFile(join(target, 'budget.csv'), 'x');
		await expect(
			assertTargetIsSafe(target, async () => true, directoryEntries),
		).rejects.toThrow(/budget\.csv, notes\.txt/);
	});

	it('resolves the target relative to where the command was run', () => {
		expect(workspaceTarget(undefined, 'flowdular')).toMatch(/\/flowdular$/);
		expect(workspaceTarget('my-company', 'flowdular')).toMatch(
			/[/\\]my-company$/,
		);
	});
});

describe('repository default', () => {
	it('points at the OSS repository', async () => {
		const { DEFAULT_REPOSITORY } = await import('../src/server/bootstrap.ts');
		expect(DEFAULT_REPOSITORY).toBe(
			'https://github.com/Flowdular/flowdular.git',
		);
	});
});

describe('empty directories', () => {
	it('reports no entries for a path that does not exist', async () => {
		expect(await readdir('/definitely/not/here').catch(() => [])).toEqual([]);
	});
});
