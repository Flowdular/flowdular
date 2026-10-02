import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SandboxSetupError } from './workspace-root.ts';
import { runBoundedProcess } from './process-command.ts';

export class GitWorkspaceError extends SandboxSetupError {
	constructor(code: string, message: string) {
		super(code, message);
		this.name = 'GitWorkspaceError';
	}
}

export interface CloneGitWorkspaceOptions {
	readonly repository: string;
	readonly target: string;
	readonly branch?: string;
}

export interface GitWorkspaceCommandResult {
	readonly code: number | null;
	readonly timedOut?: boolean;
}

export interface GitWorkspaceCommandOptions {
	readonly timeoutMs?: number;
}

export type GitWorkspaceCommandRunner = (
	command: string,
	args: readonly string[],
	cwd: string,
	options?: GitWorkspaceCommandOptions,
) => Promise<GitWorkspaceCommandResult>;

export interface CloneGitWorkspaceDependencies {
	readonly run?: GitWorkspaceCommandRunner;
}

export interface ClonedGitWorkspace {
	readonly root: string;
	readonly steps: readonly string[];
}

/* A cloned repository may run package scripts during installation. Give those
   scripts the executable path and normal local user paths, but not unrelated
   tokens or database credentials inherited by the sandbox process. */
const COMMAND_ENVIRONMENT_KEYS = new Set([
	'HOME',
	'LANG',
	'LC_ALL',
	'LC_CTYPE',
	'LOGNAME',
	'PATH',
	'SHELL',
	'SSH_AUTH_SOCK',
	'SSL_CERT_DIR',
	'SSL_CERT_FILE',
	'TEMP',
	'TMP',
	'TMPDIR',
	'USER',
	'XDG_CACHE_HOME',
	'XDG_CONFIG_HOME',
	'XDG_DATA_HOME',
	'XDG_STATE_HOME',
]);

function commandEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && COMMAND_ENVIRONMENT_KEYS.has(key))
			env[key] = value;
	}
	return env;
}

const CLONE_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;

export const spawnGitWorkspaceCommand: GitWorkspaceCommandRunner = async (
	command,
	args,
	cwd,
	options,
) => {
	const result = await runBoundedProcess(command, args, {
		cwd,
		env: { ...commandEnvironment(), GIT_TERMINAL_PROMPT: '0' },
		timeoutMs:
			options?.timeoutMs ??
			(command === 'pnpm' ? INSTALL_TIMEOUT_MS : CLONE_TIMEOUT_MS),
		outputLimit: 0,
	});
	return { code: result.code, timedOut: result.timedOut };
};

interface RepositorySource {
	readonly argument: string;
	readonly localPath: string | null;
}

function invalidRepository(): never {
	throw new GitWorkspaceError(
		'GIT_WORKSPACE_REPOSITORY_INVALID',
		'Use a local Git path, an HTTPS or SSH Git URL, or an SSH remote such as git@host:owner/repo.git. Do not put credentials in the URL.',
	);
}

function repositorySource(repository: string): RepositorySource {
	if (
		!repository ||
		repository !== repository.trim() ||
		repository.startsWith('-') ||
		/[\x00-\x1f\x7f]/.test(repository)
	)
		return invalidRepository();

	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repository)) {
		let url: URL;
		try {
			url = new URL(repository);
		} catch {
			return invalidRepository();
		}
		if (
			url.password ||
			(url.username &&
				(url.protocol !== 'ssh:' || !/^[a-zA-Z0-9._-]+$/.test(url.username))) ||
			url.search ||
			url.hash ||
			!url.pathname ||
			url.pathname === '/'
		)
			return invalidRepository();
		if (url.protocol === 'file:') {
			if (url.hostname) return invalidRepository();
			try {
				const localPath = fileURLToPath(url);
				return { argument: localPath, localPath };
			} catch {
				return invalidRepository();
			}
		}
		if ((url.protocol !== 'https:' && url.protocol !== 'ssh:') || !url.hostname)
			return invalidRepository();
		if (url.protocol === 'ssh:' && !/^[A-Za-z0-9._/~+-]+$/.test(url.pathname))
			return invalidRepository();
		return { argument: repository, localPath: null };
	}
	if (
		isAbsolute(repository) ||
		repository.startsWith('./') ||
		repository.startsWith('../') ||
		repository.startsWith('.\\') ||
		repository.startsWith('..\\')
	) {
		const localPath = resolve(repository);
		return { argument: localPath, localPath };
	}

	/* A colon outside a URL is only accepted in Git's SSH scp syntax. Other
	   forms include remote helpers, which can execute arbitrary local programs. */
	if (repository.includes(':')) {
		if (
			!/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9~/][A-Za-z0-9._/~+-]*$/.test(
				repository,
			)
		)
			return invalidRepository();
		return { argument: repository, localPath: null };
	}

	const localPath = resolve(repository);
	return { argument: localPath, localPath };
}

function targetPath(target: string): string {
	if (!target || target !== target.trim() || /[\x00-\x1f\x7f]/.test(target)) {
		throw new GitWorkspaceError(
			'GIT_WORKSPACE_TARGET_INVALID',
			'Choose a directory path for the connected workspace.',
		);
	}
	return resolve(target);
}

function isAtOrInside(path: string, parent: string): boolean {
	const remainder = relative(parent, path);
	return (
		remainder === '' ||
		(remainder !== '..' &&
			!remainder.startsWith(`..${sep}`) &&
			!isAbsolute(remainder))
	);
}

async function physicalTarget(root: string): Promise<string> {
	let ancestor = root;
	for (;;) {
		try {
			return resolve(await realpath(ancestor), relative(ancestor, root));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw new GitWorkspaceError(
					'GIT_WORKSPACE_TARGET_UNAVAILABLE',
					'The destination cannot be inspected. Check its permissions and choose another path if needed.',
				);
			}
			const parent = dirname(ancestor);
			if (parent === ancestor) throw error;
			ancestor = parent;
		}
	}
}

async function assertTargetIsSafe(
	root: string,
	source: RepositorySource,
): Promise<void> {
	const sourcePath = source.localPath
		? await realpath(source.localPath).catch(() => source.localPath!)
		: null;
	if (
		sourcePath &&
		(isAtOrInside(root, sourcePath) ||
			isAtOrInside(await physicalTarget(root), sourcePath))
	) {
		throw new GitWorkspaceError(
			'GIT_WORKSPACE_TARGET_UNSAFE',
			'The destination cannot be inside the repository being cloned. Choose a separate directory.',
		);
	}
	try {
		const entry = await lstat(root);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new GitWorkspaceError(
				'GIT_WORKSPACE_TARGET_UNSAFE',
				'The destination must be a real, empty directory. Choose another path.',
			);
		}
		if ((await readdir(root)).length > 0) {
			throw new GitWorkspaceError(
				'GIT_WORKSPACE_TARGET_OCCUPIED',
				'The destination already contains files. Choose an empty directory for the connected workspace.',
			);
		}
	} catch (error) {
		if (error instanceof GitWorkspaceError) throw error;
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw new GitWorkspaceError(
				'GIT_WORKSPACE_TARGET_UNAVAILABLE',
				'The destination cannot be inspected. Check its permissions and choose another path if needed.',
			);
		}
	}
}

async function assertFlowdularManifest(root: string): Promise<void> {
	let content: string;
	try {
		const entry = await lstat(join(root, 'flowdular.json'));
		if (!entry.isFile() || entry.size > 1024 * 1024) {
			throw new GitWorkspaceError(
				'GIT_WORKSPACE_MANIFEST_INVALID',
				'This repository has an invalid flowdular.json. It must be a regular JSON file under 1 MB.',
			);
		}
		content = await readFile(join(root, 'flowdular.json'), 'utf8');
	} catch (error) {
		if (error instanceof GitWorkspaceError) throw error;
		throw new GitWorkspaceError(
			'GIT_WORKSPACE_MANIFEST_MISSING',
			'This repository has no flowdular.json at its root. Connect a Flowdular platform repository.',
		);
	}
	let config: unknown;
	try {
		config = JSON.parse(content);
	} catch {
		throw new GitWorkspaceError(
			'GIT_WORKSPACE_MANIFEST_INVALID',
			'This repository has an invalid flowdular.json. Fix the JSON in the repository and try again.',
		);
	}
	if (
		typeof config !== 'object' ||
		config === null ||
		Array.isArray(config) ||
		(config as Record<string, unknown>).schemaVersion !== 1 ||
		typeof (config as Record<string, unknown>).modules !== 'object' ||
		(config as Record<string, unknown>).modules === null ||
		Array.isArray((config as Record<string, unknown>).modules)
	) {
		throw new GitWorkspaceError(
			'GIT_WORKSPACE_MANIFEST_INVALID',
			'This repository has no valid Flowdular project manifest. Check flowdular.json and try again.',
		);
	}
}

async function runOrFail(
	run: GitWorkspaceCommandRunner,
	command: string,
	args: readonly string[],
	cwd: string,
	code: string,
	message: string,
	timeoutCode: string,
	timeoutMessage: string,
): Promise<void> {
	try {
		const result = await run(command, args, cwd);
		if (result.code === 0) return;
		if (result.timedOut)
			throw new GitWorkspaceError(timeoutCode, timeoutMessage);
	} catch (error) {
		if (error instanceof GitWorkspaceError) throw error;
		/* Tool output may contain a remote URL or credentials. */
	}
	throw new GitWorkspaceError(code, message);
}

/* Connects an existing platform repository to a new local workspace. The
   remote and branch are always separate Git arguments; command output is
   intentionally omitted from errors because Git may echo URL credentials. */
export async function cloneGitWorkspace(
	options: CloneGitWorkspaceOptions,
	dependencies: CloneGitWorkspaceDependencies = {},
): Promise<ClonedGitWorkspace> {
	const source = repositorySource(options.repository);
	const root = targetPath(options.target);
	if (options.branch !== undefined) {
		if (
			!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(options.branch) ||
			options.branch.includes('..') ||
			options.branch.includes('//') ||
			options.branch.endsWith('/') ||
			options.branch.endsWith('.') ||
			options.branch.endsWith('.lock')
		) {
			throw new GitWorkspaceError(
				'GIT_WORKSPACE_BRANCH_INVALID',
				'Choose a valid Git branch name or omit the branch to use the repository default.',
			);
		}
	}
	await assertTargetIsSafe(root, source);
	try {
		await mkdir(dirname(root), { recursive: true });
	} catch {
		throw new GitWorkspaceError(
			'GIT_WORKSPACE_TARGET_UNAVAILABLE',
			'The destination parent cannot be created. Check its permissions and choose another path if needed.',
		);
	}
	const run = dependencies.run ?? spawnGitWorkspaceCommand;
	const args = ['clone'];
	if (options.branch !== undefined) {
		args.push('--branch', options.branch, '--single-branch');
	}
	args.push('--', source.argument, root);
	await runOrFail(
		run,
		'git',
		args,
		dirname(root),
		'GIT_WORKSPACE_CLONE_FAILED',
		'Git could not clone the repository. Check that Git is installed, then check the remote, your access, and the branch name.',
		'GIT_WORKSPACE_CLONE_TIMEOUT',
		'Git did not finish cloning within 10 minutes. Check the remote and your network, then try again.',
	);
	await assertFlowdularManifest(root);
	try {
		const entry = await lstat(join(root, 'pnpm-lock.yaml'));
		if (!entry.isFile() || entry.size > 20 * 1024 * 1024) {
			throw new GitWorkspaceError(
				'GIT_WORKSPACE_LOCKFILE_INVALID',
				'This repository has no regular pnpm-lock.yaml under 20 MB. Commit a normal lockfile before connecting it.',
			);
		}
	} catch (error) {
		if (error instanceof GitWorkspaceError) throw error;
		throw new GitWorkspaceError(
			'GIT_WORKSPACE_LOCKFILE_MISSING',
			'This repository has no pnpm-lock.yaml. Commit its lockfile before connecting it.',
		);
	}
	await runOrFail(
		run,
		'pnpm',
		['install', '--frozen-lockfile'],
		root,
		'GIT_WORKSPACE_INSTALL_FAILED',
		'Dependency installation failed. Check that pnpm is installed, then check the committed lockfile, package manager version, and package scripts in the cloned directory.',
		'GIT_WORKSPACE_INSTALL_TIMEOUT',
		'Dependency installation did not finish within 15 minutes. Check the package scripts and registry access, then try again.',
	);
	return {
		root,
		steps: [
			'cloned the connected Git repository',
			'verified flowdular.json',
			'installed dependencies with the committed lockfile',
		],
	};
}
