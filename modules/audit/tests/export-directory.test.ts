import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	AUDIT_EXPORT_DIRECTORY_VARIABLE,
	exportOutputDirectory,
} from '../src/services/export-directory.ts';

let root: string;
let allowed: string;
let outside: string;
let workspaceRoot: string;

beforeAll(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'audit-directory-')));
	allowed = resolve(root, 'allowed');
	outside = resolve(root, 'outside');
	workspaceRoot = resolve(root, 'workspace');
	await mkdir(allowed, { recursive: true });
	await mkdir(outside, { recursive: true });
	await mkdir(workspaceRoot, { recursive: true });
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

function resolveDirectory(requested: string, configured = allowed): string {
	return exportOutputDirectory({
		environment: {
			NODE_ENV: 'test',
			[AUDIT_EXPORT_DIRECTORY_VARIABLE]: configured,
		},
		workspaceRoot,
		requested,
	});
}

describe('export output directory', () => {
	it('accepts a directory inside the allowed one, existing or not', () => {
		expect(resolveDirectory(allowed)).toBe(allowed);
		expect(resolveDirectory(resolve(allowed, 'later', 'still-later'))).toBe(
			resolve(allowed, 'later', 'still-later'),
		);
	});

	/* A link inside the allowed directory resolves textually to a path under it
	   and physically to wherever it points, so a containment check on the text
	   alone would let a command write a workspace's archive anywhere the process
	   can reach. */
	it('refuses a path that leaves the allowed directory through a symbolic link', async () => {
		await symlink(outside, resolve(allowed, 'escape'), 'dir');

		expect(() => resolveDirectory(resolve(allowed, 'escape'))).toThrow(
			/EXPORT_OUTPUT_NOT_ALLOWED|outside/,
		);
		expect(() =>
			resolveDirectory(resolve(allowed, 'escape', 'archives')),
		).toThrow(/EXPORT_OUTPUT_NOT_ALLOWED|outside/);
	});

	it('accepts a link that stays inside the allowed directory', async () => {
		const target = resolve(allowed, 'archives');
		await mkdir(target, { recursive: true });
		await symlink(target, resolve(allowed, 'current'), 'dir');

		expect(resolveDirectory(resolve(allowed, 'current'))).toBe(target);
	});

	/* The same rule the other way: an allowed directory that is itself a link
	   into the application tree is refused, because a deployment step could
	   commit or serve what lands there. */
	it('refuses an allowed directory that links into the workspace tree', async () => {
		const inside = resolve(workspaceRoot, 'exports');
		await mkdir(inside, { recursive: true });
		const link = resolve(root, 'linked-allowed');
		await symlink(inside, link, 'dir');

		expect(() => resolveDirectory(link, link)).toThrow(
			/EXPORT_OUTPUT_INSIDE_WORKSPACE|inside the workspace tree/,
		);
	});
});
