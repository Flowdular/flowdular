import { reviewFixture } from './support/auto-review.ts';
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	DEFAULT_DELIVERY_CONFIGURATION,
	createGitPullRequestDeliveryTarget,
	parsePolicyYaml,
	resolveDeliveryConfiguration,
	spawnCommand,
	type CommandRunner,
	type DeliveryConfiguration,
	type DeliveryContext,
} from '../src/server/delivery/index.ts';
import {
	createSession,
	sessionPaths,
	updateSession,
	type SandboxSession,
} from '../src/server/sessions.ts';
import { hashSpec } from '../src/server/spec.ts';

/* Fixtures land in the scratch root the runner names, else the OS tmpdir. */
const TEST_ROOT = process.env.FD_SANDBOX_TEST_ROOT ?? tmpdir();
const PULL_REQUEST_URL = 'https://github.com/example/octane/pull/7';
const MODULE_GATES = new Set([
	'auto-review',
	'dependencies',
	'typecheck',
	'tests',
	'format',
]);

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await spawnCommand('git', args, cwd);
	if (result.code !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.output}`);
	}
	return result.output.trim();
}

async function write(root: string, file: string, content: string) {
	await mkdir(join(root, file, '..'), { recursive: true });
	await writeFile(join(root, file), content, 'utf8');
}

interface Fixture {
	readonly root: string;
	readonly remote: string;
	readonly stubs: string;
	readonly ghLog: string;
	readonly ghBody: string;
	readonly ghEnv: string;
	readonly ghMarker: string;
	readonly forkMarker: string;
}

/* A repository shaped like a Flowdular workspace with one commit on main, a
   bare remote it pushes to, and a gh on PATH that records what it was asked
   and answers with a fixed pull request URL. */
async function fixture(ignoreFlowdular = true): Promise<Fixture> {
	await mkdir(TEST_ROOT, { recursive: true });
	const base = await mkdtemp(join(TEST_ROOT, 'flowdular-git-pr-'));
	const root = join(base, 'workspace');
	const remote = join(base, 'remote.git');
	const stubs = join(base, 'bin');
	await mkdir(root);
	await mkdir(stubs);
	await write(
		root,
		'flowdular.json',
		`${JSON.stringify(
			{
				schemaVersion: 1,
				modules: { roots: ['modules'], enabled: ['profile.core'] },
			},
			null,
			'\t',
		)}\n`,
	);
	await write(
		root,
		'.gitignore',
		ignoreFlowdular ? 'node_modules/\n.flowdular/\n' : 'node_modules/\n',
	);
	await write(root, 'package.json', '{"name":"fixture","private":true}\n');
	await write(root, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
	await write(root, 'tsconfig.base.json', '{}\n');
	await write(root, '.prettierrc.json', '{}\n');
	await write(
		root,
		'platform/package.json',
		'{"name":"@flowdular/platform","dependencies":{}}\n',
	);
	await write(
		root,
		'platform/src/generated/modules.server.ts',
		'export const modules = [];\n',
	);
	await write(
		root,
		'platform/src/generated/modules.client.ts',
		'export const modules = [];\n',
	);
	await write(root, 'modules/profile/module.json', '{"id":"profile.core"}\n');
	await write(root, 'modules/profile/src/index.ts', 'export const a = 1;\n');
	await write(root, 'modules/profile/src/old.ts', 'export const old = 1;\n');
	await write(
		root,
		'modules/profile/spec/module.yaml',
		[
			'id: profile.core',
			'name: Profile',
			'description: User profile',
			'specVersion: 0.1.0',
			'status: approved',
			'acceptanceScenarios:',
			'  - id: PROFILE-READ',
			'    given: a signed-in user',
			'    when: they open their profile',
			'    then: their profile is shown',
			'',
		].join('\n'),
	);
	await write(
		root,
		'.ai/policies/path-ownership.yaml',
		[
			'schemaVersion: 1',
			'owners:',
			'  packages/**: platform-architecture',
			'  modules/auth/**: platform-runtime',
			'  modules/{module}/**: module:{module}',
			'  platform/**: platform-composition',
			'crossOwnerChanges:',
			'  requireReviewer: true',
			'',
		].join('\n'),
	);
	await write(
		root,
		'.ai/policies/task-budgets.yaml',
		[
			'schemaVersion: 1',
			'defaults:',
			'  maxChangedFiles: 18',
			'  maxNewDependencies: 0',
			'overrides:',
			'  new-module:',
			'    maxChangedFiles: 30',
			'  edit-module:',
			'    maxChangedFiles: 12',
			'',
		].join('\n'),
	);
	await git(root, 'init', '-q', '-b', 'main');
	await git(root, 'config', 'user.name', 'Fixture Author');
	await git(root, 'config', 'user.email', 'fixture@example.com');
	await git(root, 'add', '-A');
	await git(root, 'commit', '-q', '-m', 'Initial workspace');
	await git(base, 'init', '-q', '--bare', remote);
	await git(root, 'remote', 'add', 'origin', remote);
	await git(root, 'push', '-q', '-u', 'origin', 'main');

	const ghLog = join(base, 'gh.log');
	const ghBody = join(base, 'pr-body.md');
	const ghEnv = join(base, 'gh.env');
	const ghMarker = join(base, 'pr-created');
	const forkMarker = join(base, 'fork-created');
	await writeFile(
		join(stubs, 'gh'),
		[
			'#!/bin/sh',
			'printf "%s\\n" "$*" >> "$GH_STUB_LOG"',
			'env > "$GH_STUB_ENV"',
			'case "$1 $2" in',
			'  "auth status") [ "$GH_STUB_AUTH_FAIL" = "1" ] && exit 1; exit 0 ;;',
			'  "api user") echo "octocat"; exit 0 ;;',
			'  "api repos/example/octane") echo "${GH_STUB_PUSH:-true}"; exit 0 ;;',
			'  "repo view")',
			'    if [ -f "$GH_STUB_FORK_MARKER" ]; then printf "%s\\t%s\\n" "$3" "${GH_STUB_FORK_PARENT:-example/octane}"; exit 0; fi',
			'    exit 1 ;;',
			'  "repo fork") touch "$GH_STUB_FORK_MARKER"; echo "forked"; exit 0 ;;',
			'  "pr list")',
			`    if [ -f "$GH_STUB_MARKER" ]; then echo "${PULL_REQUEST_URL}"; exit 0; fi`,
			'    echo "no pull requests found" >&2; exit 1 ;;',
			'  "pr create")',
			'    if [ "$GH_STUB_PR_FAIL" = "1" ]; then echo "PR failed" >&2; exit 1; fi',
			'    while [ $# -gt 0 ]; do',
			'      if [ "$1" = "--body-file" ]; then cp "$2" "$GH_STUB_BODY"; fi',
			'      shift',
			'    done',
			'    touch "$GH_STUB_MARKER"',
			`    echo "${PULL_REQUEST_URL}"; exit 0 ;;`,
			'esac',
			'echo "unexpected gh call" >&2; exit 1',
			'',
		].join('\n'),
		'utf8',
	);
	await chmod(join(stubs, 'gh'), 0o755);
	return { root, remote, stubs, ghLog, ghBody, ghEnv, ghMarker, forkMarker };
}

/* One session that edits profile.core (with a deletion) and adds
   inventory.core, so one pull request carries both. */
async function sessionWithModules(root: string): Promise<SandboxSession> {
	const session = await createSession({
		workspaceRoot: root,
		kind: 'edit-module',
		moduleId: 'profile.core',
		title: 'Stock locations',
		brief:
			'Add stock locations as a new inventory module and drop the old profile helper. Keep tenant isolation; the reviewer checks the deny scenario.',
		blueprint: 'edit-module@1.0.0',
		role: 'backend-engineer',
		driver: 'codex',
		sourceModule: 'profile',
		install: false,
	});
	const paths = sessionPaths(root, session.id, session.moduleSuffix);
	await writeFile(
		join(paths.modulePath, 'src', 'index.ts'),
		'export const a = 2;\n',
		'utf8',
	);
	await write(
		paths.modulePath,
		'spec/module.yaml',
		[
			'id: profile.core',
			'name: Profile',
			'description: User profile with stock context',
			'specVersion: 0.2.0',
			'status: approved',
			'acceptanceScenarios:',
			'  - id: PROFILE-STOCK',
			'    given: a signed-in user',
			'    when: they open stock context',
			'    then: the linked location is shown',
			'',
		].join('\n'),
	);
	await rm(join(paths.modulePath, 'src', 'old.ts'));
	const inventory = join(paths.workspace, 'modules', 'inventory');
	await write(inventory, 'module.json', '{"id":"inventory.core"}\n');
	await write(inventory, 'src/index.ts', 'export const inventory = {};\n');
	await write(
		inventory,
		'spec/module.yaml',
		[
			'id: inventory.core',
			'name: Inventory',
			'description: Stock locations',
			'specVersion: 0.1.0',
			'status: approved',
			'acceptanceScenarios:',
			'  - id: INVENTORY-LIST',
			'    given: a warehouse member',
			'    when: they list locations',
			'    then: tenant locations are shown',
			'',
		].join('\n'),
	);
	const approved = await updateSession(root, session.id, {
		modules: [
			{
				...session.modules[0]!,
				specHash: hashSpec(
					await readFile(join(paths.modulePath, 'spec', 'module.yaml'), 'utf8'),
				),
				specApprovedAt: Date.now(),
			},
			{
				id: 'inventory.core',
				directory: 'inventory',
				kind: 'new',
				specHash: hashSpec(
					await readFile(join(inventory, 'spec', 'module.yaml'), 'utf8'),
				),
				specApprovedAt: Date.now(),
			},
		],
	});
	await reviewFixture(root, approved);
	return approved;
}

interface StubOptions {
	readonly failing?: 'install' | 'enable' | 'verify';
	readonly strayFile?: boolean;
	readonly forkRemote?: string;
	readonly failPush?: boolean;
}

/* pnpm is stubbed: install rewrites the lockfile, module enable writes the
   composition files the CLI would, typecheck passes. git and gh run for real
   (gh being the stub on PATH). */
function commandsFor(options: StubOptions = {}) {
	const calls: string[] = [];
	const gitEnvironments: NodeJS.ProcessEnv[] = [];
	const commands: CommandRunner = async (command, args, cwd, runOptions) => {
		if (command === 'git') {
			gitEnvironments.push(runOptions?.env ?? {});
			const rewritten = args.map((argument) =>
				options.forkRemote &&
				/^https:\/\/github\.com\/[^/]+\/octane\.git$/.test(argument)
					? options.forkRemote
					: argument,
			);
			if (options.failPush && rewritten[0] === 'push') {
				return { code: 1, output: 'push refused by fixture' };
			}
			return spawnCommand(command, rewritten, cwd, runOptions);
		}
		if (command === 'gh') {
			return spawnCommand(command, args, cwd, {
				...runOptions,
				env: {
					...runOptions?.env,
					GH_STUB_LOG: process.env.GH_STUB_LOG,
					GH_STUB_BODY: process.env.GH_STUB_BODY,
					GH_STUB_ENV: process.env.GH_STUB_ENV,
					GH_STUB_MARKER: process.env.GH_STUB_MARKER,
					GH_STUB_FORK_MARKER: process.env.GH_STUB_FORK_MARKER,
					GH_STUB_FORK_PARENT: process.env.GH_STUB_FORK_PARENT,
					GH_STUB_PUSH: process.env.GH_STUB_PUSH,
					GH_STUB_PR_FAIL: process.env.GH_STUB_PR_FAIL,
					GH_STUB_AUTH_FAIL: process.env.GH_STUB_AUTH_FAIL,
				},
			});
		}
		if (command !== 'pnpm') return spawnCommand(command, args, cwd, runOptions);
		const providerVariables = Object.keys(runOptions?.env ?? {}).filter(
			(key) =>
				key === 'GH_TOKEN' ||
				key === 'GITHUB_TOKEN' ||
				key === 'GIT_CONFIG_VALUE_0',
		);
		if (providerVariables.length > 0) {
			return {
				code: 1,
				output: `provider credentials leaked to pnpm: ${providerVariables.join(', ')}`,
			};
		}
		const worktree = args[args.indexOf('--dir') + 1] ?? cwd;
		if (args.includes('install')) {
			calls.push('install');
			await writeFile(
				join(worktree, 'pnpm-lock.yaml'),
				"lockfileVersion: '9.0'\nrefreshed: true\n",
			);
			if (options.strayFile) {
				await write(worktree, 'platform/src/stray.ts', 'export {};\n');
			}
			return { code: options.failing === 'install' ? 1 : 0, output: '' };
		}
		if (args.includes('enable')) {
			calls.push('enable');
			const id = args[args.indexOf('enable') + 1]!;
			const directory = id.split('.')[0]!;
			const project = JSON.parse(
				await readFile(join(worktree, 'flowdular.json'), 'utf8'),
			) as { modules: { enabled: string[] } };
			project.modules.enabled.push(id);
			await write(
				worktree,
				'flowdular.json',
				`${JSON.stringify(project, null, '\t')}\n`,
			);
			const platform = JSON.parse(
				await readFile(join(worktree, 'platform/package.json'), 'utf8'),
			) as { dependencies: Record<string, string> };
			platform.dependencies[`@flowdular/module-${directory}`] = 'workspace:*';
			await write(
				worktree,
				'platform/package.json',
				`${JSON.stringify(platform, null, '\t')}\n`,
			);
			for (const side of ['server', 'client']) {
				await write(
					worktree,
					`platform/src/generated/modules.${side}.ts`,
					`export const modules = ['${id}'];\n`,
				);
			}
			return {
				code: options.failing === 'enable' ? 1 : 0,
				output: options.failing === 'enable' ? 'enable exploded' : '',
			};
		}
		if (args.includes('typecheck')) {
			calls.push('verify');
			return {
				code: options.failing === 'verify' ? 1 : 0,
				output: options.failing === 'verify' ? 'typecheck exploded' : '',
			};
		}
		calls.push(args.join(' '));
		return { code: 0, output: '' };
	};
	return { calls, commands, gitEnvironments };
}

function contextFor(
	root: string,
	session: SandboxSession,
	commands: CommandRunner,
	delivery: DeliveryConfiguration = DEFAULT_DELIVERY_CONFIGURATION,
): DeliveryContext {
	return {
		workspaceRoot: root,
		session,
		capabilities: ['sandbox.access.use', 'sandbox.modules.eject'],
		platformUrl: 'http://127.0.0.1:4310',
		delivery,
		runGates: async (gates) =>
			gates.flatMap((id) =>
				(MODULE_GATES.has(id)
					? session.modules.map((module) => module.directory)
					: [undefined]
				).map((module) => ({
					id: id as 'typecheck',
					...(module ? { module } : {}),
					status: 'passed' as const,
					durationMs: 1,
					command: id,
					output: '',
				})),
			),
		commands,
	};
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

async function remoteBranches(remote: string): Promise<string> {
	return git(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads');
}

describe('git-pr delivery', () => {
	const target = createGitPullRequestDeliveryTarget();
	let fx: Fixture;
	let originalPath: string | undefined;
	let originalGitHubToken: string | undefined;

	beforeAll(async () => {
		fx = await fixture();
		originalPath = process.env.PATH;
		originalGitHubToken = process.env.GH_TOKEN;
		process.env.PATH = `${fx.stubs}:${originalPath ?? ''}`;
		process.env.GH_TOKEN = 'outer-token-must-not-leak';
		process.env.GH_STUB_LOG = fx.ghLog;
		process.env.GH_STUB_BODY = fx.ghBody;
		process.env.GH_STUB_ENV = fx.ghEnv;
		process.env.GH_STUB_MARKER = fx.ghMarker;
		process.env.GH_STUB_FORK_MARKER = fx.forkMarker;
		process.env.FD_TEST_TOKEN = 'must-not-leak';
	});

	afterAll(() => {
		process.env.PATH = originalPath;
		if (originalGitHubToken === undefined) delete process.env.GH_TOKEN;
		else process.env.GH_TOKEN = originalGitHubToken;
		delete process.env.GH_STUB_LOG;
		delete process.env.GH_STUB_BODY;
		delete process.env.GH_STUB_ENV;
		delete process.env.GH_STUB_MARKER;
		delete process.env.GH_STUB_FORK_MARKER;
		delete process.env.GH_STUB_FORK_PARENT;
		delete process.env.GH_STUB_PUSH;
		delete process.env.GH_STUB_PR_FAIL;
		delete process.env.GH_STUB_AUTH_FAIL;
		delete process.env.FD_TEST_TOKEN;
	});

	it('is unavailable in a repository without commits', async () => {
		const root = await mkdtemp(join(TEST_ROOT, 'flowdular-empty-repo-'));
		await write(root, 'flowdular.json', '{"schemaVersion":1}\n');
		await git(root, 'init', '-q', '-b', 'main');
		const session = await createSession({
			workspaceRoot: root,
			kind: 'new-module',
			moduleId: 'inventory.core',
			title: 'Inventory',
			brief: 'Stock locations for the warehouse team.',
			blueprint: 'new-module@1.0.0',
			role: 'backend-engineer',
			driver: 'codex',
			install: false,
		});
		const availability = await target.available(
			contextFor(root, session, commandsFor().commands),
		);
		expect(availability.available).toBe(false);
		expect(availability.reason).toMatch(/no commits yet/);
	});

	it('is unavailable when the configured remote does not exist', async () => {
		const session = await sessionWithModules(fx.root);
		const availability = await target.available(
			contextFor(fx.root, session, commandsFor().commands, {
				...DEFAULT_DELIVERY_CONFIGURATION,
				git: { ...DEFAULT_DELIVERY_CONFIGURATION.git, remote: 'upstream' },
			}),
		);
		expect(availability.available).toBe(false);
		expect(availability.reason).toMatch(/upstream remote is not configured/);
	});

	it('falls back to a pushed branch when GitHub authentication is not usable', async () => {
		process.env.GH_STUB_AUTH_FAIL = '1';
		try {
			const session = await sessionWithModules(fx.root);
			const context = contextFor(fx.root, session, commandsFor().commands, {
				...DEFAULT_DELIVERY_CONFIGURATION,
				git: {
					...DEFAULT_DELIVERY_CONFIGURATION.git,
					repository: 'example/octane',
				},
			});
			expect(await target.available(context)).toEqual({
				available: true,
				reason: null,
			});
			const plan = await target.plan(context);
			expect(plan.git).toMatchObject({
				provider: 'none',
				deliveryMode: 'direct',
			});
			expect(plan.git?.providerNote).toMatch(/branch is pushed/);
			expect(plan.git?.compareUrl).toContain('https://github.com/');
		} finally {
			delete process.env.GH_STUB_AUTH_FAIL;
		}
	});

	it('is unavailable when the delivery worktree directory is not ignored', async () => {
		const isolated = await fixture(false);
		try {
			const session = await sessionWithModules(isolated.root);
			const availability = await target.available(
				contextFor(isolated.root, session, commandsFor().commands),
			);
			expect(availability.available).toBe(false);
			expect(availability.reason).toMatch(/not ignored by Git/);
		} finally {
			await rm(join(isolated.root, '..'), { recursive: true, force: true });
		}
	});

	it('pushes a branch with a compare link when the project disables the provider', async () => {
		const session = await sessionWithModules(fx.root);
		const context = contextFor(fx.root, session, commandsFor().commands, {
			...DEFAULT_DELIVERY_CONFIGURATION,
			git: {
				...DEFAULT_DELIVERY_CONFIGURATION.git,
				provider: 'none',
				repository: 'example/octane',
			},
		});
		expect(await target.available(context)).toEqual({
			available: true,
			reason: null,
		});
		const plan = await target.plan(context);
		expect(plan.git?.compareUrl).toBe(
			`https://github.com/example/octane/compare/main...${plan.git!.branch}?expand=1`,
		);
		const outcome = await target.apply(context, plan, () => undefined);
		expect(outcome.pullRequestUrl).toBeNull();
		expect(outcome.compareUrl).toBe(plan.git?.compareUrl);
	});

	it('plans the branch, the allowed paths, the budget, and the owners', async () => {
		const session = await sessionWithModules(fx.root);
		const context = contextFor(fx.root, session, commandsFor().commands);
		expect(await target.available(context)).toEqual({
			available: true,
			reason: null,
		});
		const plan = await target.plan(context);
		expect(plan.target).toBe('git-pr');
		expect(plan.git?.branch).toBe(`sandbox/profile-${session.id.slice(0, 8)}`);
		expect(plan.git?.baseBranch).toBe('main');
		expect(plan.git?.allowedPaths).toEqual([
			'modules/profile/**',
			'modules/inventory/**',
			'flowdular.json',
			'platform/package.json',
			'platform/src/generated/**',
			'pnpm-lock.yaml',
		]);
		/* edit-module override from task-budgets.yaml */
		expect(plan.git?.budget).toEqual({
			maxChangedFiles: 12,
			maxNewDependencies: 0,
		});
		/* 2 overwrites + 1 removal + 3 new files + 4 composition files + lock */
		expect(plan.git?.changedFiles).toBe(11);
		expect(plan.git?.owners).toEqual([
			'module:inventory',
			'module:profile',
			'platform-composition',
		]);
		expect(plan.git?.requireReviewer).toBe(true);
		expect(plan.git?.provider).toBe('github');
		expect(plan.git?.guardrails).toEqual({ ok: true, reasons: [] });
		expect(plan.git?.compareUrl).toBeNull();
		expect(plan.restartRequired).toBe(false);
		expect(await git(fx.root, 'status', '--porcelain')).toBe('');
	});

	it('honours maxChangedFiles from the delivery configuration over the policy', async () => {
		const session = await sessionWithModules(fx.root);
		const plan = await target.plan(
			contextFor(fx.root, session, commandsFor().commands, {
				...DEFAULT_DELIVERY_CONFIGURATION,
				maxChangedFiles: 40,
			}),
		);
		expect(plan.git?.budget.maxChangedFiles).toBe(40);
	});

	it('selects direct delivery when GitHub reports push permission', async () => {
		process.env.GH_STUB_PUSH = 'true';
		const session = await sessionWithModules(fx.root);
		const plan = await target.plan(
			contextFor(fx.root, session, commandsFor().commands, {
				...DEFAULT_DELIVERY_CONFIGURATION,
				git: {
					...DEFAULT_DELIVERY_CONFIGURATION.git,
					repository: 'example/octane',
					mode: 'auto',
				},
			}),
		);
		expect(plan.git).toMatchObject({
			repository: 'example/octane',
			deliveryMode: 'direct',
			pushTarget: 'origin',
			head: plan.git!.branch,
			forkOwner: null,
			forkRequired: false,
		});
	});

	it('never creates a fork in auto mode without explicit operator consent', async () => {
		await rm(fx.forkMarker, { force: true });
		process.env.GH_STUB_PUSH = 'false';
		try {
			const session = await sessionWithModules(fx.root);
			const context = contextFor(fx.root, session, commandsFor().commands, {
				...DEFAULT_DELIVERY_CONFIGURATION,
				git: {
					...DEFAULT_DELIVERY_CONFIGURATION.git,
					repository: 'example/octane',
					mode: 'auto',
				},
			});
			const availability = await target.available(context);
			expect(availability.available).toBe(false);
			expect(availability.reason).toMatch(/Choose Use a fork/);
			await expect(target.plan(context)).rejects.toThrow(/Choose Use a fork/);
			expect(await exists(fx.forkMarker)).toBe(false);
		} finally {
			delete process.env.GH_STUB_PUSH;
		}
	});

	it('does not allow composition files for an existing-module-only delivery', async () => {
		const session = await sessionWithModules(fx.root);
		const editOnly = await updateSession(fx.root, session.id, {
			modules: session.modules.filter((module) => module.kind === 'edit'),
		});
		const plan = await target.plan(
			contextFor(fx.root, editOnly, commandsFor().commands),
		);
		expect(plan.git?.allowedPaths).toEqual([
			'modules/profile/**',
			'pnpm-lock.yaml',
		]);
	});

	it('creates a fork after confirmation and opens a pull request from it', async () => {
		await rm(fx.forkMarker, { force: true });
		await rm(fx.ghMarker, { force: true });
		const session = await sessionWithModules(fx.root);
		const { commands } = commandsFor({ forkRemote: fx.remote });
		const context = contextFor(fx.root, session, commands, {
			...DEFAULT_DELIVERY_CONFIGURATION,
			git: {
				...DEFAULT_DELIVERY_CONFIGURATION.git,
				repository: 'example/octane',
				mode: 'fork',
				forkOwner: 'octocat',
			},
		});
		const plan = await target.plan(context);
		expect(plan.git).toMatchObject({
			deliveryMode: 'fork',
			pushTarget: 'octocat/octane',
			forkOwner: 'octocat',
			forkRequired: true,
			head: `octocat:${plan.git!.branch}`,
		});
		const outcome = await target.apply(context, plan, () => undefined);
		expect(outcome.pullRequestUrl).toBe(PULL_REQUEST_URL);
		expect(await exists(fx.forkMarker)).toBe(true);
		expect(await remoteBranches(fx.remote)).toContain(plan.git!.branch);
		const log = await readFile(fx.ghLog, 'utf8');
		expect(log).toContain('repo fork example/octane --clone=false');
		expect(log).toContain(`--head octocat:${plan.git!.branch}`);
	});

	it('creates an explicitly selected organization fork in that organization', async () => {
		await rm(fx.forkMarker, { force: true });
		await rm(fx.ghMarker, { force: true });
		const session = await sessionWithModules(fx.root);
		const { commands } = commandsFor({ forkRemote: fx.remote });
		const context = contextFor(fx.root, session, commands, {
			...DEFAULT_DELIVERY_CONFIGURATION,
			git: {
				...DEFAULT_DELIVERY_CONFIGURATION.git,
				repository: 'example/octane',
				mode: 'fork',
				forkOwner: 'acme',
			},
		});
		const plan = await target.plan(context);
		expect(plan.git).toMatchObject({
			deliveryMode: 'fork',
			pushTarget: 'acme/octane',
			forkOwner: 'acme',
		});
		await target.apply(context, plan, () => undefined);
		const log = await readFile(fx.ghLog, 'utf8');
		expect(log).toContain('repo fork example/octane --clone=false --org acme');
	});

	it('refuses an existing repository that is not a fork of the base repository', async () => {
		await writeFile(fx.forkMarker, 'existing', 'utf8');
		process.env.GH_STUB_FORK_PARENT = 'someone/other';
		try {
			const session = await sessionWithModules(fx.root);
			const context = contextFor(
				fx.root,
				session,
				commandsFor({ forkRemote: fx.remote }).commands,
				{
					...DEFAULT_DELIVERY_CONFIGURATION,
					git: {
						...DEFAULT_DELIVERY_CONFIGURATION.git,
						repository: 'example/octane',
						mode: 'fork',
						forkOwner: 'octocat',
					},
				},
			);
			const availability = await target.available(context);
			expect(availability.available).toBe(false);
			expect(availability.reason).toMatch(/is not a fork/);
			await expect(target.plan(context)).rejects.toThrow(/is not a fork/);
		} finally {
			delete process.env.GH_STUB_FORK_PARENT;
			await rm(fx.forkMarker, { force: true });
		}
	});

	it('leaves a dirty operator worktree unchanged', async () => {
		const dirty = join(fx.root, 'operator-notes.txt');
		await writeFile(dirty, 'keep me\n', 'utf8');
		try {
			const before = await git(fx.root, 'status', '--porcelain');
			const session = await sessionWithModules(fx.root);
			const context = contextFor(fx.root, session, commandsFor().commands);
			const plan = await target.plan(context);
			await target.apply(context, plan, () => undefined);
			expect(await git(fx.root, 'status', '--porcelain')).toBe(before);
			expect(await readFile(dirty, 'utf8')).toBe('keep me\n');
		} finally {
			await rm(dirty, { force: true });
		}
	});

	it('refuses a session branch that belongs to another change', async () => {
		const session = await sessionWithModules(fx.root);
		const context = contextFor(fx.root, session, commandsFor().commands);
		const plan = await target.plan(context);
		const branch = plan.git!.branch;
		await git(fx.root, 'switch', '-q', '-c', branch);
		await writeFile(join(fx.root, 'conflict.txt'), 'other change\n', 'utf8');
		await git(fx.root, 'add', 'conflict.txt');
		await git(fx.root, 'commit', '-q', '-m', 'Unrelated branch');
		await git(fx.root, 'push', '-q', 'origin', branch);
		await git(fx.root, 'switch', '-q', 'main');
		await git(fx.root, 'branch', '-D', branch);
		try {
			await expect(
				target.apply(context, plan, () => undefined),
			).rejects.toThrow(/was not created for this sandbox session/);
			expect(await exists(join(fx.root, plan.git!.worktreePath))).toBe(false);
		} finally {
			await git(fx.root, 'push', '-q', 'origin', '--delete', branch);
		}
	});

	it('cleans up after a failed push', async () => {
		const session = await sessionWithModules(fx.root);
		const context = contextFor(
			fx.root,
			session,
			commandsFor({ failPush: true }).commands,
		);
		const plan = await target.plan(context);
		await expect(target.apply(context, plan, () => undefined)).rejects.toThrow(
			/push step failed/,
		);
		expect(await exists(join(fx.root, plan.git!.worktreePath))).toBe(false);
		await expect(
			git(fx.root, 'rev-parse', '--verify', plan.git!.branch),
		).rejects.toThrow();
	});

	it('removes a newly pushed branch when pull request creation fails', async () => {
		await rm(fx.ghMarker, { force: true });
		process.env.GH_STUB_PR_FAIL = '1';
		const session = await sessionWithModules(fx.root);
		const context = contextFor(fx.root, session, commandsFor().commands);
		const plan = await target.plan(context);
		try {
			await expect(
				target.apply(context, plan, () => undefined),
			).rejects.toThrow(/pr step failed/);
			expect(await remoteBranches(fx.remote)).not.toContain(plan.git!.branch);
			expect(await exists(join(fx.root, plan.git!.worktreePath))).toBe(false);
		} finally {
			delete process.env.GH_STUB_PR_FAIL;
		}
	});

	it('restores an earlier session branch when PR creation fails on retry', async () => {
		await rm(fx.ghMarker, { force: true });
		const initialSession = await sessionWithModules(fx.root);
		const initialContext = contextFor(
			fx.root,
			initialSession,
			commandsFor().commands,
		);
		const initialPlan = await target.plan(initialContext);
		await target.apply(initialContext, initialPlan, () => undefined);
		const branch = initialPlan.git!.branch;
		const before = await git(fx.remote, 'rev-parse', `refs/heads/${branch}`);
		await rm(fx.ghMarker, { force: true });

		const paths = sessionPaths(
			fx.root,
			initialSession.id,
			initialSession.moduleSuffix,
		);
		await writeFile(
			join(paths.modulePath, 'src', 'index.ts'),
			'export const a = 3;\n',
		);
		const profileSpec = await readFile(
			join(paths.modulePath, 'spec', 'module.yaml'),
			'utf8',
		);
		const approvedSession = await updateSession(fx.root, initialSession.id, {
			modules: initialSession.modules.map((module) =>
				module.directory === 'profile'
					? {
							...module,
							specHash: hashSpec(profileSpec),
							specApprovedAt: Date.now(),
						}
					: module,
			),
		});
		process.env.GH_STUB_PR_FAIL = '1';
		try {
			const retryContext = contextFor(
				fx.root,
				approvedSession,
				commandsFor().commands,
			);
			await reviewFixture(fx.root, approvedSession);
			const retryPlan = await target.plan(retryContext);
			await expect(
				target.apply(retryContext, retryPlan, () => undefined),
			).rejects.toThrow(/pr step failed/);
			expect(await git(fx.remote, 'rev-parse', `refs/heads/${branch}`)).toBe(
				before,
			);
		} finally {
			delete process.env.GH_STUB_PR_FAIL;
		}
	});

	it('rechecks the approved spec hash before any delivery mutation', async () => {
		const session = await sessionWithModules(fx.root);
		const context = contextFor(fx.root, session, commandsFor().commands);
		const plan = await target.plan(context);
		const paths = sessionPaths(fx.root, session.id, session.moduleSuffix);
		await writeFile(
			join(paths.modulePath, 'spec', 'module.yaml'),
			'status: approved\n# changed after approval\n',
		);
		await expect(target.apply(context, plan, () => undefined)).rejects.toThrow(
			/stale specification/,
		);
		expect(await remoteBranches(fx.remote)).not.toContain(plan.git!.branch);
		expect(await exists(join(fx.root, plan.git!.worktreePath))).toBe(false);
	});

	it('refuses a changed existing migration before delivery', async () => {
		const migration = 'migrations/0001_profile_core.up.sql';
		await write(
			join(fx.root, 'modules/profile'),
			migration,
			'CREATE TABLE profile_value (id TEXT PRIMARY KEY);\n',
		);
		try {
			const session = await sessionWithModules(fx.root);
			const paths = sessionPaths(fx.root, session.id, session.moduleSuffix);
			await write(
				paths.modulePath,
				migration,
				'CREATE TABLE profile_value (id INTEGER PRIMARY KEY);\n',
			);
			await expect(
				target.plan(contextFor(fx.root, session, commandsFor().commands)),
			).rejects.toThrow(/changes an existing migration/);
		} finally {
			await rm(join(fx.root, 'modules/profile', migration), { force: true });
		}
	});

	it('commits only the allowed paths, pushes, opens the pull request, and leaves the workspace alone', async () => {
		await rm(fx.ghMarker, { force: true });
		const prCreatesBefore = (await readFile(fx.ghLog, 'utf8'))
			.split('\n')
			.filter((line) => line.startsWith('pr create')).length;
		const session = await sessionWithModules(fx.root);
		const { calls, commands, gitEnvironments } = commandsFor();
		const context = {
			...contextFor(
				fx.root,
				await updateSession(fx.root, session.id, {
					brief:
						'Add stock locations. token=github_pat_brief_secret_123456789 must never reach GitHub.',
				}),
				commands,
			),
			gitProviderToken: async () => 'github_pat_delivery-only',
		};
		const plan = await target.plan(context);
		const before = await git(fx.root, 'rev-parse', 'main');
		const events: string[] = [];
		const outcome = await target.apply(context, plan, (event) =>
			events.push(event),
		);
		const branch = plan.git!.branch;

		expect(outcome.branch).toBe(branch);
		expect(outcome.pullRequestUrl).toBe(PULL_REQUEST_URL);
		expect(outcome.enabled).toBe(true);
		expect(outcome.removed).toBe(1);
		expect(calls).toEqual(['install', 'enable', 'verify']);
		expect(events).toEqual(
			expect.arrayContaining([
				'fetch.completed',
				'worktree.completed',
				'branch.completed',
				'remove.completed',
				'guardrails.completed',
				'commit.completed',
				'push.completed',
				'pr.completed',
				'cleanup.completed',
			]),
		);

		expect(await remoteBranches(fx.remote)).toContain(branch);
		const changed = await git(
			fx.root,
			'diff',
			'--name-status',
			'main',
			`origin/${branch}`,
		);
		const rows = changed.split('\n').map((line) => line.split('\t'));
		expect(rows.map(([, path]) => path).sort()).toEqual([
			'flowdular.json',
			'modules/inventory/module.json',
			'modules/inventory/spec/module.yaml',
			'modules/inventory/src/index.ts',
			'modules/profile/spec/module.yaml',
			'modules/profile/src/index.ts',
			'modules/profile/src/old.ts',
			'platform/package.json',
			'platform/src/generated/modules.client.ts',
			'platform/src/generated/modules.server.ts',
			'pnpm-lock.yaml',
		]);
		expect(
			rows.find(([, path]) => path === 'modules/profile/src/old.ts')?.[0],
		).toBe('D');

		const message = await git(
			fx.root,
			'log',
			'-1',
			'--format=%an <%ae>%n%B',
			`origin/${branch}`,
		);
		expect(message).toContain('Fixture Author <fixture@example.com>');
		expect(message).toContain(
			'sandbox: add inventory.core and update profile.core',
		);
		expect(message).toContain(`Session ${session.id}`);

		const body = await readFile(fx.ghBody, 'utf8');
		expect(body).toContain('Adds inventory.core and updates profile.core.');
		expect(body).toContain('### profile.core');
		expect(body).toContain('Version: 0.1.0 to 0.2.0.');
		expect(body).toContain('changed: specVersion');
		expect(body).toContain('### inventory.core');
		expect(body).toContain('Version: new to 0.1.0.');
		expect(body).toContain('| Gate | Module | Result |');
		expect(body).toContain('| typecheck | inventory | passed |');
		expect(body).toContain('2 module test gate(s) passed');
		expect(body).toContain('The platform typecheck passed');
		expect(body).not.toContain('github_pat_brief_secret');
		expect(body).toContain('token: [redacted]');
		expect(body).toContain('Removed (1):\n- modules/profile/src/old.ts');
		expect(body).toContain(
			'Post-merge: `pnpm flowdular auth sync-scopes --module inventory.core --apply`',
		);
		expect(body).toContain(`Session ${session.id}.`);
		expect(body).toContain(
			'Cross-owner change (module:inventory, module:profile, platform-composition)',
		);
		for (const text of [body, message]) {
			expect(text).not.toMatch(/co-authored-by|generated with|claude/i);
			expect(text).not.toMatch(/[\u2013\u2014]/);
		}
		const ghLog = await readFile(fx.ghLog, 'utf8');
		expect(ghLog).toContain(
			`pr create --base main --head ${branch} --title Add inventory.core and update profile.core --body-file`,
		);
		const ghEnv = await readFile(fx.ghEnv, 'utf8');
		expect(ghEnv).not.toContain('FD_TEST_TOKEN');
		expect(ghEnv).not.toContain('must-not-leak');
		expect(ghEnv).not.toContain('outer-token-must-not-leak');
		expect(ghEnv).toContain('GH_TOKEN=github_pat_delivery-only');
		expect(ghEnv).not.toContain('GIT_CONFIG_VALUE_0');
		expect(ghEnv).toContain('GH_STUB_LOG=');
		expect(
			gitEnvironments.every(
				(environment) => environment.GH_TOKEN === undefined,
			),
		).toBe(true);

		/* The operator's tree, index, and main are untouched; the worktree is
		   gone and the local branch is kept. */
		expect(await git(fx.root, 'status', '--porcelain')).toBe('');
		expect(await git(fx.root, 'rev-parse', 'main')).toBe(before);
		expect(await exists(join(fx.root, 'modules/profile/src/old.ts'))).toBe(
			true,
		);
		expect(await exists(join(fx.root, 'modules/inventory'))).toBe(false);
		expect(await exists(join(fx.root, plan.git!.worktreePath))).toBe(false);
		expect((await git(fx.root, 'worktree', 'list')).split('\n')).toHaveLength(
			1,
		);
		expect(await git(fx.root, 'rev-parse', '--verify', branch)).toBe(
			await git(fx.root, 'rev-parse', `origin/${branch}`),
		);

		/* Delivering the same session again updates the branch and reuses the
		   open pull request instead of failing on the push or opening another. */
		const again = await target.apply(context, plan, () => undefined);
		expect(again.pullRequestUrl).toBe(PULL_REQUEST_URL);
		expect(
			(await readFile(fx.ghLog, 'utf8'))
				.split('\n')
				.filter((line) => line.startsWith('pr create')),
		).toHaveLength(prCreatesBefore + 1);
	});

	it('fails before the commit when the change exceeds the budget', async () => {
		const session = await sessionWithModules(fx.root);
		const context = contextFor(fx.root, session, commandsFor().commands, {
			...DEFAULT_DELIVERY_CONFIGURATION,
			maxChangedFiles: 3,
		});
		const plan = await target.plan(context);
		expect(plan.git?.guardrails.ok).toBe(false);
		expect(plan.git?.guardrails.reasons[0]).toMatch(/exceed the budget of 3/);
		const events: string[] = [];
		await expect(
			target.apply(context, plan, (event) => events.push(event)),
		).rejects.toThrow(/guardrails step failed/);
		expect(events).not.toContain('commit.started');
		expect(events).toContain('cleanup.completed');
		expect(await remoteBranches(fx.remote)).not.toContain(plan.git!.branch);
		await expect(
			git(fx.root, 'rev-parse', '--verify', plan.git!.branch),
		).rejects.toThrow();
		expect(await exists(join(fx.root, plan.git!.worktreePath))).toBe(false);
		expect(await git(fx.root, 'status', '--porcelain')).toBe('');
	});

	it('fails before the commit when a step writes outside the allowed paths', async () => {
		const session = await sessionWithModules(fx.root);
		const context = contextFor(
			fx.root,
			session,
			commandsFor({ strayFile: true }).commands,
		);
		const plan = await target.plan(context);
		await expect(target.apply(context, plan, () => undefined)).rejects.toThrow(
			/platform\/src\/stray\.ts/,
		);
		expect(await remoteBranches(fx.remote)).not.toContain(plan.git!.branch);
		expect(await exists(join(fx.root, plan.git!.worktreePath))).toBe(false);
	});

	it('stops at a failing step, removes the worktree, and drops the branch', async () => {
		const session = await sessionWithModules(fx.root);
		const { calls, commands } = commandsFor({ failing: 'verify' });
		const context = contextFor(fx.root, session, commands);
		const plan = await target.plan(context);
		const events: string[] = [];
		await expect(
			target.apply(context, plan, (event) => events.push(event)),
		).rejects.toThrow(/verify step failed/);
		expect(calls).toEqual(['install', 'enable', 'verify']);
		expect(events).not.toContain('guardrails.started');
		expect(await exists(join(fx.root, plan.git!.worktreePath))).toBe(false);
		await expect(
			git(fx.root, 'rev-parse', '--verify', plan.git!.branch),
		).rejects.toThrow();
		expect(await remoteBranches(fx.remote)).not.toContain(plan.git!.branch);
	});
});

describe('delivery configuration and policies', () => {
	it('applies defaults and validates the flowdular.json block', () => {
		expect(resolveDeliveryConfiguration(undefined)).toEqual(
			DEFAULT_DELIVERY_CONFIGURATION,
		);
		expect(
			resolveDeliveryConfiguration({
				default: 'git-pr',
				git: { baseBranch: 'develop', reviewers: ['octocat'] },
				maxChangedFiles: 25,
			}),
		).toEqual({
			default: 'git-pr',
			targets: ['workspace', 'git-pr', 'official-modules'],
			git: {
				remote: 'origin',
				repository: null,
				baseBranch: 'develop',
				branchPrefix: 'sandbox',
				provider: 'github',
				mode: 'auto',
				forkOwner: null,
				reviewers: ['octocat'],
			},
			maxChangedFiles: 25,
		});
		expect(() =>
			resolveDeliveryConfiguration({
				default: 'git-pr',
				targets: ['workspace'],
			}),
		).toThrow(/default must be one of the listed targets/);
		expect(() =>
			resolveDeliveryConfiguration({ git: { remote: '--upload-pack=x' } }),
		).toThrow(/git.remote/);
		expect(() => resolveDeliveryConfiguration({ maxChangedFiles: 0 })).toThrow(
			/positive integer/,
		);
		expect(() =>
			resolveDeliveryConfiguration({
				git: { branchPrefix: `sandbox/${'a'.repeat(121)}` },
			}),
		).toThrow(/git.branchPrefix/);
		expect(() =>
			resolveDeliveryConfiguration({
				git: { reviewers: Array.from({ length: 21 }, () => 'octocat') },
			}),
		).toThrow(/reviewers/);
	});

	it('reads the shapes the policy files use', () => {
		const parsed = parsePolicyYaml(
			[
				'schemaVersion: 1',
				'# a comment',
				'owners:',
				'  modules/{module}/**: module:{module}',
				'  modules/{module}/tests/**:',
				'    [backend-engineer, frontend-engineer,',
				'    agentic-engineer]',
				'cliOwned:',
				'  flowdular.json: pnpm flowdular module enable|disable --apply',
				'flags:',
				'  requireReviewer: true',
				'  count: 18',
				'list:',
				'  - one',
				'  - two',
			].join('\n'),
		);
		expect(parsed).toEqual({
			schemaVersion: 1,
			owners: {
				'modules/{module}/**': 'module:{module}',
				'modules/{module}/tests/**': [
					'backend-engineer',
					'frontend-engineer',
					'agentic-engineer',
				],
			},
			cliOwned: {
				'flowdular.json': 'pnpm flowdular module enable|disable --apply',
			},
			flags: { requireReviewer: true, count: 18 },
			list: ['one', 'two'],
		});
	});
});
