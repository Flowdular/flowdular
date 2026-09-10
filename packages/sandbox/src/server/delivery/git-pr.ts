import { sandboxDirectory } from '../config.ts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { redactSecrets } from '@flowdular/ai-provider';
import type { GateResult } from '../gates.ts';
import {
	basePathOf,
	findSessionModule,
	modulePathOf,
	readChat,
	sessionPaths,
	type SandboxSession,
} from '../sessions.ts';
import { readModuleSpecReview, type ModuleSpecReview } from '../spec.ts';
import { SandboxSetupError } from '../workspace-root.ts';
import {
	DEFAULT_DELIVERY_CONFIGURATION,
	type DeliveryConfiguration,
} from './configuration.ts';
import {
	GATES,
	assertEjectCapability,
	countChangedFiles,
	planSessionModules,
} from './plan.ts';
import {
	loadPathOwnership,
	loadTaskBudgets,
	matchesPath,
	ownerOf,
	type PathOwnership,
	type TaskBudgets,
} from './policies.ts';
import {
	createStepRecorder,
	enableModule,
	exists,
	installWorktree,
	runDeliveryGates,
	stageModules,
	step,
	verifyPlatform,
	type CommandResult,
	type StepRecorder,
	type StepResult,
} from './steps.ts';
import type {
	DeliveryAvailability,
	DeliveryBudget,
	DeliveryContext,
	DeliveryGuardrails,
	DeliveryModulePlan,
	DeliveryProvider,
	DeliveryTarget,
	GitDeliveryMode,
	GitDeliveryPlan,
} from './types.ts';

function worktreesDirectory(root: string): string {
	return relative(root, join(sandboxDirectory(root), 'worktrees'));
}
/* Written by module enable and pnpm install; they travel in the module's
   commit (.ai/blueprints/new-module/allowed-paths.yaml, cliOwned). */
const COMPOSITION_PATHS = [
	'flowdular.json',
	'platform/package.json',
	'platform/src/generated/**',
] as const;
const LOCKFILE_PATH = 'pnpm-lock.yaml';
const FALLBACK_BUDGET: DeliveryBudget = {
	maxChangedFiles: 18,
	maxNewDependencies: 0,
};
const NO_COMMITS =
	'the repository has no commits yet; make the first commit before delivering as a pull request';
const OFFENDING_LIMIT = 20;
const GITHUB_REMOTE =
	/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

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

type Run = (
	command: string,
	args: readonly string[],
	cwd: string,
) => Promise<CommandResult>;

interface ChangeSet {
	readonly added: readonly string[];
	readonly modified: readonly string[];
	readonly removed: readonly string[];
}

interface GitDestination {
	readonly repository: string | null;
	readonly mode: GitDeliveryMode;
	readonly pushTarget: string;
	readonly forkOwner: string | null;
	readonly forkRequired: boolean;
	readonly head: string;
	readonly compareUrl: string | null;
}

function sameStrings(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

/* Apply never trusts an earlier preview blindly. In particular, a spec can be
   edited after the operator opens the plan, which invalidates its approved
   hash. Rebuild the module plan at the last boundary before delivery and fail
   rather than commit a different set of files from the one reviewed. */
function assertPlanStillCurrent(
	planned: readonly DeliveryModulePlan[],
	current: readonly DeliveryModulePlan[],
): void {
	const same =
		planned.length === current.length &&
		planned.every((module, index) => {
			const refreshed = current[index];
			return (
				refreshed !== undefined &&
				module.id === refreshed.id &&
				module.directory === refreshed.directory &&
				module.kind === refreshed.kind &&
				module.targetPath === refreshed.targetPath &&
				sameStrings(module.files, refreshed.files) &&
				sameStrings(module.additions, refreshed.additions) &&
				sameStrings(module.overwrites, refreshed.overwrites) &&
				sameStrings(module.removes, refreshed.removes) &&
				sameStrings(module.newPackages, refreshed.newPackages) &&
				module.enable === refreshed.enable
			);
		});
	if (!same) {
		throw new SandboxSetupError(
			'EJECT_PLAN_STALE',
			'The session changed after this delivery was reviewed. Open a new delivery plan and approve the current specification before trying again.',
		);
	}
}

/* One delivery per session at a time: two would fight over the same worktree
   path and branch. */
const inFlight = new Set<string>();

/* Delivery commands need only the operator's executable path, local Git
   identity, SSH agent, locale, temporary directory, and certificate paths.
   An allowlist prevents unrelated database URLs and cloud credentials from
   reaching a package script or an external provider command. */
function commandEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || !COMMAND_ENVIRONMENT_KEYS.has(key)) continue;
		env[key] = value;
	}
	Object.assign(env, {
		FORCE_COLOR: '0',
		NO_COLOR: '1',
		GIT_TERMINAL_PROMPT: '0',
		GH_PROMPT_DISABLED: '1',
		GH_NO_UPDATE_NOTIFIER: '1',
	});
	return env;
}

function githubEnvironment(providerToken: string | null): NodeJS.ProcessEnv {
	const env = commandEnvironment();
	if (providerToken) env.GH_TOKEN = providerToken;
	return env;
}

function gitEnvironment(providerToken: string | null): NodeJS.ProcessEnv {
	const env = commandEnvironment();
	if (!providerToken) return env;
	/* Keep the credential out of command arguments and remote URLs. Git reads
	   this process-local config only for the delivery child process. */
	env.GIT_CONFIG_COUNT = '1';
	env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
	env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(
		`x-access-token:${providerToken}`,
	).toString('base64')}`;
	return env;
}

function safeExternalText(value: string, providerToken: string | null): string {
	let safe = redactSecrets(value)
		.replace(/\bgithub_pat_[A-Za-z0-9_]{8,}/gi, '[redacted]')
		.replace(/\bgh[pousr]_[A-Za-z0-9_]{8,}/gi, '[redacted]')
		.replace(/https:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[redacted]@');
	if (providerToken) {
		safe = safe.split(providerToken).join('[redacted]');
		const header = Buffer.from(`x-access-token:${providerToken}`).toString(
			'base64',
		);
		safe = safe.split(header).join('[redacted]');
	}
	return safe;
}

export async function gitDeliveryRunner(
	context: DeliveryContext,
): Promise<Run> {
	const token = context.gitProviderToken
		? await context.gitProviderToken()
		: null;
	const normalEnv = commandEnvironment();
	const ghEnv = githubEnvironment(token);
	const gitEnv = gitEnvironment(token);
	return async (command, args, cwd) => {
		const result = await context.commands(command, args, cwd, {
			env: command === 'git' ? gitEnv : command === 'gh' ? ghEnv : normalEnv,
		});
		return { ...result, output: safeExternalText(result.output, token) };
	};
}

function unavailable(reason: string): DeliveryAvailability {
	return { available: false, reason };
}

function branchNameFor(
	config: DeliveryConfiguration,
	session: SandboxSession,
): string {
	return `${config.git.branchPrefix}/${session.moduleSuffix}-${session.id.slice(0, 8)}`;
}

function budgetFor(
	config: DeliveryConfiguration,
	budgets: TaskBudgets,
	kind: string,
): DeliveryBudget {
	const override = budgets.overrides[kind] ?? {};
	return {
		maxChangedFiles:
			config.maxChangedFiles ??
			override.maxChangedFiles ??
			budgets.defaults.maxChangedFiles ??
			FALLBACK_BUDGET.maxChangedFiles,
		maxNewDependencies:
			override.maxNewDependencies ??
			budgets.defaults.maxNewDependencies ??
			FALLBACK_BUDGET.maxNewDependencies,
	};
}

function ownersOf(
	ownership: PathOwnership,
	paths: readonly string[],
): readonly string[] {
	const owners = new Set<string>();
	for (const path of paths) {
		const owner = ownerOf(path, ownership);
		if (owner) owners.add(owner);
	}
	return [...owners].sort();
}

function listSome(items: readonly string[]): string {
	const shown = items.slice(0, OFFENDING_LIMIT).join(', ');
	return items.length > OFFENDING_LIMIT
		? `${shown} and ${items.length - OFFENDING_LIMIT} more`
		: shown;
}

function evaluateGuardrails(input: {
	readonly offending: readonly string[];
	readonly changedFiles: number;
	readonly newDependencies: readonly string[];
	readonly budget: DeliveryBudget;
}): DeliveryGuardrails {
	const reasons: string[] = [];
	if (input.offending.length > 0) {
		reasons.push(
			`${input.offending.length} changed file(s) lie outside the allowed paths: ${listSome(input.offending)}.`,
		);
	}
	if (input.changedFiles > input.budget.maxChangedFiles) {
		reasons.push(
			`${input.changedFiles} changed files exceed the budget of ${input.budget.maxChangedFiles} (sandbox.delivery.maxChangedFiles in flowdular.json, else .ai/policies/task-budgets.yaml).`,
		);
	}
	if (input.newDependencies.length > input.budget.maxNewDependencies) {
		reasons.push(
			`${input.newDependencies.length} new package(s) (${listSome(input.newDependencies)}) exceed the budget of ${input.budget.maxNewDependencies} from .ai/policies/task-budgets.yaml.`,
		);
	}
	return { ok: reasons.length === 0, reasons };
}

function githubRepository(remoteUrl: string): string | null {
	const match = GITHUB_REMOTE.exec(remoteUrl.trim());
	return match ? `${match[1]}/${match[2]}` : null;
}

function compareUrlFor(
	repository: string,
	baseBranch: string,
	head: string,
): string {
	return `https://github.com/${repository}/compare/${baseBranch}...${head}?expand=1`;
}

function githubRepositoryName(repository: string): string {
	return repository.slice(repository.indexOf('/') + 1);
}

function githubPushUrl(owner: string, repository: string): string {
	return `https://github.com/${owner}/${githubRepositoryName(repository)}.git`;
}

async function outputValue(
	run: Run,
	command: string,
	args: readonly string[],
	cwd: string,
): Promise<string | null> {
	const result = await run(command, args, cwd);
	return result.code === 0 && result.output.trim() !== ''
		? result.output.trim()
		: null;
}

async function assertWorktreeDirectoryIgnored(
	run: Run,
	cwd: string,
): Promise<void> {
	const ignored = await run(
		'git',
		[
			'check-ignore',
			'--quiet',
			'--no-index',
			`${worktreesDirectory(cwd)}/.probe`,
		],
		cwd,
	);
	if (ignored.code !== 0) {
		throw new SandboxSetupError(
			'GIT_WORKTREE_DIRECTORY_NOT_IGNORED',
			`The ${worktreesDirectory(cwd)} directory is not ignored by Git. Add .flowdular/ to .gitignore before pull request delivery so the active checkout stays unchanged.`,
		);
	}
}

async function resolveDestination(
	run: Run,
	config: DeliveryConfiguration,
	cwd: string,
	remoteUrl: string,
	provider: DeliveryProvider,
	branch: string,
): Promise<GitDestination> {
	const detected = githubRepository(remoteUrl);
	const repository = config.git.repository ?? detected;
	if (
		config.git.repository !== null &&
		detected !== null &&
		config.git.repository.toLowerCase() !== detected.toLowerCase()
	) {
		throw new SandboxSetupError(
			'GITHUB_REPOSITORY_MISMATCH',
			`The ${config.git.remote} remote points to ${detected}, not the configured ${config.git.repository}. Choose the matching remote before delivering.`,
		);
	}
	let mode: GitDeliveryMode = 'direct';
	if (config.git.mode === 'fork') mode = 'fork';
	if (config.git.mode === 'auto' && repository && provider === 'github') {
		const permission = await outputValue(
			run,
			'gh',
			['api', `repos/${repository}`, '--jq', '.permissions.push // false'],
			cwd,
		);
		if (permission !== 'true') {
			throw new SandboxSetupError(
				'GITHUB_FORK_OPT_IN_REQUIRED',
				'GitHub did not confirm direct push access. Choose Use a fork to create or use a fork, or choose Direct to attempt the repository push explicitly.',
			);
		}
	}
	if (mode === 'fork') {
		if (provider !== 'github' || repository === null) {
			throw new SandboxSetupError(
				'GITHUB_FORK_UNAVAILABLE',
				'Fork delivery needs a GitHub repository and an authenticated GitHub integration.',
			);
		}
		const forkOwner =
			config.git.forkOwner ??
			(await outputValue(run, 'gh', ['api', 'user', '--jq', '.login'], cwd));
		if (!forkOwner) {
			throw new SandboxSetupError(
				'GITHUB_FORK_OWNER_MISSING',
				'GitHub did not return the account that should own the fork.',
			);
		}
		const forkRepository = `${forkOwner}/${githubRepositoryName(repository)}`;
		const existing = await run(
			'gh',
			[
				'repo',
				'view',
				forkRepository,
				'--json',
				'nameWithOwner,parent',
				'--jq',
				'[.nameWithOwner, (.parent.nameWithOwner // "")] | @tsv',
			],
			cwd,
		);
		if (existing.code === 0) {
			const [, parent = ''] = existing.output.trim().split('\t');
			if (parent.toLowerCase() !== repository.toLowerCase()) {
				throw new SandboxSetupError(
					'GITHUB_FORK_MISMATCH',
					`${forkRepository} exists but is not a fork of ${repository}. Choose another fork owner or use direct delivery.`,
				);
			}
		}
		const head = `${forkOwner}:${branch}`;
		return {
			repository,
			mode,
			pushTarget: githubPushUrl(forkOwner, repository),
			forkOwner,
			forkRequired: existing.code !== 0,
			head,
			compareUrl: compareUrlFor(repository, config.git.baseBranch, head),
		};
	}
	return {
		repository,
		mode,
		pushTarget: config.git.remote,
		forkOwner: null,
		forkRequired: false,
		head: branch,
		compareUrl: repository
			? compareUrlFor(repository, config.git.baseBranch, branch)
			: null,
	};
}

async function probeProvider(
	run: Run,
	config: DeliveryConfiguration,
	cwd: string,
): Promise<{ readonly kind: DeliveryProvider; readonly note: string }> {
	if (config.git.provider === 'none') {
		return {
			kind: 'none',
			note: 'Pull requests are turned off (sandbox.delivery.git.provider is none); the branch is pushed and the compare link shown.',
		};
	}
	const status = await run('gh', ['auth', 'status'], cwd);
	if (status.code === 0) return { kind: 'github', note: '' };
	return {
		kind: 'none',
		note:
			status.code === null
				? 'The gh command is not installed. The branch is pushed and a compare link is shown instead of opening a pull request.'
				: 'gh is not signed in. The branch is pushed and a compare link is shown instead of opening a pull request.',
	};
}

function porcelainPaths(output: string): readonly string[] {
	const paths: string[] = [];
	for (const line of output.split('\n')) {
		if (line.length < 4) continue;
		let path = line.slice(3);
		const renamed = path.indexOf(' -> ');
		if (renamed >= 0) path = path.slice(renamed + 4);
		if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
		paths.push(path);
	}
	return paths;
}

/* `modules/<dir>/**` becomes the directory pathspec git understands. */
function pathspecOf(pattern: string): string {
	return pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
}

async function stagedChanges(run: Run, worktree: string): Promise<ChangeSet> {
	const diff = await run(
		'git',
		['diff', '--cached', '--name-status', '--no-renames'],
		worktree,
	);
	const added: string[] = [];
	const modified: string[] = [];
	const removed: string[] = [];
	for (const line of diff.output.split('\n')) {
		const [status, path] = line.split('\t');
		if (!status || !path) continue;
		if (status.startsWith('A')) added.push(path);
		else if (status.startsWith('D')) removed.push(path);
		else modified.push(path);
	}
	return { added, modified, removed };
}

async function withTemporaryFile<T>(
	content: string,
	use: (path: string) => Promise<T>,
): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), 'flowdular-delivery-'));
	try {
		const path = join(directory, 'message.md');
		await writeFile(path, content, 'utf8');
		return await use(path);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function urlIn(output: string): string | null {
	const matches = output.match(/https?:\/\/\S+/g);
	return matches?.at(-1) ?? null;
}

/* "add a.core and update b.core", in the tense the caller needs. */
function describeChange(
	modules: readonly DeliveryModulePlan[],
	tense: 'add' | 'adds',
): string {
	const added = modules.filter((module) => module.kind === 'new');
	const updated = modules.filter((module) => module.kind === 'edit');
	const parts: string[] = [];
	if (added.length > 0) {
		parts.push(
			`${tense === 'adds' ? 'adds' : 'add'} ${added.map((module) => module.id).join(', ')}`,
		);
	}
	if (updated.length > 0) {
		parts.push(
			`${tense === 'adds' ? 'updates' : 'update'} ${updated.map((module) => module.id).join(', ')}`,
		);
	}
	return parts.join(' and ');
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function pullRequestTitle(modules: readonly DeliveryModulePlan[]): string {
	const complete = capitalize(describeChange(modules, 'add'));
	if (complete.length <= 70) return complete;
	const primary = modules[0]!.id;
	return modules.length === 1
		? `${primary}: sandbox delivery`.slice(0, 70)
		: `${primary}: update ${modules.length} modules`.slice(0, 70);
}

/* Plain sentences from free text: whitespace collapsed, dashes the repository
   rules forbid replaced, cut to a sentence count and a length. */
function sentences(text: string, count: number, limit: number): string {
	const clean = safeExternalText(text, null)
		.replace(
			/\b(token|password|secret|api[ _-]?key)\s*[:=]\s*[^\s,;]+/gi,
			'$1: [redacted]',
		)
		.replace(/\s+/g, ' ')
		.replace(/\s*\u2014\s*/g, ', ')
		.replace(/\u2013/g, '-')
		.trim();
	if (clean === '') return '';
	let picked = clean
		.split(/(?<=[.!?])\s+/)
		.slice(0, count)
		.join(' ');
	if (picked.length > limit)
		picked = `${picked.slice(0, limit - 1).trimEnd()}.`;
	return /[.!?]$/.test(picked) ? picked : `${picked}.`;
}

function gateSummary(gates: readonly GateResult[]): string {
	const modulesByGate = new Map<string, string[]>();
	for (const gate of gates) {
		const modules = modulesByGate.get(gate.id) ?? [];
		if (gate.module) modules.push(gate.module);
		modulesByGate.set(gate.id, modules);
	}
	return [...modulesByGate]
		.map(([id, modules]) =>
			modules.length > 0 ? `${id} (${modules.join(', ')})` : id,
		)
		.join(', ');
}

function commitMessage(
	session: SandboxSession,
	modules: readonly DeliveryModulePlan[],
	gates: readonly GateResult[],
): string {
	return `sandbox: ${describeChange(modules, 'add')}\n\nSession ${session.id}.\nGates passed: ${gateSummary(gates)}.\n`;
}

async function lastReviewHandoff(
	workspaceRoot: string,
	session: SandboxSession,
): Promise<string | null> {
	const entries = await readChat(workspaceRoot, session);
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const handoff = entries[index]!.handoff;
		if (handoff && (handoff.kind === 'review' || handoff.kind === 'approval')) {
			return handoff.reason;
		}
	}
	return null;
}

function pullRequestBody(input: {
	readonly session: SandboxSession;
	readonly modules: readonly DeliveryModulePlan[];
	readonly gates: readonly GateResult[];
	readonly changes: ChangeSet;
	readonly owners: readonly string[];
	readonly requireReviewer: boolean;
	readonly handoff: string | null;
	readonly specs: readonly ModuleSpecReview[];
}): string {
	const testGates = input.gates.filter((gate) => gate.id === 'tests');
	const summary = [
		`${capitalize(describeChange(input.modules, 'adds'))}.`,
		sentences(input.session.brief, 2, 400),
		input.handoff ? sentences(input.handoff, 1, 300) : '',
	]
		.filter((part) => part !== '')
		.join(' ');
	const lines = [
		summary,
		'',
		`Session ${input.session.id}.`,
		'',
		'## Specification',
		'',
		...input.specs.flatMap((spec) => {
			const before = spec.base?.specVersion ?? 'new';
			const after = spec.draft?.specVersion ?? 'unknown';
			const changes = spec.changes.slice(0, 20).map((change) => {
				const key = change.key ? ` ${change.key}` : '';
				return `- ${change.kind}: ${change.field}${key}`;
			});
			return [
				`### ${spec.moduleId}`,
				'',
				`Version: ${before} to ${after}. Status: ${spec.status ?? 'missing'}.`,
				...(changes.length > 0 ? changes : ['- No field-level spec diff.']),
				...(spec.changes.length > changes.length
					? [`- ${spec.changes.length - changes.length} more spec changes.`]
					: []),
				'',
			];
		}),
		'## Gates',
		'',
		'| Gate | Module | Result |',
		'| --- | --- | --- |',
		...input.gates.map(
			(gate) => `| ${gate.id} | ${gate.module ?? ''} | ${gate.status} |`,
		),
		'',
		`Verification: ${testGates.length} module test gate(s) passed. The platform typecheck passed in the delivery worktree.`,
		'',
	];
	const groups: readonly [string, readonly string[]][] = [
		['Added', input.changes.added],
		['Modified', input.changes.modified],
		['Removed', input.changes.removed],
	];
	lines.push('## Files', '');
	for (const [label, files] of groups) {
		if (files.length === 0) continue;
		lines.push(`${label} (${files.length}):`);
		lines.push(...files.map((file) => `- ${file}`));
		lines.push('');
	}
	lines.push('## Risks', '');
	const migrations = [...input.changes.added, ...input.changes.modified].filter(
		(file) => /\/migrations\//.test(file),
	);
	const removals = input.changes.removed.length;
	const riskLines = [
		...(migrations.length > 0
			? [`- ${migrations.length} migration file(s) require deployment review.`]
			: []),
		...(removals > 0
			? [`- ${removals} file(s) are removed by this change.`]
			: []),
		...(input.requireReviewer && input.owners.length > 1
			? [`- Cross-owner review is required for ${input.owners.join(', ')}.`]
			: []),
	];
	lines.push(
		...(riskLines.length > 0
			? riskLines
			: [
					'- No elevated delivery risks were detected by the sandbox guardrails.',
				]),
		'',
	);
	for (const module of input.modules) {
		lines.push(
			`Post-merge: \`pnpm flowdular auth sync-scopes --module ${module.id} --apply\` against the deployment database.`,
		);
	}
	if (input.requireReviewer && input.owners.length > 1) {
		lines.push(
			'',
			`Cross-owner change (${input.owners.join(', ')}): .ai/policies/path-ownership.yaml asks for a reviewer from each owner.`,
		);
	}
	return `${lines.join('\n')}\n`;
}

async function specificationEvidence(
	workspaceRoot: string,
	session: SandboxSession,
): Promise<readonly ModuleSpecReview[]> {
	const paths = sessionPaths(workspaceRoot, session.id, session.moduleSuffix);
	return Promise.all(
		session.modules.map((entry) => {
			const module = findSessionModule(session, entry.directory);
			return readModuleSpecReview(
				module,
				modulePathOf(paths, module.directory),
				basePathOf(paths, module.directory),
			);
		}),
	);
}

async function removeWorktree(
	run: Run,
	root: string,
	worktree: string,
): Promise<StepResult> {
	const removed = await run(
		'git',
		['worktree', 'remove', '--force', worktree],
		root,
	);
	await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
	await run('git', ['worktree', 'prune'], root);
	const gone = !(await exists(worktree));
	return {
		ok: gone,
		output: gone
			? ''
			: `The worktree at ${worktree} is still there: ${removed.output}`,
	};
}

function pushDestination(git: GitDeliveryPlan): string {
	if (git.deliveryMode === 'fork') {
		return githubPushUrl(git.forkOwner!, git.repository!);
	}
	return git.remote;
}

async function remoteBranchOwner(
	run: Run,
	cwd: string,
	destination: string,
	branch: string,
): Promise<{
	readonly exists: boolean;
	readonly message: string;
	readonly commit: string | null;
}> {
	const listed = await run(
		'git',
		['ls-remote', '--heads', destination, `refs/heads/${branch}`],
		cwd,
	);
	if (listed.code !== 0) {
		throw new SandboxSetupError(
			'GIT_REMOTE_UNREACHABLE',
			`The push repository could not be checked before delivery. ${listed.output.trim()}`.trim(),
		);
	}
	const commit = listed.output.trim().split(/\s+/)[0];
	if (!commit) return { exists: false, message: '', commit: null };
	const fetched = await run(
		'git',
		['fetch', '--quiet', destination, branch],
		cwd,
	);
	if (fetched.code !== 0) {
		throw new SandboxSetupError(
			'GIT_BRANCH_CHECK_FAILED',
			`The existing ${branch} branch could not be inspected.`,
		);
	}
	const message = await outputValue(
		run,
		'git',
		['show', '-s', '--format=%B', 'FETCH_HEAD'],
		cwd,
	);
	return { exists: true, message: message ?? '', commit };
}

function assertSessionBranch(
	branch: string,
	message: string,
	sessionId: string,
): void {
	if (message.includes(`Session ${sessionId}.`)) return;
	throw new SandboxSetupError(
		'GIT_BRANCH_CONFLICT',
		`The ${branch} branch already exists but was not created for this sandbox session. Choose another branch prefix or remove the conflicting branch yourself.`,
	);
}

async function openPullRequest(
	run: Run,
	worktree: string,
	git: GitDeliveryPlan,
	repository: string | null,
	title: string,
	body: string,
	recorder: StepRecorder,
): Promise<string | null> {
	const repositoryArgs = repository ? ['--repo', repository] : [];
	const existing = await run(
		'gh',
		[
			'pr',
			'list',
			...repositoryArgs,
			'--head',
			git.branch,
			'--state',
			'open',
			'--limit',
			'1',
			'--json',
			'url,headRepositoryOwner',
			'--jq',
			git.deliveryMode === 'fork'
				? `.[] | select(.headRepositoryOwner.login == ${JSON.stringify(git.forkOwner)}) | .url`
				: '.[0].url',
		],
		worktree,
	);
	const existingUrl = existing.code === 0 ? urlIn(existing.output) : null;
	if (existingUrl) {
		recorder.record('pr', {
			ok: true,
			output: `A pull request for ${git.branch} is already open; the push updated it.`,
			detail: existingUrl,
		});
		return existingUrl;
	}
	const created = await withTemporaryFile(body, (file) =>
		run(
			'gh',
			[
				'pr',
				'create',
				...repositoryArgs,
				'--base',
				git.baseBranch,
				'--head',
				git.head,
				'--title',
				title,
				'--body-file',
				file,
				...(git.reviewers.length > 0
					? ['--reviewer', git.reviewers.join(',')]
					: []),
			],
			worktree,
		),
	);
	const url = created.code === 0 ? urlIn(created.output) : null;
	recorder.record('pr', {
		ok: url !== null,
		output: created.output,
		detail: url ?? '',
	});
	return url;
}

/* The change lands as a commit on a session branch, built in a separate
   worktree so the operator's working tree and index are never touched, and
   is pushed with a pull request when a provider is usable. */
export function createGitPullRequestDeliveryTarget(): DeliveryTarget {
	return {
		id: 'git-pr',

		available: async (context) => {
			const config = context.delivery ?? DEFAULT_DELIVERY_CONFIGURATION;
			const root = context.workspaceRoot;
			const run = await gitDeliveryRunner(context);
			const head = await run(
				'git',
				['rev-parse', '--verify', '--quiet', 'HEAD'],
				root,
			);
			if (head.code === null) {
				return unavailable('git is not installed or not on PATH.');
			}
			if (head.code !== 0) {
				const inside = await run(
					'git',
					['rev-parse', '--is-inside-work-tree'],
					root,
				);
				return unavailable(
					inside.output.trim() === 'true'
						? NO_COMMITS
						: 'this workspace is not inside a git work tree.',
				);
			}
			try {
				await assertWorktreeDirectoryIgnored(run, root);
			} catch (error) {
				return unavailable(
					error instanceof Error
						? error.message
						: 'the delivery worktree directory is not ignored by Git.',
				);
			}
			const remote = await run(
				'git',
				['remote', 'get-url', config.git.remote],
				root,
			);
			if (remote.code !== 0) {
				return unavailable(
					`the ${config.git.remote} remote is not configured; add it with git remote add ${config.git.remote} <url>.`,
				);
			}
			const base = await run(
				'git',
				[
					'ls-remote',
					'--exit-code',
					'--heads',
					config.git.remote,
					`refs/heads/${config.git.baseBranch}`,
				],
				root,
			);
			if (base.code !== 0) {
				return unavailable(
					`the ${config.git.remote}/${config.git.baseBranch} base branch does not exist or cannot be read.`,
				);
			}
			const detectedRepository = githubRepository(remote.output.trim());
			if (
				config.git.repository !== null &&
				detectedRepository !== null &&
				config.git.repository.toLowerCase() !== detectedRepository.toLowerCase()
			) {
				return unavailable(
					`the ${config.git.remote} remote points to ${detectedRepository}, not ${config.git.repository}.`,
				);
			}
			const provider = await probeProvider(run, config, root);
			try {
				await resolveDestination(
					run,
					config,
					root,
					remote.output.trim(),
					provider.kind,
					branchNameFor(config, context.session),
				);
			} catch (error) {
				return unavailable(
					error instanceof Error
						? error.message
						: 'the configured Git destination is not usable.',
				);
			}
			return { available: true, reason: null };
		},

		plan: async (context) => {
			assertEjectCapability(context);
			const config = context.delivery ?? DEFAULT_DELIVERY_CONFIGURATION;
			const root = context.workspaceRoot;
			const modules = await planSessionModules(context);
			const primary = modules[0]!;
			const [ownership, budgets] = await Promise.all([
				loadPathOwnership(root),
				loadTaskBudgets(root),
			]);
			const budget = budgetFor(config, budgets, context.session.kind);
			const enable = modules.some((module) => module.enable);
			const newDependencies = [
				...new Set(modules.flatMap((module) => module.newPackages)),
			].sort();
			/* module enable writes the four composition files; install rewrites
			   the lockfile whenever a package is new to the workspace. */
			const compositionFiles = enable ? 5 : newDependencies.length > 0 ? 1 : 0;
			const changedFiles = countChangedFiles(modules) + compositionFiles;
			const owners = ownersOf(ownership, [
				...modules.map((module) => `modules/${module.directory}/module.json`),
				...(enable ? ['platform/package.json'] : []),
			]);
			const run = await gitDeliveryRunner(context);
			const remoteUrl = (
				await run('git', ['remote', 'get-url', config.git.remote], root)
			).output.trim();
			const branch = branchNameFor(config, context.session);
			const provider = await probeProvider(run, config, root);
			const destination = await resolveDestination(
				run,
				config,
				root,
				remoteUrl,
				provider.kind,
				branch,
			);
			return {
				target: 'git-pr',
				deliveredBy: 'git-pr',
				moduleId: primary.id,
				targetPath: primary.targetPath,
				files: primary.files,
				overwrites: primary.overwrites,
				removes: primary.removes,
				newPackages: primary.newPackages,
				enable: primary.enable,
				modules,
				changedFiles,
				gates: [...GATES],
				platformLocal: false,
				restartRequired: false,
				notes: [
					`Nothing in this workspace changes. The modules are committed on ${branch} from ${config.git.remote}/${config.git.baseBranch} and pushed. ${
						provider.kind === 'github'
							? 'A pull request is opened for review.'
							: provider.note
					}`,
				],
				git: {
					remote: config.git.remote,
					repository: destination.repository,
					baseBranch: config.git.baseBranch,
					branch,
					deliveryMode: destination.mode,
					pushTarget:
						destination.mode === 'fork'
							? `${destination.forkOwner}/${githubRepositoryName(destination.repository!)}`
							: config.git.remote,
					forkOwner: destination.forkOwner,
					forkRequired: destination.forkRequired,
					head: destination.head,
					worktreePath: join(worktreesDirectory(root), context.session.id),
					allowedPaths: [
						...modules.map((module) => `modules/${module.directory}/**`),
						...(enable ? COMPOSITION_PATHS : []),
						LOCKFILE_PATH,
					],
					budget,
					changedFiles,
					newDependencies,
					owners,
					requireReviewer: ownership.requireReviewer,
					reviewers: config.git.reviewers,
					guardrails: evaluateGuardrails({
						offending: [],
						changedFiles,
						newDependencies,
						budget,
					}),
					provider: provider.kind,
					providerNote: provider.note,
					compareUrl: destination.compareUrl,
				},
				applied: false,
			};
		},

		apply: async (context, plan, emit) => {
			assertEjectCapability(context);
			const git = plan.git;
			if (!git) {
				throw new SandboxSetupError(
					'EJECT_PLAN_INVALID',
					'The plan was not prepared for the git-pr target.',
				);
			}
			const session = context.session;
			if (inFlight.has(session.id)) {
				throw new SandboxSetupError(
					'EJECT_IN_PROGRESS',
					'A delivery of this session is already running.',
				);
			}
			inFlight.add(session.id);
			const root = context.workspaceRoot;
			const worktree = join(root, git.worktreePath);
			const run = await gitDeliveryRunner(context);
			const recorder = createStepRecorder(emit);
			const { record } = recorder;
			const assertOk = (id: string, result: CommandResult): void => {
				if (result.code !== 0) record(id, step(result));
			};
			let worktreeAdded = false;
			let localBranchCommit: string | null = null;
			let branchPrepared = false;
			let remoteBranchExisted = false;
			let remoteBranchCommit: string | null = null;
			let pushedCommit: string | null = null;
			let pushed = false;
			let delivered = false;
			try {
				/* Re-check the approved spec hash and every planned file before any
					   fork, worktree, branch, or remote mutation. */
				assertPlanStillCurrent(plan.modules, await planSessionModules(context));
				await assertWorktreeDirectoryIgnored(run, root);
				const gates = await runDeliveryGates(context, plan.gates, emit);
				const destination = pushDestination(git);

				if (git.deliveryMode === 'fork') {
					emit('fork.started', {});
					if (git.forkRequired) {
						const signedInOwner = await outputValue(
							run,
							'gh',
							['api', 'user', '--jq', '.login'],
							root,
						);
						if (!signedInOwner) {
							throw new SandboxSetupError(
								'GITHUB_IDENTITY_UNAVAILABLE',
								'GitHub did not return the signed-in account before fork creation.',
							);
						}
						const organization =
							signedInOwner.toLowerCase() === git.forkOwner!.toLowerCase()
								? []
								: ['--org', git.forkOwner!];
						record(
							'fork',
							step(
								await run(
									'gh',
									[
										'repo',
										'fork',
										git.repository!,
										'--clone=false',
										...organization,
									],
									root,
								),
								git.pushTarget,
							),
						);
					} else {
						record('fork', {
							ok: true,
							output: '',
							detail: `${git.pushTarget} already exists`,
						});
					}
				}

				const remoteOwner = await remoteBranchOwner(
					run,
					root,
					destination,
					git.branch,
				);
				remoteBranchExisted = remoteOwner.exists;
				remoteBranchCommit = remoteOwner.commit;
				if (remoteOwner.exists) {
					assertSessionBranch(git.branch, remoteOwner.message, session.id);
				}

				emit('fetch.started', {});
				record(
					'fetch',
					step(
						await run(
							'git',
							['fetch', '--quiet', git.remote, git.baseBranch],
							root,
						),
						`${git.remote}/${git.baseBranch}`,
					),
				);

				emit('worktree.started', {});
				await mkdir(join(root, worktreesDirectory(root)), { recursive: true });
				if (await exists(worktree)) await removeWorktree(run, root, worktree);
				record(
					'worktree',
					step(
						await run(
							'git',
							[
								'worktree',
								'add',
								'--detach',
								'--quiet',
								worktree,
								`${git.remote}/${git.baseBranch}`,
							],
							root,
						),
						git.worktreePath,
					),
				);
				worktreeAdded = true;

				emit('branch.started', {});
				const localBranch = await run(
					'git',
					['show-ref', '--verify', '--quiet', `refs/heads/${git.branch}`],
					root,
				);
				if (localBranch.code === 0) {
					localBranchCommit = await outputValue(
						run,
						'git',
						['rev-parse', git.branch],
						root,
					);
					const localMessage =
						(await outputValue(
							run,
							'git',
							['show', '-s', '--format=%B', git.branch],
							root,
						)) ?? '';
					assertSessionBranch(git.branch, localMessage, session.id);
				}
				record(
					'branch',
					step(
						await run('git', ['switch', '--quiet', '-C', git.branch], worktree),
						git.branch,
					),
				);
				branchPrepared = true;

				const paths = sessionPaths(root, session.id, session.moduleSuffix);
				const { copied, removed } = await stageModules(
					paths,
					worktree,
					plan.modules,
					emit,
				);

				emit('install.started', {});
				record('install', await installWorktree(run, worktree));

				let enabled = false;
				for (const module of plan.modules) {
					if (!module.enable) continue;
					emit('enable.started', { moduleId: module.id });
					record('enable', await enableModule(run, worktree, module.id));
					enabled = true;
				}

				emit('verify.started', {});
				record('verify', await verifyPlatform(run, worktree));

				emit('guardrails.started', {});
				const status = await run(
					'git',
					['status', '--porcelain', '-uall'],
					worktree,
				);
				assertOk('guardrails', status);
				const changed = porcelainPaths(status.output);
				const offending = changed.filter(
					(path) =>
						!git.allowedPaths.some((pattern) => matchesPath(path, pattern)),
				);
				const guardrails = evaluateGuardrails({
					offending,
					changedFiles: changed.length,
					newDependencies: git.newDependencies,
					budget: git.budget,
				});
				record('guardrails', {
					ok: guardrails.ok,
					output: guardrails.ok
						? changed.join('\n')
						: guardrails.reasons.join('\n'),
					detail: `${changed.length} of ${git.budget.maxChangedFiles} files`,
				});

				emit('commit.started', {});
				const pathspecs: string[] = [];
				for (const pattern of git.allowedPaths) {
					const pathspec = pathspecOf(pattern);
					if (await exists(join(worktree, pathspec))) pathspecs.push(pathspec);
				}
				assertOk(
					'commit',
					await run('git', ['add', '-A', '--', ...pathspecs], worktree),
				);
				const changes = await stagedChanges(run, worktree);
				const owners = ownersOf(await loadPathOwnership(root), [
					...changes.added,
					...changes.modified,
					...changes.removed,
				]);
				record(
					'commit',
					step(
						await withTemporaryFile(
							commitMessage(session, plan.modules, gates),
							(file) =>
								run('git', ['commit', '--quiet', '--file', file], worktree),
						),
						`${changes.added.length + changes.modified.length + changes.removed.length} files on ${git.branch}`,
					),
				);

				emit('push.started', {});
				record(
					'push',
					step(
						await run(
							'git',
							[
								'push',
								'--quiet',
								'-u',
								`--force-with-lease=refs/heads/${git.branch}:${remoteOwner.commit ?? ''}`,
								destination,
								git.branch,
							],
							worktree,
						),
						`${git.pushTarget}/${git.branch}`,
					),
				);
				pushed = true;
				pushedCommit = await outputValue(
					run,
					'git',
					['rev-parse', 'HEAD'],
					worktree,
				);

				emit('pr.started', {});
				const body = pullRequestBody({
					session,
					modules: plan.modules,
					gates,
					changes,
					owners,
					requireReviewer: git.requireReviewer,
					handoff: await lastReviewHandoff(root, session),
					specs: await specificationEvidence(root, session),
				});
				let pullRequestUrl: string | null = null;
				if (git.provider === 'github') {
					pullRequestUrl = await openPullRequest(
						run,
						worktree,
						git,
						git.repository,
						pullRequestTitle(plan.modules),
						body,
						recorder,
					);
				} else {
					record('pr', {
						ok: true,
						output: body,
						detail: git.compareUrl ?? `${git.remote}/${git.branch}`,
					});
				}
				delivered = true;

				return {
					moduleId: plan.moduleId,
					targetPath: plan.targetPath,
					files: copied,
					removed,
					enabled,
					gates,
					steps: recorder.steps,
					restartRequired: false,
					branch: git.branch,
					pullRequestUrl,
					compareUrl: git.compareUrl,
				};
			} finally {
				inFlight.delete(session.id);
				const problems: string[] = [];
				if (worktreeAdded) {
					const result = await removeWorktree(run, root, worktree);
					if (!result.ok) problems.push(result.output);
				}
				if (branchPrepared && !delivered) {
					const result = localBranchCommit
						? await run(
								'git',
								['branch', '-f', git.branch, localBranchCommit],
								root,
							)
						: await run('git', ['branch', '-D', git.branch], root);
					if (result.code !== 0) problems.push(result.output);
				}
				if (pushed && !delivered) {
					const result = remoteBranchExisted
						? await run(
								'git',
								[
									'push',
									'--quiet',
									`--force-with-lease=refs/heads/${git.branch}:${pushedCommit ?? ''}`,
									pushDestination(git),
									`${remoteBranchCommit ?? ''}:refs/heads/${git.branch}`,
								],
								root,
							)
						: await run(
								'git',
								[
									'push',
									'--quiet',
									pushDestination(git),
									'--delete',
									git.branch,
								],
								root,
							);
					if (result.code !== 0) problems.push(result.output);
				}
				emit('cleanup.completed', {
					ok: problems.length === 0,
					output: problems.join('\n'),
					detail: delivered ? `${git.branch} kept` : '',
				});
			}
		},
	};
}
