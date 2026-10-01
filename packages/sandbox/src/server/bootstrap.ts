import { spawn } from 'node:child_process';
import { access, mkdir, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export class BootstrapError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'BootstrapError';
	}
}

export interface BootstrapOptions {
	/* Where the workspace is created. */
	readonly target: string;
	/* The git ref to check out. A tag or a commit; never a branch, so the
	   clone is reproducible and a moved branch cannot change what a business
	   user installs. */
	readonly ref: string;
	readonly repository: string;
	readonly log?: (line: string) => void;
}

const OUTPUT_LIMIT = 8_000;

interface Run {
	readonly code: number | null;
	readonly output: string;
}

function run(
	command: string,
	args: readonly string[],
	cwd: string,
): Promise<Run> {
	return new Promise((resolvePromise) => {
		const child = spawn(command, [...args], {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let output = '';
		const append = (chunk: string) => {
			output = (output + chunk).slice(-OUTPUT_LIMIT);
		};
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', append);
		child.stderr.on('data', append);
		child.on('error', (error) =>
			resolvePromise({ code: null, output: error.message }),
		);
		child.on('close', (code) => resolvePromise({ code, output }));
	});
}

/* A business user arrives with an empty directory and no Node toolchain beyond
   what npm already needed. git and pnpm are the two things a clone-and-build
   cannot proceed without, so they are checked before anything is written
   rather than after a half-finished clone is left on disk. */
export async function assertBootstrapPrerequisites(
	which: (command: string) => Promise<boolean>,
): Promise<void> {
	const missing: string[] = [];
	for (const command of ['git', 'pnpm']) {
		if (!(await which(command))) missing.push(command);
	}
	if (missing.length === 0) return;
	throw new BootstrapError(
		'BOOTSTRAP_PREREQUISITE_MISSING',
		`Creating a workspace needs ${missing.join(' and ')}. Install ${
			missing.length === 1 ? 'it' : 'them'
		} and run this again. Node 22.22.2 or newer and pnpm 11 are expected.`,
	);
}

/* Cloning into a directory that already has unrelated content is the one
   mistake here that cannot be undone by deleting a file, so it is refused. */
export async function assertTargetIsSafe(
	target: string,
	exists: (path: string) => Promise<boolean>,
	entries: (path: string) => Promise<readonly string[]>,
): Promise<void> {
	if (!(await exists(target))) return;
	const present = await entries(target);
	const allowed = new Set(['.git', '.flowdular', '.coreloom', 'node_modules']);
	/* Sorted so the message names the same entries on every filesystem. */
	const unexpected = present.filter((name) => !allowed.has(name)).sort();
	if (unexpected.length === 0) return;
	throw new BootstrapError(
		'BOOTSTRAP_TARGET_NOT_EMPTY',
		`${target} already contains ${unexpected
			.slice(0, 5)
			.join(', ')}. Choose an empty directory with --workspace <path>.`,
	);
}

export interface BootstrapResult {
	readonly root: string;
	readonly steps: readonly string[];
}

/* The first run of a business user has to reach a working sandbox without a
   Flowdular checkout, a pnpm workspace or a git remote. This produces one: the
   OSS repository at a pinned ref, with dependencies installed, so
   `pnpm dev` and `pnpm sandbox` both work inside it. */
export async function bootstrapWorkspace(
	options: BootstrapOptions,
): Promise<BootstrapResult> {
	const log = options.log ?? (() => undefined);
	const root = resolve(options.target);
	await mkdir(root, { recursive: true });
	const steps: string[] = [];

	log(`Fetching ${options.repository} at ${options.ref}`);
	const clone = await run(
		'git',
		[
			'clone',
			'--depth',
			'1',
			'--branch',
			options.ref,
			'--single-branch',
			options.repository,
			root,
		],
		resolve(root, '..'),
	);
	if (clone.code !== 0) {
		throw new BootstrapError(
			'BOOTSTRAP_CLONE_FAILED',
			`git clone of ${options.repository} at ${options.ref} failed.\n${clone.output.trim()}`,
		);
	}
	steps.push(`cloned ${options.repository} at ${options.ref}`);

	log('Installing dependencies');
	const install = await run('pnpm', ['install', '--frozen-lockfile'], root);
	if (install.code !== 0) {
		throw new BootstrapError(
			'BOOTSTRAP_INSTALL_FAILED',
			`pnpm install failed in ${root}.\n${install.output.trim()}`,
		);
	}
	steps.push('installed dependencies with the committed lockfile');

	/* Verified rather than assumed: a workspace that looks cloned but has no
	   flowdular.json would fail later with a message about a missing file. */
	const configPath = join(root, 'flowdular.json');
	try {
		await access(configPath);
	} catch {
		throw new BootstrapError(
			'BOOTSTRAP_INCOMPLETE',
			`${root} has no flowdular.json, so it is not a Flowdular workspace.`,
		);
	}
	steps.push('verified flowdular.json');
	return { root, steps };
}

export const DEFAULT_REPOSITORY = 'https://github.com/Flowdular/flowdular.git';

/* A version the sandbox can vouch for. Refusing a moving branch is deliberate:
   a business user who runs this twice should get the same platform both times. */
export function assertRefIsPinned(ref: string): void {
	if (/^[0-9a-f]{40}$/.test(ref) || /^v\d+\.\d+\.\d+$/.test(ref)) return;
	throw new BootstrapError(
		'BOOTSTRAP_REF_NOT_PINNED',
		`--ref must be a version tag such as v0.4.3 or a full commit, not "${ref}". A branch can move, and a business user should get the same platform twice.`,
	);
}

export function workspaceTarget(
	argument: string | undefined,
	fallback: string,
): string {
	const value = argument ?? 'flowdular';
	return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
}

export async function directoryEntries(
	path: string,
): Promise<readonly string[]> {
	try {
		return await readdir(path);
	} catch {
		return [];
	}
}
