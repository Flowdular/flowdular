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
   may only leave changes in the one module and paths owned by its role.

   `node_modules` and friends used to be skipped outright, which made a write
   into `modules/<dir>/node_modules/pkg/file.js` invisible and unrestored. A
   pnpm dependency tree is a symlink farm into the shared store, so that write
   is an escape route rather than a cosmetic one. These directories are now
   detected with a structural fingerprint (no per-file hashing, so a large
   install stays affordable) and their contents are restorable. */
const PROTECTED_DIRECTORIES = new Set([
	'node_modules',
	'.git',
	'dist',
	'.turbo',
]);

/* The toolchain owns these, and a command the agent legitimately runs rewrites
   them on its way past: pnpm relinks and restamps its workspace state on almost
   any invocation, including the read-only ones a skill tells an agent to run.
   The sandbox runs the same install itself, so these files are regenerated
   outside the agent's control and carry nothing it authored.

   Treating that churn as a containment breach failed the whole turn and threw
   away the work: one real session wrote a complete specification and lost it
   because pnpm restamped a lockfile afterwards. Restoring them and reporting is
   the honest outcome, and nothing is delivered from any of them.

   The distinction is authorship, not location. A change to the *contents* of an
   installed package is still a violation: swapping a compiler out would make
   this session's own gates report on code they never checked. */
const TOOL_OWNED = [
	/* The directory itself, when pnpm creates one the session did not have yet.
	   Its contents are fingerprinted separately, so a package the model wrote
	   here is still a violation. */
	/^(?:node_modules|\.git|dist|\.turbo)$/,
	/^pnpm-lock\.yaml$/,
	/^node_modules\/\.modules\.yaml$/,
	/^node_modules\/\.package-map\.json$/,
	/^node_modules\/\.pnpm-workspace-state-v1\.json$/,
	/^node_modules\/\.pnpm\/lock\.yaml$/,
];

function isToolOwned(path: string): boolean {
	return TOOL_OWNED.some((pattern) => pattern.test(path));
}
const QUARANTINE_DIRECTORY = 'path-violations';
/* A dependency tree can hold tens of thousands of entries. Past these bounds
   the guard stops trusting its own picture and fails the turn closed rather
   than reporting a clean result it cannot substantiate. */
const PROTECTED_SCAN_LIMIT = 20_000;
const PROTECTED_BACKUP_BYTES = 1_048_576;
const PROTECTED_BACKUP_TOTAL_BYTES = 32_000_000;

type NodeKind = 'directory' | 'file' | 'symlink';

interface TreeNode {
	readonly path: string;
	readonly kind: NodeKind;
	readonly digest?: string;
	readonly target?: string;
	/* A protected directory is watched but never descended into by snapshot(). */
	readonly protected?: boolean;
}

export interface PathViolation {
	readonly path: string;
	readonly change: 'created' | 'modified' | 'deleted' | 'symlink-escape';
	readonly reason: string;
}

export interface PathGuardResult {
	readonly violations: readonly PathViolation[];
	/* Changes the toolchain made on the agent's behalf, restored and reported
	   without failing the turn. */
	readonly toolOwned: readonly string[];
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

interface ProtectedTree {
	/* relpath -> "kind:size:mtimeMs" for every entry, order-independent. */
	readonly fingerprint: ReadonlyMap<string, string>;
	/* Entries whose bytes were kept so a change can be reverted. */
	readonly backup: ReadonlyMap<string, Buffer>;
	readonly truncated: boolean;
	/* True when the scan hit its bound and the result cannot be trusted. */
	readonly overBudget: boolean;
}

async function discoverProtected(
	root: string,
	directory: string,
	found: string[],
	budget: { count: number; overBudget: boolean },
): Promise<void> {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (budget.overBudget || !entry.isDirectory()) continue;
		const fullPath = join(directory, entry.name);
		if (PROTECTED_DIRECTORIES.has(entry.name)) {
			found.push(fullPath);
			continue;
		}
		budget.count += 1;
		if (budget.count > PROTECTED_SCAN_LIMIT) {
			budget.overBudget = true;
			return;
		}
		await discoverProtected(root, fullPath, found, budget);
	}
}

async function fingerprintProtected(
	root: string,
	directory: string,
	state: {
		fingerprint: Map<string, string>;
		backup: Map<string, Buffer>;
		bytes: number;
		count: number;
		truncated: boolean;
		overBudget: boolean;
	},
): Promise<void> {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (state.overBudget) return;
		const fullPath = join(directory, entry.name);
		const path = relative(root, fullPath);
		let info;
		try {
			info = await lstat(fullPath);
		} catch {
			continue;
		}
		state.count += 1;
		if (state.count > PROTECTED_SCAN_LIMIT) {
			state.overBudget = true;
			return;
		}
		if (info.isSymbolicLink()) {
			state.fingerprint.set(path, `link:${await readlink(fullPath)}`);
			continue;
		}
		if (info.isDirectory()) {
			state.fingerprint.set(path, `dir`);
			await fingerprintProtected(root, fullPath, state);
			continue;
		}
		if (!info.isFile()) continue;
		if (state.truncated) {
			/* Past the backup bound the bytes are not held, so size and mtime are
			   the only cheap signals left. A same-size rewrite is reported by the
			   truncated flag below rather than silently accepted. */
			state.fingerprint.set(path, `file:${info.size}:${info.mtimeMs}`);
			continue;
		}
		if (info.size > PROTECTED_BACKUP_BYTES) {
			state.truncated = true;
			state.fingerprint.set(path, `file:${info.size}:${info.mtimeMs}`);
			continue;
		}
		if (state.bytes + info.size > PROTECTED_BACKUP_TOTAL_BYTES) {
			state.truncated = true;
			state.fingerprint.set(path, `file:${info.size}:${info.mtimeMs}`);
			continue;
		}
		try {
			const bytes = await readFile(fullPath);
			state.fingerprint.set(
				path,
				`file:${createHash('sha256').update(bytes).digest('hex')}`,
			);
			state.backup.set(path, bytes);
			state.bytes += bytes.length;
		} catch {
			state.truncated = true;
			state.fingerprint.set(path, `file:${info.size}:${info.mtimeMs}`);
		}
	}
}

/* Only dependency, VCS and build trees are fingerprinted. Source outside them
   is already covered by the hashed snapshot, and walking all of it twice would
   double the cost of every turn. */
async function protectedSnapshot(root: string): Promise<ProtectedTree> {
	const discovered: string[] = [];
	const discovery = { count: 0, overBudget: false };
	await discoverProtected(root, root, discovered, discovery);
	const state = {
		fingerprint: new Map<string, string>(),
		backup: new Map<string, Buffer>(),
		bytes: 0,
		count: 0,
		truncated: false,
		overBudget: discovery.overBudget,
	};
	for (const directory of discovered)
		await fingerprintProtected(root, directory, state);
	return { ...state, fingerprint: state.fingerprint, backup: state.backup };
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
		if (entry.isDirectory() && PROTECTED_DIRECTORIES.has(entry.name)) {
			/* Stop at any depth. Descending into a pnpm tree would hash every
			   file twice per turn, and the separate fingerprint pass already
			   covers the contents. */
			const protectedPath = join(directory, entry.name);
			const path = relativePath(root, protectedPath);
			nodes.set(path, { path, kind: 'directory', protected: true });
			continue;
		}
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

/* Puts back every baseline file whose bytes no longer match. Used for the
   tool-owned churn that must be undone without failing the turn. */
async function revert(
	root: string,
	baseline: ReadonlyMap<string, TreeNode>,
	backup: string,
	/* Files inside a protected directory never reach the hashed snapshot, so the
	   protected pass holds the bytes for those. */
	protectedBaseline: ProtectedTree,
): Promise<void> {
	const current = await snapshot(root);
	for (const [path, node] of baseline) {
		const now = current.get(path);
		if (!now || now.kind !== 'file') continue;
		const info = await lstat(join(root, path)).catch(() => null);
		if (!info?.isFile()) continue;
		if ((await digest(join(root, path))) === node.digest) continue;
		await mkdir(dirname(join(root, path)), { recursive: true });
		await copyFile(join(backup, path), join(root, path));
	}
	for (const [path, bytes] of protectedBaseline.backup) {
		if (!isToolOwned(path)) continue;
		const info = await lstat(join(root, path)).catch(() => null);
		if (!info?.isFile()) continue;
		if (Buffer.compare(await readFile(join(root, path)), bytes) === 0) continue;
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), bytes);
	}
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
	const baselineProtected = await protectedSnapshot(workspace);
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
			const toolOwned: string[] = [];
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
					if (isToolOwned(path)) {
						toolOwned.push(path);
						continue;
					}
					violations.push({
						path,
						change,
						reason: 'The path is outside this role and module allowlist.',
					});
				}
			}

			/* Compare the protected trees separately: snapshot() stops at their
			   boundary, so a change inside one is invisible to the loop above. */
			const currentProtected = await protectedSnapshot(workspace);
			const protectedViolations = protectedViolationsBetween(
				baselineProtected,
				currentProtected,
			);
			for (const { directory, ...violation } of protectedViolations) {
				if (directory || isToolOwned(violation.path)) {
					toolOwned.push(violation.path);
					continue;
				}
				violations.push({
					path: violation.path,
					change: violation.change,
					reason: violation.reason,
				});
			}

			if (violations.length === 0) {
				/* Tool-owned churn was still reverted, so the restore runs before
				   the early return. */
				await revert(workspace, baseline, backup, baselineProtected);
				/* The baseline is an enforcement aid, not session history. Retaining a
				   full copy on every successful turn leaks disk and duplicates any
				   sensitive attachment the role was allowed to read. */
				await rm(staging, { recursive: true, force: true });
				return { violations, toolOwned, quarantine: null };
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
			/* Put protected bytes back before discarding the evidence copy, so a
			   tampered dependency does not survive the turn that flagged it. */
			for (const [path, bytes] of baselineProtected.backup) {
				const stillChanged =
					currentProtected.fingerprint.get(path) !==
					baselineProtected.fingerprint.get(path);
				if (!stillChanged) continue;
				await mkdir(dirname(join(workspace, path)), { recursive: true });
				await writeFile(join(workspace, path), bytes);
			}
			await rm(backup, { recursive: true, force: true });
			/* The copied offenders are restored into the workspace above, so keeping
			   a second copy under the quarantine only multiplied every file the turn
			   touched. The evidence list is the record that matters. */
			await rm(join(staging, 'files'), { recursive: true, force: true });
			await mkdir(staging, { recursive: true, mode: 0o700 });
			await writeFile(
				join(staging, 'evidence.json'),
				`${JSON.stringify(
					{ allowedPaths: input.allowedPaths, violations },
					null,
					'\t',
				)}\n`,
				{ encoding: 'utf8', mode: 0o600 },
			);
			return { violations, toolOwned, quarantine: staging };
		},
	};
}

/* Anything that differs inside a protected tree is a violation: no role
   allowlist ever grants those paths, so a difference can only come from the
   model rather than from a gate or a formatter. When the scan outran its bound
   the guard says so instead of reporting a clean turn. */
interface ProtectedChange extends PathViolation {
	/* pnpm relinking creates directories; it does not author package file
	   contents. A directory entry therefore carries nothing the model wrote,
	   whatever it is nested under. */
	readonly directory: boolean;
}

function protectedViolationsBetween(
	before: ProtectedTree,
	after: ProtectedTree,
): ProtectedChange[] {
	if (before.overBudget || after.overBudget) {
		return [
			{
				path: '.',
				change: 'modified',
				reason:
					'The protected-path scan exceeded its bound, so the turn cannot be verified. Remove the oversized tree and retry.',
				directory: false,
			},
		];
	}
	const violations: ProtectedChange[] = [];
	for (const path of new Set([
		...before.fingerprint.keys(),
		...after.fingerprint.keys(),
	])) {
		const now = after.fingerprint.get(path) ?? '';
		if (before.fingerprint.get(path) === after.fingerprint.get(path)) continue;
		const existed = before.fingerprint.has(path);
		violations.push({
			path,
			change: existed ? 'modified' : 'created',
			reason:
				'The coding agent may not write into a dependency, VCS or build directory.',
			directory: now.startsWith('dir'),
		});
	}
	return violations;
}
