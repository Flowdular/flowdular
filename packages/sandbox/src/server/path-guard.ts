import { createHash, randomUUID } from 'node:crypto';
import {
	copyFile,
	lstat,
	mkdir,
	readFile,
	readdir,
	readlink,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/* This is a post-turn containment boundary, not an instruction for the model.
   The agent receives a complete workspace so it can read its contracts, but it
   may only leave changes in the one module and paths owned by its role. */
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', '.turbo']);
const QUARANTINE_DIRECTORY = 'path-violations';

type NodeKind = 'directory' | 'file' | 'symlink';

interface TreeNode {
	readonly path: string;
	readonly kind: NodeKind;
	readonly digest?: string;
	readonly target?: string;
}

export interface PathViolation {
	readonly path: string;
	readonly change: 'created' | 'modified' | 'deleted' | 'symlink-escape';
	readonly reason: string;
}

export interface PathGuardResult {
	readonly violations: readonly PathViolation[];
	readonly quarantine: string | null;
}

export interface PathGuard {
	verify(): Promise<PathGuardResult>;
}

function normalPath(value: string): string {
	return value.split(sep).join('/');
}

function relativePath(root: string, path: string): string {
	const result = relative(root, path);
	if (!result || result.startsWith('..') || isAbsolute(result)) {
		throw new Error('Path is outside the guarded workspace.');
	}
	return normalPath(result);
}

function matchesPath(path: string, pattern: string): boolean {
	/* `**` may span path segments while `*` remains in one segment. */
	const source = pattern
		.split(/(\*\*|\*)/)
		.map((part) => {
			if (part === '**') return '.*';
			if (part === '*') return '[^/]*';
			return part.replace(/[.+?^$()|[\]\\]/g, '\\$&');
		})
		.join('');
	return new RegExp(`^${source}$`).test(path);
}

function allowed(path: string, patterns: readonly string[]): boolean {
	return patterns.some(
		(pattern) => matchesPath(path, pattern) || pattern.startsWith(`${path}/`),
	);
}

async function digest(path: string): Promise<string> {
	return createHash('sha256')
		.update(await readFile(path))
		.digest('hex');
}

async function snapshot(
	root: string,
	directory = root,
): Promise<Map<string, TreeNode>> {
	const nodes = new Map<string, TreeNode>();
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return nodes;
	}
	for (const entry of entries) {
		if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
		const fullPath = join(directory, entry.name);
		const path = relativePath(root, fullPath);
		const info = await lstat(fullPath);
		if (info.isSymbolicLink()) {
			nodes.set(path, {
				path,
				kind: 'symlink',
				target: await readlink(fullPath),
			});
			continue;
		}
		if (info.isDirectory()) {
			nodes.set(path, { path, kind: 'directory' });
			for (const [childPath, child] of await snapshot(root, fullPath)) {
				nodes.set(childPath, child);
			}
			continue;
		}
		if (info.isFile()) {
			nodes.set(path, { path, kind: 'file', digest: await digest(fullPath) });
		}
	}
	return nodes;
}

function changed(
	before: TreeNode | undefined,
	after: TreeNode | undefined,
): PathViolation['change'] | null {
	if (!before && after) return 'created';
	if (before && !after) return 'deleted';
	if (!before || !after) return null;
	if (before.kind !== after.kind) return 'modified';
	if (before.kind === 'file' && before.digest !== after.digest)
		return 'modified';
	if (before.kind === 'symlink' && before.target !== after.target)
		return 'modified';
	return null;
}

function symlinkEscapes(root: string, path: string, target: string): boolean {
	const resolved = resolve(dirname(join(root, path)), target);
	const inside = relative(root, resolved);
	return inside.startsWith('..') || isAbsolute(inside);
}

async function saveBaseline(
	root: string,
	backup: string,
	nodes: ReadonlyMap<string, TreeNode>,
): Promise<void> {
	for (const node of nodes.values()) {
		if (node.kind !== 'file') continue;
		const target = join(backup, node.path);
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		await copyFile(join(root, node.path), target);
	}
}

async function removeAt(root: string, path: string): Promise<void> {
	await rm(join(root, path), { recursive: true, force: true });
}

async function restoreNode(
	root: string,
	backup: string,
	node: TreeNode,
): Promise<void> {
	const target = join(root, node.path);
	if (node.kind === 'directory') {
		await mkdir(target, { recursive: true, mode: 0o700 });
		return;
	}
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	await rm(target, { recursive: true, force: true });
	if (node.kind === 'file') {
		await copyFile(join(backup, node.path), target);
		return;
	}
	await symlink(node.target!, target);
}

async function quarantineCurrent(
	root: string,
	directory: string,
	path: string,
): Promise<void> {
	const source = join(root, path);
	const target = join(directory, 'files', path);
	try {
		const info = await lstat(source);
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		if (info.isSymbolicLink()) await symlink(await readlink(source), target);
		else if (info.isFile()) await copyFile(source, target);
	} catch {
		/* The evidence file still names a path that raced away before quarantine. */
	}
}

/* Baselines are outside the workspace and every restore uses lstat/rm, so a
   new symlink is removed rather than followed. The guard deliberately refuses
   a changed symlink whose target leaves the workspace: that shape is an escape
   hatch even when its own pathname matches an allowed glob. */
export async function guardAgentPaths(input: {
	readonly workspace: string;
	readonly sessionRoot: string;
	readonly allowedPaths: readonly string[];
}): Promise<PathGuard> {
	const workspace = resolve(input.workspace);
	const baseline = await snapshot(workspace);
	const staging = join(
		input.sessionRoot,
		QUARANTINE_DIRECTORY,
		`${Date.now()}-${randomUUID()}`,
	);
	const backup = join(staging, 'baseline');
	await saveBaseline(workspace, backup, baseline);

	return {
		verify: async () => {
			const current = await snapshot(workspace);
			const paths = new Set([...baseline.keys(), ...current.keys()]);
			const violations: PathViolation[] = [];
			for (const path of [...paths].sort()) {
				const before = baseline.get(path);
				const after = current.get(path);
				const change = changed(before, after);
				if (!change) continue;
				if (
					after?.kind === 'symlink' &&
					symlinkEscapes(workspace, path, after.target!)
				) {
					violations.push({
						path,
						change: 'symlink-escape',
						reason:
							'The changed path is a symbolic link that leaves the session workspace.',
					});
					continue;
				}
				if (!allowed(path, input.allowedPaths)) {
					violations.push({
						path,
						change,
						reason: 'The path is outside this role and module allowlist.',
					});
				}
			}
			if (violations.length === 0) {
				/* The baseline is an enforcement aid, not session history. Retaining a
				   full copy on every successful turn leaks disk and duplicates any
				   sensitive attachment the role was allowed to read. */
				await rm(staging, { recursive: true, force: true });
				return { violations, quarantine: null };
			}

			for (const violation of violations)
				await quarantineCurrent(workspace, staging, violation.path);
			/* Remove offenders deepest first. A created parent cannot leave a child
			   behind, and `rm` unlinks a symlink without following it. */
			for (const violation of [...violations].sort(
				(left, right) => right.path.length - left.path.length,
			)) {
				await removeAt(workspace, violation.path);
			}
			/* Restore every baseline node below an offending path. This also repairs
			   a file replaced by a symlink, without traversing that link. */
			const restore = [...baseline.values()]
				.filter((node) =>
					violations.some(
						(violation) =>
							node.path === violation.path ||
							node.path.startsWith(`${violation.path}/`),
					),
				)
				.sort((left, right) => left.path.length - right.path.length);
			for (const node of restore) await restoreNode(workspace, backup, node);
			await rm(backup, { recursive: true, force: true });
			await mkdir(staging, { recursive: true, mode: 0o700 });
			await writeFile(
				join(staging, 'evidence.json'),
				`${JSON.stringify({ allowedPaths: input.allowedPaths, violations }, null, '\t')}\n`,
				{ encoding: 'utf8', mode: 0o600 },
			);
			return { violations, quarantine: staging };
		},
	};
}
