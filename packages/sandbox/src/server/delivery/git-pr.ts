import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GateResult } from '../gates.ts';
import { readChat, sessionPaths, type SandboxSession } from '../sessions.ts';
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
	GitDeliveryPlan,
} from './types.ts';

const WORKTREES_DIRECTORY = '.coreloom/sandbox/worktrees';
/* Written by module enable and pnpm install; they travel in the module's
   commit (.ai/blueprints/new-module/allowed-paths.yaml, cliOwned). */
const COMPOSITION_PATHS = [
	'coreloom.json',
	'platform/package.json',
	'platform/src/generated/**',
	'pnpm-lock.yaml',
] as const;
const FALLBACK_BUDGET: DeliveryBudget = {
	maxChangedFiles: 18,
	maxNewDependencies: 0,
};
const NO_COMMITS =
	'the repository has no commits yet; make the first commit before delivering as a pull request';
const OFFENDING_LIMIT = 20;
const PROVIDER_VARIABLE = /^(GH_|GIT_|GITHUB_)/;
const GITHUB_REMOTE =
	/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

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

/* One delivery per session at a time: two would fight over the same worktree
   path and branch. */
const inFlight = new Set<string>();

function isSecretVariable(key: string): boolean {
	if (PROVIDER_VARIABLE.test(key)) return false;
	return (
		/(TOKEN|SECRET|PASSWORD)$/i.test(key) ||
		(key.startsWith('OERP_') && /KEY$/i.test(key))
	);
}

/* git and gh see the operator's PATH, HOME, and their own settings, never the
   platform's credentials. CI is dropped because pnpm freezes the lockfile
   under it, and the worktree install has to be allowed to update it. */
function commandEnvironment(providerToken: string | null): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || key === 'CI' || isSecretVariable(key)) continue;
		env[key] = value;
	}
	Object.assign(env, {
		FORCE_COLOR: '0',
		NO_COLOR: '1',
		GIT_TERMINAL_PROMPT: '0',
		GH_PROMPT_DISABLED: '1',
		GH_NO_UPDATE_NOTIFIER: '1',
	});
	if (providerToken) env.GH_TOKEN = providerToken;
	return env;
}

async function runner(context: DeliveryContext): Promise<Run> {
	const token = context.gitProviderToken
		? await context.gitProviderToken()
		: null;
	const env = commandEnvironment(token);
	return (command, args, cwd) => context.commands(command, args, cwd, { env });
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
			`${input.changedFiles} changed files exceed the budget of ${input.budget.maxChangedFiles} (sandbox.delivery.maxChangedFiles in coreloom.json, else .ai/policies/task-budgets.yaml).`,
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
	branch: string,
): string {
	return `https://github.com/${repository}/compare/${baseBranch}...${branch}?expand=1`;
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
				? 'The gh command is not installed, so the branch is pushed without a pull request.'
				: 'gh is not signed in (run gh auth login or seal a provider token), so the branch is pushed without a pull request.',
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
	const directory = await mkdtemp(join(tmpdir(), 'coreloom-delivery-'));
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

/* Plain sentences from free text: whitespace collapsed, dashes the repository
   rules forbid replaced, cut to a sentence count and a length. */
function sentences(text: string, count: number, limit: number): string {
	const clean = text
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
}): string {
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
		'| Gate | Module | Result |',
		'| --- | --- | --- |',
		...input.gates.map(
			(gate) => `| ${gate.id} | ${gate.module ?? ''} | ${gate.status} |`,
		),
		'',
	];
	const groups: readonly [string, readonly string[]][] = [
		['Added', input.changes.added],
		['Modified', input.changes.modified],
		['Removed', input.changes.removed],
	];
	for (const [label, files] of groups) {
		if (files.length === 0) continue;
		lines.push(`${label} (${files.length}):`);
		lines.push(...files.map((file) => `- ${file}`));
		lines.push('');
	}
	for (const module of input.modules) {
		lines.push(
			`Post-merge: \`pnpm oerp auth sync-scopes --module ${module.id} --apply\` against the deployment database.`,
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
			'view',
			git.branch,
			...repositoryArgs,
			'--json',
			'url',
			'--jq',
			'.url',
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
				git.branch,
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
			const run = await runner(context);
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
			const compositionFiles =
				(enable ? 4 : 0) + (enable || newDependencies.length > 0 ? 1 : 0);
			const changedFiles = countChangedFiles(modules) + compositionFiles;
			const owners = ownersOf(ownership, [
				...modules.map((module) => `modules/${module.directory}/module.json`),
				...(enable ? ['platform/package.json'] : []),
			]);
			const run = await runner(context);
			const remoteUrl = (
				await run('git', ['remote', 'get-url', config.git.remote], root)
			).output.trim();
			const repository = githubRepository(remoteUrl);
			const branch = branchNameFor(config, context.session);
			const provider = await probeProvider(run, config, root);
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
					baseBranch: config.git.baseBranch,
					branch,
					worktreePath: join(WORKTREES_DIRECTORY, context.session.id),
					allowedPaths: [
						...modules.map((module) => `modules/${module.directory}/**`),
						...COMPOSITION_PATHS,
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
					compareUrl: repository
						? compareUrlFor(repository, config.git.baseBranch, branch)
						: null,
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
			const run = await runner(context);
			const recorder = createStepRecorder(emit);
			const { record } = recorder;
			const assertOk = (id: string, result: CommandResult): void => {
				if (result.code !== 0) record(id, step(result));
			};
			let worktreeAdded = false;
			let branchCreated = false;
			let delivered = false;
			try {
				const gates = await runDeliveryGates(context, plan.gates, emit);

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
				await mkdir(join(root, WORKTREES_DIRECTORY), { recursive: true });
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
				record(
					'branch',
					step(
						await run('git', ['switch', '--quiet', '-C', git.branch], worktree),
						git.branch,
					),
				);
				branchCreated = true;

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
				/* Best effort: a remote branch from an earlier delivery of this
				   session has to be known locally for the lease below to hold. */
				await run(
					'git',
					['fetch', '--quiet', git.remote, git.branch],
					worktree,
				);
				record(
					'push',
					step(
						await run(
							'git',
							[
								'push',
								'--quiet',
								'-u',
								'--force-with-lease',
								git.remote,
								git.branch,
							],
							worktree,
						),
						`${git.remote}/${git.branch}`,
					),
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
				});
				let pullRequestUrl: string | null = null;
				if (git.provider === 'github') {
					const remoteUrl = (
						await run('git', ['remote', 'get-url', git.remote], root)
					).output.trim();
					pullRequestUrl = await openPullRequest(
						run,
						worktree,
						git,
						githubRepository(remoteUrl),
						capitalize(describeChange(plan.modules, 'add')),
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
				if (branchCreated && !delivered) {
					const result = await run('git', ['branch', '-D', git.branch], root);
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
