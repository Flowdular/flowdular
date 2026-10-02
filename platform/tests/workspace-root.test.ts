import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { findWorkspaceRoot } from '../src/server/workspace-root.ts';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

it('finds workspace files from development and bundled Docker entry locations', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-workspace-root-'));
	roots.push(root);
	const platform = join(root, 'platform');
	const bundled = join(platform, 'dist', 'server');
	await mkdir(bundled, { recursive: true });
	expect(findWorkspaceRoot(platform)).toBe(root);
	expect(findWorkspaceRoot(bundled)).toBe(root);
});

it('fails clearly for an unsupported bundle layout', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-no-workspace-'));
	roots.push(root);
	expect(() => findWorkspaceRoot(join(root, 'unknown', 'entry'))).toThrow(
		/layout/,
	);
});
