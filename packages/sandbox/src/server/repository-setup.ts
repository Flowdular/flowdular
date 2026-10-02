import { createHash, randomUUID } from 'node:crypto';
import {
	link,
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertGitHubRepository, sandboxDirectory } from './config.ts';
import {
	spawnCommand,
	type CommandResult,
	type CommandRunner,
} from './delivery/steps.ts';
import { SandboxSetupError } from './workspace-root.ts';

export type RepositorySetupMode = 'connect' | 'create';

export interface RepositorySetupInput {
	readonly mode: RepositorySetupMode;
	readonly repository: string;
}

export interface RepositorySetupPlan {
	readonly mode: RepositorySetupMode;
	readonly repository: string;
	readonly remote: 'app';
	readonly branch: 'main';
	readonly head: string;
	readonly visibility: 'private' | 'existing';
	readonly remoteAlreadyConfigured: boolean;
	/* True when this exact approved plan is being recovered from the journal. */
	readonly resuming: boolean;
	readonly fingerprint: string;
}

export interface RepositorySetupOutcome {
	readonly repository: string;
	readonly url: string;
	readonly remote: 'app';
	readonly branch: 'main';
	readonly head: string;
	readonly created: boolean;
}

export interface RepositorySetupDependencies {
	readonly commands?: CommandRunner;
	readonly providerToken?: string | null;
	/* Recheck the acting operator's live grant at each external write. */
	readonly assertCanPublish?: () => Promise<void>;
	/* Persist local delivery settings and clear the journal before releasing
	   the workspace lock. A retry invokes this again without a second push. */
	readonly finalize?: (outcome: RepositorySetupOutcome) => Promise<void>;
}

export class RepositorySetupError extends SandboxSetupError {
	constructor(code: string, message: string) {
		super(code, message);
		this.name = 'RepositorySetupError';
	}
}

const REMOTE = 'app' as const;
const BRANCH = 'main' as const;
const JOURNAL_NAME = 'repository-setup-pending.json';
const OPERATION_LOCK_NAME = 'repository-setup-operation.lock';
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
	return {
		...env,
		FORCE_COLOR: '0',
		NO_COLOR: '1',
		GIT_TERMINAL_PROMPT: '0',
		GH_PROMPT_DISABLED: '1',
		GH_NO_UPDATE_NOTIFIER: '1',
	};
}

type Run = (
	command: 'git' | 'gh',
	args: readonly string[],
) => Promise<CommandResult>;

async function commandRunner(
	root: string,
	dependencies: RepositorySetupDependencies,
): Promise<Run> {
	const commands = dependencies.commands ?? spawnCommand;
	const base = commandEnvironment();
	let token =
		dependencies.providerToken ??
		process.env.GH_TOKEN ??
		process.env.GITHUB_TOKEN ??
		null;
	if (!token) {
		try {
			const supplied = await commands('gh', ['auth', 'token'], root, {
				env: base,
			});
			if (
				supplied.code === 0 &&
				/^[A-Za-z0-9_]{8,16384}$/.test(supplied.output.trim())
			)
				token = supplied.output.trim();
		} catch {
			/* Git's own credential helper can still connect an existing repo. */
		}
	}
	const ghEnv = token ? { ...base, GH_TOKEN: token } : base;
	const gitEnv = token
		? {
				...base,
				GIT_CONFIG_COUNT: '1',
				GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
				GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(
					`x-access-token:${token}`,
				).toString('base64')}`,
			}
		: base;
	return async (command, args) => {
		try {
			return await commands(command, args, root, {
				env: command === 'gh' ? ghEnv : gitEnv,
			});
		} catch {
			/* A subprocess error can include a credential in its message. */
			return { code: null, output: '' };
		}
	};
}

function normalizedInput(input: RepositorySetupInput): RepositorySetupInput {
	if (input.mode !== 'connect' && input.mode !== 'create') {
		throw new RepositorySetupError(
			'REPO_SETUP_INPUT_INVALID',
			'Choose Connect or Create for the application repository.',
		);
	}
	let repository: string | null;
	try {
		repository = assertGitHubRepository(input.repository.trim());
	} catch {
		repository = null;
	}
	if (!repository || repository.length > 160) {
		throw new RepositorySetupError(
			'REPO_SETUP_INPUT_INVALID',
			'Use a GitHub repository name in owner/name form, up to 160 characters.',
		);
	}
	return { mode: input.mode, repository };
}

function repositoryUrl(repository: string): string {
	return `https://github.com/${repository}.git`;
}

function fingerprint(
	plan: Pick<
		RepositorySetupPlan,
		| 'mode'
		| 'repository'
		| 'remote'
		| 'branch'
		| 'head'
		| 'visibility'
		| 'remoteAlreadyConfigured'
	>,
): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				plan.mode,
				plan.repository,
				plan.remote,
				plan.branch,
				plan.head,
				plan.visibility,
				plan.remoteAlreadyConfigured,
			]),
		)
		.digest('hex');
}

function journalPath(root: string): string {
	return join(sandboxDirectory(root), JOURNAL_NAME);
}

function operationBusy(): never {
	throw new RepositorySetupError(
		'REPO_SETUP_BUSY',
		'A repository setup is already running for this workspace. If its process has exited, retry; if the lock remains, inspect .flowdular/repository-setup-operation.lock.',
	);
}

function lockOwner(value: unknown): { pid: number; id: string } | null {
	if (!value || typeof value !== 'object') return null;
	const record = value as { pid?: unknown; id?: unknown };
	return Number.isSafeInteger(record.pid) &&
		(record.pid as number) > 0 &&
		typeof record.id === 'string' &&
		/^[0-9a-f-]{36}$/.test(record.id)
		? { pid: record.pid as number, id: record.id }
		: null;
}

async function readLockOwner(path: string): Promise<{
	pid: number;
	id: string;
} | null> {
	try {
		return lockOwner(
			JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')),
		);
	} catch {
		return null;
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

function occupiedLock(error: unknown): boolean {
	return ['EEXIST', 'ENOTEMPTY'].includes(
		(error as NodeJS.ErrnoException).code ?? '',
	);
}

/* Every lock, including a recovery claim, starts as a complete temporary
   directory and becomes visible through one atomic rename. If a reclaimer
   dies, its claim is another dead lock and can be recovered by the same rule. */
async function acquireDiskLock(path: string, depth = 0): Promise<string> {
	if (depth > 64) return operationBusy();
	const id = randomUUID();
	const temporary = `${path}.${id}.tmp`;
	await mkdir(temporary, { mode: 0o700 });
	try {
		await writeFile(
			join(temporary, 'owner.json'),
			JSON.stringify({ pid: process.pid, id }) + '\n',
			{ flag: 'wx', mode: 0o600 },
		);
		try {
			await rename(temporary, path);
		} catch (error) {
			if (!occupiedLock(error)) throw error;
			await recoverDeadLock(path, depth + 1);
			try {
				await rename(temporary, path);
			} catch (retryError) {
				if (occupiedLock(retryError)) return operationBusy();
				throw retryError;
			}
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
	return id;
}

async function releaseDiskLock(path: string, id: string): Promise<void> {
	const current = await readLockOwner(path);
	if (current?.id !== id) operationBusy();
	const retired = `${path}.${id}.retired`;
	await rename(path, retired);
	await rm(retired, { recursive: true, force: true });
}

async function recoverDeadLock(path: string, depth: number): Promise<void> {
	if (depth > 64) return operationBusy();
	const owner = await readLockOwner(path);
	if (!owner || processAlive(owner.pid)) return operationBusy();
	const claim = join(path, 'recovery');
	const claimId = await acquireDiskLock(claim, depth + 1);
	let retired: string | null = null;
	let moved = false;
	try {
		const current = await readLockOwner(path);
		if (!current || current.id !== owner.id || processAlive(current.pid))
			return operationBusy();
		retired = `${path}.${randomUUID()}.retired`;
		await rename(path, retired);
		moved = true;
	} finally {
		if (moved && retired) await rm(retired, { recursive: true, force: true });
		else await releaseDiskLock(claim, claimId);
	}
}

async function withOperationLock<T>(
	root: string,
	work: () => Promise<T>,
): Promise<T> {
	const directory = sandboxDirectory(root);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, OPERATION_LOCK_NAME);
	const id = await acquireDiskLock(path);
	try {
		return await work();
	} finally {
		await releaseDiskLock(path, id);
	}
}

function invalidJournal(): never {
	throw new RepositorySetupError(
		'REPO_SETUP_PENDING_INVALID',
		'The pending repository setup record is invalid. Inspect .flowdular/repository-setup-pending.json before starting another publication.',
	);
}

async function pendingPlan(root: string): Promise<RepositorySetupPlan | null> {
	const path = journalPath(root);
	let size: number;
	try {
		size = (await stat(path)).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		return invalidJournal();
	}
	if (size > 4_096) return invalidJournal();
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, 'utf8'));
	} catch {
		return invalidJournal();
	}
	if (!value || typeof value !== 'object') return invalidJournal();
	const record = value as { version?: unknown; plan?: unknown };
	if (record.version !== 1 || !record.plan || typeof record.plan !== 'object')
		return invalidJournal();
	const plan = record.plan as Partial<RepositorySetupPlan>;
	if (
		(plan.mode !== 'connect' && plan.mode !== 'create') ||
		typeof plan.repository !== 'string' ||
		plan.repository.length > 160 ||
		plan.remote !== REMOTE ||
		plan.branch !== BRANCH ||
		typeof plan.head !== 'string' ||
		!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(plan.head) ||
		plan.visibility !== (plan.mode === 'create' ? 'private' : 'existing') ||
		typeof plan.remoteAlreadyConfigured !== 'boolean' ||
		typeof plan.fingerprint !== 'string'
	)
		return invalidJournal();
	let repository: string | null;
	try {
		repository = assertGitHubRepository(plan.repository);
	} catch {
		return invalidJournal();
	}
	if (!repository || repository !== plan.repository) return invalidJournal();
	const valid = {
		mode: plan.mode,
		repository,
		remote: REMOTE,
		branch: BRANCH,
		head: plan.head,
		visibility: plan.visibility,
		remoteAlreadyConfigured: plan.remoteAlreadyConfigured,
	};
	if (fingerprint(valid) !== plan.fingerprint) return invalidJournal();
	return { ...valid, resuming: false, fingerprint: plan.fingerprint };
}

export async function readPendingRepositorySetup(
	workspaceRoot: string,
): Promise<RepositorySetupPlan | null> {
	const root = await realpath(resolve(workspaceRoot));
	return pendingPlan(root);
}

/* A complete local record exists before GitHub can be changed. Hard-linking a
   fully written temporary file makes the record exclusive across processes. */
async function keepPending(
	root: string,
	plan: RepositorySetupPlan,
): Promise<void> {
	const existing = await pendingPlan(root);
	if (existing) {
		if (existing.fingerprint === plan.fingerprint) return;
		throw new RepositorySetupError(
			'REPO_SETUP_PENDING_OTHER',
			'Finish the pending repository setup before publishing to another destination.',
		);
	}
	const directory = sandboxDirectory(root);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `${JOURNAL_NAME}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, JSON.stringify({ version: 1, plan }) + '\n', {
			flag: 'wx',
			mode: 0o600,
		});
		try {
			await link(temporary, journalPath(root));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			const concurrent = await pendingPlan(root);
			if (concurrent?.fingerprint !== plan.fingerprint)
				throw new RepositorySetupError(
					'REPO_SETUP_PENDING_OTHER',
					'Finish the pending repository setup before publishing to another destination.',
				);
		}
	} finally {
		await rm(temporary, { force: true });
	}
}

export async function finishRepositorySetup(
	workspaceRoot: string,
	plan: RepositorySetupPlan,
): Promise<void> {
	const root = await realpath(resolve(workspaceRoot));
	const pending = await pendingPlan(root);
	if (!pending || pending.fingerprint !== plan.fingerprint) {
		throw new RepositorySetupError(
			'REPO_SETUP_PENDING_CHANGED',
			'The pending repository setup record changed. Inspect it before clearing the publication state.',
		);
	}
	await rm(journalPath(root));
}

/* A failed create may have left a journal even when GitHub created nothing.
   The operator can explicitly discard it after an authenticated 404 for that
   repository. A private repository hidden from this identity can also return
   404, so the UI asks the operator to check GitHub. Ambiguous replies keep the
   journal, and a pending push to a visible repository cannot be cancelled. */
export async function cancelPendingRepositorySetup(
	workspaceRoot: string,
	repository: string,
	dependencies: RepositorySetupDependencies = {},
): Promise<void> {
	const root = await realpath(resolve(workspaceRoot));
	return withOperationLock(root, async () => {
		const pending = await pendingPlan(root);
		if (!pending) {
			throw new RepositorySetupError(
				'REPO_SETUP_PLAN_MISSING',
				'There is no pending repository setup to discard.',
			);
		}
		const requested = normalizedInput({ mode: 'create', repository });
		if (
			pending.mode !== 'create' ||
			pending.repository !== requested.repository
		) {
			throw new RepositorySetupError(
				'REPO_SETUP_CANCEL_UNSAFE',
				'Only the exact pending private-repository creation can be discarded.',
			);
		}
		const run = await commandRunner(root, dependencies);
		const auth = await run('gh', ['api', 'user', '--jq', '.login']);
		if (auth.code !== 0 || !auth.output.trim()) {
			throw new RepositorySetupError(
				'REPO_SETUP_GITHUB_AUTH_REQUIRED',
				'Sign in to GitHub before discarding the pending repository setup.',
			);
		}
		const lookup = await run('gh', [
			'api',
			`repos/${pending.repository}`,
			'--jq',
			'.id',
		]);
		if (lookup.code === 0) {
			throw new RepositorySetupError(
				'REPO_SETUP_CANCEL_UNSAFE',
				'The repository exists on GitHub. Resume the pending setup instead of discarding it.',
			);
		}
		if (!/\bHTTP\s+404\b/i.test(lookup.output)) {
			throw new RepositorySetupError(
				'REPO_SETUP_CREATE_UNVERIFIED',
				'GitHub could not confirm that the repository is absent. The pending setup was kept.',
			);
		}
		await dependencies.assertCanPublish?.();
		const remote = await run('git', ['remote', 'get-url', REMOTE]);
		if (remote.code === 0) {
			if (remote.output.trim() !== repositoryUrl(pending.repository)) {
				throw new RepositorySetupError(
					'REPO_SETUP_REMOTE_OCCUPIED',
					'The app remote now points elsewhere. Inspect it before discarding this setup.',
				);
			}
			const removed = await run('git', ['remote', 'remove', REMOTE]);
			if (removed.code !== 0) {
				throw new RepositorySetupError(
					'REPO_SETUP_CANCEL_FAILED',
					'The local app remote could not be cleared. The pending setup was kept.',
				);
			}
		}
		await finishRepositorySetup(root, pending);
	});
}

async function checkedHead(root: string, run: Run): Promise<string> {
	const top = await run('git', ['rev-parse', '--show-toplevel']);
	if (top.code !== 0) {
		throw new RepositorySetupError(
			'REPO_SETUP_GIT_REQUIRED',
			'This Flowdular workspace needs a Git checkout. Install Git or connect a Git repository first.',
		);
	}
	const [actualRoot, reportedRoot] = await Promise.all([
		realpath(root),
		realpath(top.output.trim()).catch(() => ''),
	]);
	if (actualRoot !== reportedRoot) {
		throw new RepositorySetupError(
			'REPO_SETUP_WRONG_CHECKOUT',
			'The Flowdular workspace must be the root of its Git checkout before publishing it.',
		);
	}
	const head = await run('git', ['rev-parse', '--verify', 'HEAD']);
	const sha = head.output.trim();
	if (head.code !== 0 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) {
		throw new RepositorySetupError(
			'REPO_SETUP_COMMIT_REQUIRED',
			'Create a local Git commit before connecting the application repository.',
		);
	}
	const status = await run('git', [
		'status',
		'--porcelain',
		'--untracked-files=normal',
	]);
	if (status.code !== 0) {
		throw new RepositorySetupError(
			'REPO_SETUP_GIT_FAILED',
			'Git could not inspect this checkout. Check its permissions and try again.',
		);
	}
	if (status.output.trim()) {
		throw new RepositorySetupError(
			'REPO_SETUP_CHECKOUT_DIRTY',
			'Commit or stash local changes before the initial push, so the repository receives exactly the checkout shown in the plan.',
		);
	}
	return sha;
}

async function configuredRemote(run: Run, url: string): Promise<boolean> {
	const remote = await run('git', ['remote', 'get-url', REMOTE]);
	if (remote.code !== 0) return false;
	if (remote.output.trim() !== url) {
		throw new RepositorySetupError(
			'REPO_SETUP_REMOTE_OCCUPIED',
			'This checkout already has an app remote for another repository. Choose a fresh checkout or change that remote deliberately.',
		);
	}
	return true;
}

async function remoteState(
	run: Run,
	url: string,
	expectedHead?: string,
): Promise<'empty' | 'matching-head'> {
	const refs = await run('git', ['ls-remote', '--refs', url]);
	if (refs.code !== 0) {
		throw new RepositorySetupError(
			'REPO_SETUP_REMOTE_UNAVAILABLE',
			'The GitHub repository could not be read. Check that it exists and your Git credentials can access it.',
		);
	}
	const lines = refs.output.trim().split('\n').filter(Boolean);
	if (lines.length === 0) return 'empty';
	if (
		expectedHead &&
		lines.length === 1 &&
		lines[0] === `${expectedHead}\trefs/heads/${BRANCH}`
	)
		return 'matching-head';
	throw new RepositorySetupError(
		'REPO_SETUP_REMOTE_NOT_EMPTY',
		'The GitHub repository has another commit, branch, or tag. Repository setup will not replace its history.',
	);
}

async function assertRemoteEmpty(run: Run, url: string): Promise<void> {
	if ((await remoteState(run, url)) !== 'empty') {
		throw new RepositorySetupError(
			'REPO_SETUP_REMOTE_NOT_EMPTY',
			'The GitHub repository already has commits or tags. Connect only an empty repository; this action never replaces its history.',
		);
	}
}

/* Planning has no write side effect. The returned head and fingerprint are
   rechecked immediately before apply, along with the destination's emptiness. */
export async function planRepositorySetup(
	workspaceRoot: string,
	input: RepositorySetupInput,
	dependencies: RepositorySetupDependencies = {},
): Promise<RepositorySetupPlan> {
	const root = resolve(workspaceRoot);
	const normalized = normalizedInput(input);
	const run = await commandRunner(root, dependencies);
	const head = await checkedHead(root, run);
	const url = repositoryUrl(normalized.repository);
	const remoteAlreadyConfigured = await configuredRemote(run, url);
	const pending = await pendingPlan(root);
	if (pending) {
		if (
			pending.mode !== normalized.mode ||
			pending.repository !== normalized.repository
		) {
			throw new RepositorySetupError(
				'REPO_SETUP_PENDING_OTHER',
				'Finish the pending repository setup before publishing to another destination.',
			);
		}
		if (pending.head !== head) {
			throw new RepositorySetupError(
				'REPO_SETUP_PLAN_STALE',
				'The checkout changed during repository setup. Restore the planned commit before retrying.',
			);
		}
		if (normalized.mode === 'create') {
			const existing = await run('gh', [
				'repo',
				'view',
				normalized.repository,
				'--json',
				'nameWithOwner',
			]);
			if (existing.code !== 0)
				throw new RepositorySetupError(
					'REPO_SETUP_CREATE_UNVERIFIED',
					'The pending repository creation cannot be verified on GitHub. Retry when GitHub is reachable; no second create will be attempted.',
				);
			await assertPrivate(run, normalized.repository);
			await remoteState(run, url, pending.head);
		} else {
			await remoteState(run, url, pending.head);
		}
		return { ...pending, resuming: true };
	}
	if (normalized.mode === 'create') {
		if (remoteAlreadyConfigured) {
			throw new RepositorySetupError(
				'REPO_SETUP_ALREADY_CONNECTED',
				'The app remote is already configured. Use Connect to finish publishing this repository.',
			);
		}
		const auth = await run('gh', ['api', 'user', '--jq', '.login']);
		if (auth.code !== 0) {
			throw new RepositorySetupError(
				'REPO_SETUP_GITHUB_AUTH_REQUIRED',
				'Creating a private repository needs the GitHub CLI and an authenticated GitHub account or token.',
			);
		}
		const existing = await run('gh', [
			'repo',
			'view',
			normalized.repository,
			'--json',
			'nameWithOwner',
		]);
		if (existing.code === 0) {
			throw new RepositorySetupError(
				'REPO_SETUP_ALREADY_EXISTS',
				'That GitHub repository already exists. Use Connect if it is empty, or choose a new name.',
			);
		}
	} else {
		await assertRemoteEmpty(run, url);
	}
	const visible = {
		mode: normalized.mode,
		repository: normalized.repository,
		remote: REMOTE,
		branch: BRANCH,
		head,
		visibility: normalized.mode === 'create' ? 'private' : 'existing',
		remoteAlreadyConfigured,
		resuming: false,
	} as const;
	return { ...visible, fingerprint: fingerprint(visible) };
}

async function assertPrivate(run: Run, repository: string): Promise<void> {
	const privacy = await run('gh', [
		'api',
		`repos/${repository}`,
		'--jq',
		'.private',
	]);
	if (privacy.code !== 0 || privacy.output.trim() !== 'true') {
		throw new RepositorySetupError(
			'REPO_SETUP_PRIVACY_UNVERIFIED',
			"The repository's private visibility could not be verified. Check it on GitHub before continuing setup.",
		);
	}
}

/* gh can return a nonzero status even after GitHub created the repository.
   Only an error attributed to the createRepository mutation, followed by an
   authenticated 404, proves that this attempt did not create it. */
async function rejectedBeforeCreate(
	run: Run,
	repository: string,
	result: CommandResult,
): Promise<boolean> {
	if (
		result.code === null ||
		result.code === 0 ||
		!/(?:^|\n)GraphQL:[^\n]*\(createRepository\)(?:\s|$)/i.test(result.output)
	)
		return false;
	const auth = await run('gh', ['api', 'user', '--jq', '.login']);
	if (auth.code !== 0 || !auth.output.trim()) return false;
	const lookup = await run('gh', ['api', `repos/${repository}`, '--jq', '.id']);
	return lookup.code !== 0 && /\bHTTP\s+404\b/i.test(lookup.output);
}

/* The only external write in this flow. It never force pushes, changes the
   current branch, rewrites origin, or commits unreviewed working-tree files. */
export async function applyRepositorySetup(
	workspaceRoot: string,
	plan: RepositorySetupPlan,
	dependencies: RepositorySetupDependencies = {},
): Promise<RepositorySetupOutcome> {
	const root = await realpath(resolve(workspaceRoot)).catch(() => {
		throw new RepositorySetupError(
			'REPO_SETUP_GIT_REQUIRED',
			'This Flowdular workspace needs an accessible Git checkout before publishing it.',
		);
	});
	return withOperationLock(root, async () => {
		const current = await planRepositorySetup(root, plan, dependencies);
		if (current.fingerprint !== plan.fingerprint) {
			throw new RepositorySetupError(
				'REPO_SETUP_PLAN_STALE',
				'The checkout or destination changed after the plan was shown. Review a fresh plan before publishing.',
			);
		}
		const run = await commandRunner(root, dependencies);
		const url = repositoryUrl(plan.repository);
		const wasPending = (await pendingPlan(root)) !== null;
		if (plan.mode === 'create') {
			const existing = wasPending
				? await run('gh', [
						'repo',
						'view',
						plan.repository,
						'--json',
						'nameWithOwner',
					])
				: { code: 1, output: '' };
			if (wasPending && existing.code !== 0) {
				throw new RepositorySetupError(
					'REPO_SETUP_CREATE_UNVERIFIED',
					'The pending repository creation cannot be verified on GitHub. Retry when GitHub is reachable; no second create will be attempted.',
				);
			}
			if (!wasPending) {
				await keepPending(root, plan);
				await dependencies.assertCanPublish?.();
				const created = await run('gh', [
					'repo',
					'create',
					plan.repository,
					'--private',
				]);
				if (created.code !== 0) {
					if (await rejectedBeforeCreate(run, plan.repository, created)) {
						await finishRepositorySetup(root, plan);
						throw new RepositorySetupError(
							'REPO_SETUP_CREATE_FAILED',
							'GitHub rejected repository creation. Check your access or choose another name, then review a new plan.',
						);
					}
					throw new RepositorySetupError(
						'REPO_SETUP_CREATE_FAILED',
						'GitHub did not confirm repository creation. Check the repository on GitHub, then retry this plan.',
					);
				}
			}
			await assertPrivate(run, plan.repository);
			if (!(await configuredRemote(run, url))) {
				const added = await run('git', ['remote', 'add', REMOTE, url]);
				if (added.code !== 0) {
					throw new RepositorySetupError(
						'REPO_SETUP_REMOTE_ADD_FAILED',
						'Git could not add the local app remote. Fix the checkout, then retry this plan.',
					);
				}
			}
		} else if (!(await configuredRemote(run, url))) {
			const added = await run('git', ['remote', 'add', REMOTE, url]);
			if (added.code !== 0) {
				throw new RepositorySetupError(
					'REPO_SETUP_REMOTE_ADD_FAILED',
					'Git could not add the local app remote. Check this checkout and try again.',
				);
			}
		}
		const state = await remoteState(
			run,
			url,
			wasPending ? plan.head : undefined,
		);
		if (state === 'empty') {
			await keepPending(root, plan);
			/* A revoked grant may have stopped a just-created repository before
			   its push. Recheck the destination after that network round trip. */
			await assertRemoteEmpty(run, url);
			await dependencies.assertCanPublish?.();
			const pushed = await run('git', [
				'push',
				url,
				`HEAD:refs/heads/${BRANCH}`,
			]);
			if (pushed.code !== 0) {
				throw new RepositorySetupError(
					'REPO_SETUP_PUSH_FAILED',
					'The initial push could not be confirmed. Retry this plan; the remote will be checked before any further push.',
				);
			}
			try {
				if ((await remoteState(run, url, plan.head)) !== 'matching-head')
					throw new Error('The remote branch did not appear.');
			} catch {
				throw new RepositorySetupError(
					'REPO_SETUP_PUSH_UNVERIFIED',
					'Git reported a push, but the remote branch could not be verified. Retry this plan after GitHub is reachable.',
				);
			}
		}
		const outcome = {
			repository: plan.repository,
			url: `https://github.com/${plan.repository}`,
			remote: REMOTE,
			branch: BRANCH,
			head: plan.head,
			created: plan.mode === 'create',
		};
		await dependencies.finalize?.(outcome);
		return outcome;
	});
}
