import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { findFlowdularWorkspace, SandboxSetupError } from './workspace-root.ts';
import { runBoundedProcess } from './process-command.ts';

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
	readonly timedOut?: boolean;
}

const GENERATOR_TIMEOUT_MS = 5 * 60_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
const GIT_TIMEOUT_MS = 5 * 60_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;

function commandTimeout(command: string, args: readonly string[]): number {
	if (command === 'pnpm') return INSTALL_TIMEOUT_MS;
	if (command === 'git')
		return args[0] === 'clone' ? CLONE_TIMEOUT_MS : GIT_TIMEOUT_MS;
	return GENERATOR_TIMEOUT_MS;
}

export async function spawnBootstrapCommand(
	command: string,
	args: readonly string[],
	cwd: string,
	environment: NodeJS.ProcessEnv = process.env,
	timeoutMs = commandTimeout(command, args),
): Promise<Run> {
	return runBoundedProcess(command, args, {
		cwd,
		env: environment,
		timeoutMs,
		outputLimit: OUTPUT_LIMIT,
	});
}

/* Both project creation paths need git and pnpm after the generator or clone.
   Check before writing a partial workspace. */
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
		`Creating an app needs ${missing.join(' and ')}. Install ${
			missing.length === 1 ? 'it' : 'them'
		} and run this again. Node 22.22.2 or newer and pnpm 11 are expected.`,
	);
}

/* The generator and git clone both require an empty target. */
export async function assertTargetIsSafe(
	target: string,
	exists: (path: string) => Promise<boolean>,
	entries: (path: string) => Promise<readonly string[]>,
): Promise<void> {
	if (!(await exists(target))) return;
	const present = await entries(target);
	/* Sorted so the message names the same entries on every filesystem. */
	const unexpected = [...present].sort();
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

const require = createRequire(import.meta.url);
const STARTER_IDENTITY = {
	name: 'Flowdular Starter',
	email: 'starter@flowdular.local',
} as const;

export interface ApplicationBootstrapOptions {
	readonly target: string;
	readonly version: string;
	readonly log?: (line: string) => void;
}

export interface ApplicationBootstrapDependencies {
	readonly generator?: () => Promise<string>;
	readonly execute?: typeof spawnBootstrapCommand;
}

async function generatorBinary(expectedVersion: string): Promise<string> {
	let metadataPath: string;
	try {
		metadataPath = require.resolve('create-flowdular/package.json');
	} catch {
		throw new BootstrapError(
			'BOOTSTRAP_GENERATOR_MISSING',
			'create-flowdular is missing from this sandbox installation. Reinstall @flowdular/sandbox.',
		);
	}
	const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
		version?: string;
		bin?: { 'create-flowdular'?: string };
	};
	if (metadata.version !== expectedVersion) {
		throw new BootstrapError(
			'BOOTSTRAP_GENERATOR_VERSION',
			`This sandbox is ${expectedVersion}, but its create-flowdular dependency is ${metadata.version ?? 'unknown'}. Reinstall @flowdular/sandbox.`,
		);
	}
	const binary = metadata.bin?.['create-flowdular'];
	if (!binary) {
		throw new BootstrapError(
			'BOOTSTRAP_GENERATOR_MISSING',
			'create-flowdular has no executable in this sandbox installation.',
		);
	}
	return resolve(dirname(metadataPath), binary);
}

async function verifyWorkspaceManifest(root: string): Promise<void> {
	try {
		const config = JSON.parse(
			await readFile(join(root, 'flowdular.json'), 'utf8'),
		) as {
			schemaVersion?: unknown;
			modules?: unknown;
		};
		if (config.schemaVersion === 1 && config.modules) return;
	} catch {
		/* Report the same clear error for a missing or invalid manifest. */
	}
	throw new BootstrapError(
		'BOOTSTRAP_INCOMPLETE',
		`${root} has no valid flowdular.json, so it is not a Flowdular workspace.`,
	);
}

/* Use the published generator shipped at the sandbox's exact version. Its CLI
   deliberately continues after install or git errors; the launcher performs
   those steps itself so a failed bootstrap cannot look successful. */
export async function bootstrapApplication(
	options: ApplicationBootstrapOptions,
	dependencies: ApplicationBootstrapDependencies = {},
): Promise<BootstrapResult> {
	const root = resolve(options.target);
	const log = options.log ?? (() => undefined);
	const execute = dependencies.execute ?? spawnBootstrapCommand;
	const generator = await (dependencies.generator?.() ??
		generatorBinary(options.version));
	const steps: string[] = [];
	log(`Creating a Flowdular app with create-flowdular ${options.version}`);
	const scaffolded = await execute(
		process.execPath,
		[generator, basename(root), '--no-install', '--no-git'],
		dirname(root),
	);
	if (scaffolded.code !== 0) {
		if (scaffolded.timedOut)
			throw new BootstrapError(
				'BOOTSTRAP_GENERATOR_TIMEOUT',
				`create-flowdular did not finish within 5 minutes for ${root}. Check the target and try again.`,
			);
		throw new BootstrapError(
			'BOOTSTRAP_GENERATOR_FAILED',
			`create-flowdular failed for ${root}. Check the target and run this again.`,
		);
	}
	await verifyWorkspaceManifest(root);
	steps.push(`created standalone app with create-flowdular ${options.version}`);

	log('Installing application dependencies');
	const installed = await execute('pnpm', ['install'], root);
	if (installed.code !== 0) {
		if (installed.timedOut)
			throw new BootstrapError(
				'BOOTSTRAP_INSTALL_TIMEOUT',
				`pnpm install did not finish within 15 minutes in ${root}. Check package scripts and registry access, then try again.`,
			);
		throw new BootstrapError(
			'BOOTSTRAP_INSTALL_FAILED',
			`pnpm install failed in ${root}. Run it there to see the package manager error.`,
		);
	}
	steps.push('installed application dependencies');

	const init = await execute('git', ['init', '-b', 'main'], root);
	if (init.code !== 0) {
		if (init.timedOut)
			throw new BootstrapError(
				'BOOTSTRAP_GIT_TIMEOUT',
				`git init did not finish within 5 minutes in ${root}. Check Git and try again.`,
			);
		throw new BootstrapError(
			'BOOTSTRAP_GIT_FAILED',
			`git init failed in ${root}.`,
		);
	}
	const staged = await execute('git', ['add', '-A'], root);
	if (staged.code !== 0) {
		if (staged.timedOut)
			throw new BootstrapError(
				'BOOTSTRAP_GIT_TIMEOUT',
				`git add did not finish within 5 minutes in ${root}. Check Git and try again.`,
			);
		throw new BootstrapError(
			'BOOTSTRAP_GIT_FAILED',
			`git add failed in ${root}.`,
		);
	}
	const commit = await execute(
		'git',
		['commit', '-m', 'chore: scaffold Flowdular app'],
		root,
		{
			...process.env,
			GIT_AUTHOR_NAME: STARTER_IDENTITY.name,
			GIT_AUTHOR_EMAIL: STARTER_IDENTITY.email,
			GIT_COMMITTER_NAME: STARTER_IDENTITY.name,
			GIT_COMMITTER_EMAIL: STARTER_IDENTITY.email,
		},
	);
	if (commit.code !== 0) {
		if (commit.timedOut)
			throw new BootstrapError(
				'BOOTSTRAP_GIT_TIMEOUT',
				`git commit did not finish within 5 minutes in ${root}. Check Git and try again.`,
			);
		throw new BootstrapError(
			'BOOTSTRAP_GIT_FAILED',
			`The first git commit failed in ${root}.`,
		);
	}
	steps.push(`made first local commit as ${STARTER_IDENTITY.name}`);
	steps.push('verified flowdular.json');
	return { root, steps };
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

	log('Fetching the workspace source');
	const clone = await spawnBootstrapCommand(
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
		if (clone.timedOut)
			throw new BootstrapError(
				'BOOTSTRAP_CLONE_TIMEOUT',
				`git clone did not finish within 10 minutes. Check the repository and network, then try again.`,
			);
		throw new BootstrapError(
			'BOOTSTRAP_CLONE_FAILED',
			'git clone failed. Check the repository, network and access, then try again.',
		);
	}
	steps.push('cloned the workspace source');

	log('Installing dependencies');
	const install = await spawnBootstrapCommand(
		'pnpm',
		['install', '--frozen-lockfile'],
		root,
	);
	if (install.code !== 0) {
		if (install.timedOut)
			throw new BootstrapError(
				'BOOTSTRAP_INSTALL_TIMEOUT',
				`pnpm install did not finish within 15 minutes in ${root}. Check package scripts and registry access, then try again.`,
			);
		throw new BootstrapError(
			'BOOTSTRAP_INSTALL_FAILED',
			`pnpm install failed in ${root}. Run it there to see the package manager error.`,
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
	cwd = process.cwd(),
): string {
	const value = argument ?? fallback;
	return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

export interface PrepareWorkspaceOptions {
	readonly cwd: string;
	readonly workspaceArgument?: string;
	readonly bootstrap: 'auto' | 'always' | 'never';
	readonly ref: string;
	readonly repository: string;
	readonly version?: string;
	readonly cloneRepository?: boolean;
}

export interface PrepareWorkspaceDependencies {
	readonly probe: (command: string) => Promise<boolean>;
	readonly clone?: (options: BootstrapOptions) => Promise<BootstrapResult>;
	readonly create?: (
		options: ApplicationBootstrapOptions,
	) => Promise<BootstrapResult>;
	readonly exists?: (path: string) => Promise<boolean>;
	readonly entries?: (path: string) => Promise<readonly string[]>;
	readonly findWorkspace?: typeof findFlowdularWorkspace;
	readonly log?: (line: string) => void;
}

export interface PreparedWorkspace {
	readonly root: string;
	readonly created: boolean;
	readonly steps: readonly string[];
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/* Resolve an existing checkout by its manifest, not by the existence of its
   directory. A new run in an empty cwd creates ./flowdular; a later run from
   that same cwd reuses it. The clone is injected so the selection and setup
   flow can be tested without fetching a repository. */
export async function prepareWorkspace(
	options: PrepareWorkspaceOptions,
	dependencies: PrepareWorkspaceDependencies,
): Promise<PreparedWorkspace> {
	const exists = dependencies.exists ?? pathExists;
	const findWorkspace = dependencies.findWorkspace ?? findFlowdularWorkspace;
	const log = dependencies.log ?? (() => undefined);
	const target = workspaceTarget(
		options.workspaceArgument,
		'flowdular',
		options.cwd,
	);
	const manifestExists = async (root: string) =>
		exists(join(root, 'flowdular.json'));

	if (
		options.bootstrap !== 'always' &&
		options.workspaceArgument === undefined
	) {
		try {
			const workspace = await findWorkspace(options.cwd);
			return { root: workspace.root, created: false, steps: [] };
		} catch (error) {
			if (
				!(error instanceof SandboxSetupError) ||
				error.code !== 'WORKSPACE_NOT_FOUND'
			)
				throw error;
		}
	}

	if (await manifestExists(target)) {
		if (options.bootstrap === 'always') {
			throw new BootstrapError(
				'BOOTSTRAP_TARGET_IS_WORKSPACE',
				`--bootstrap was given but ${target} is already a Flowdular workspace.`,
			);
		}
		const workspace = await findWorkspace(target);
		if (workspace.root === target)
			return { root: target, created: false, steps: [] };
	}

	if (options.bootstrap === 'never') {
		throw new BootstrapError(
			'WORKSPACE_NOT_FOUND',
			`No Flowdular workspace was found at ${target}. Remove --no-bootstrap or choose one with --workspace <path>.`,
		);
	}

	if (options.cloneRepository) assertRefIsPinned(options.ref);
	await assertBootstrapPrerequisites(dependencies.probe);
	await assertTargetIsSafe(
		target,
		exists,
		dependencies.entries ?? directoryEntries,
	);
	log(`No Flowdular workspace found. Creating one in ${target}`);
	const result = options.cloneRepository
		? await (dependencies.clone ?? bootstrapWorkspace)({
				target,
				ref: options.ref,
				repository: options.repository,
				log,
			})
		: await (dependencies.create ?? bootstrapApplication)({
				target,
				version: options.version ?? options.ref.replace(/^v/, ''),
				log,
			});
	for (const step of result.steps) log(`ok ${step}`);
	return { root: result.root, created: true, steps: result.steps };
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
