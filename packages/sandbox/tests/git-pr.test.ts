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

/* Fixtures land in the scratch root the runner names, else the OS tmpdir. */
const TEST_ROOT = process.env.CORELOOM_SANDBOX_TEST_ROOT ?? tmpdir();
const PULL_REQUEST_URL = 'https://github.com/example/octane/pull/7';
const MODULE_GATES = new Set(['dependencies', 'typecheck', 'tests', 'format']);

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
}

/* A repository shaped like a Coreloom workspace with one commit on main, a
   bare remote it pushes to, and a gh on PATH that records what it was asked
   and answers with a fixed pull request URL. */
async function fixture(): Promise<Fixture> {
	await mkdir(TEST_ROOT, { recursive: true });
	const base = await mkdtemp(join(TEST_ROOT, 'coreloom-git-pr-'));
	const root = join(base, 'workspace');
	const remote = join(base, 'remote.git');
	const stubs = join(base, 'bin');
	await mkdir(root);
	await mkdir(stubs);
	await write(
		root,
		'coreloom.json',
		`${JSON.stringify(
			{
				schemaVersion: 1,
				modules: { roots: ['modules'], enabled: ['profile.core'] },
			},
			null,
			'\t',
		)}\n`,
	);
	await write(root, '.gitignore', 'node_modules/\n.coreloom/\n');
	await write(root, 'package.json', '{"name":"fixture","private":true}\n');
	await write(root, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
	await write(root, 'tsconfig.base.json', '{}\n');
	await write(root, '.prettierrc.json', '{}\n');
	await write(
		root,
		'platform/package.json',
		'{"name":"@coreloom/platform","dependencies":{}}\n',
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
	await writeFile(
		join(stubs, 'gh'),
		[
			'#!/bin/sh',
			'printf "%s\\n" "$*" >> "$GH_STUB_LOG"',
			'env > "$GH_STUB_ENV"',
			'case "$1 $2" in',
			'  "auth status") exit 0 ;;',
			'  "pr view")',
			`    if [ -f "$GH_STUB_MARKER" ]; then echo "${PULL_REQUEST_URL}"; exit 0; fi`,
			'    echo "no pull requests found" >&2; exit 1 ;;',
			'  "pr create")',
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
	return { root, remote, stubs, ghLog, ghBody, ghEnv, ghMarker };
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
	await rm(join(paths.modulePath, 'src', 'old.ts'));
	const inventory = join(paths.workspace, 'modules', 'inventory');
	await write(inventory, 'module.json', '{"id":"inventory.core"}\n');
	await write(inventory, 'src/index.ts', 'export const inventory = {};\n');
	return updateSession(root, session.id, {
		modules: [
			...session.modules,
			{ id: 'inventory.core', directory: 'inventory', kind: 'new' },
		],
	});
}

interface StubOptions {
	readonly failing?: 'install' | 'enable' | 'verify';
	readonly strayFile?: boolean;
}

/* pnpm is stubbed: install rewrites the lockfile, module enable writes the
   composition files the CLI would, typecheck passes. git and gh run for real
   (gh being the stub on PATH). */
function commandsFor(options: StubOptions = {}) {
	const calls: string[] = [];
	const commands: CommandRunner = async (command, args, cwd, runOptions) => {
		if (command !== 'pnpm') return spawnCommand(command, args, cwd, runOptions);
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
				await readFile(join(worktree, 'coreloom.json'), 'utf8'),
			) as { modules: { enabled: string[] } };
			project.modules.enabled.push(id);
			await write(
				worktree,
				'coreloom.json',
				`${JSON.stringify(project, null, '\t')}\n`,
			);
			const platform = JSON.parse(
				await readFile(join(worktree, 'platform/package.json'), 'utf8'),
			) as { dependencies: Record<string, string> };
			platform.dependencies[`@coreloom/module-${directory}`] = 'workspace:*';
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
	return { calls, commands };
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

	beforeAll(async () => {
		fx = await fixture();
		originalPath = process.env.PATH;
		process.env.PATH = `${fx.stubs}:${originalPath ?? ''}`;
		process.env.GH_STUB_LOG = fx.ghLog;
		process.env.GH_STUB_BODY = fx.ghBody;
		process.env.GH_STUB_ENV = fx.ghEnv;
		process.env.GH_STUB_MARKER = fx.ghMarker;
		process.env.OERP_TEST_TOKEN = 'must-not-leak';
	});

	afterAll(() => {
		process.env.PATH = originalPath;
		delete process.env.GH_STUB_LOG;
		delete process.env.GH_STUB_BODY;
		delete process.env.GH_STUB_ENV;
		delete process.env.GH_STUB_MARKER;
		delete process.env.OERP_TEST_TOKEN;
	});

	it('is unavailable in a repository without commits', async () => {
		const root = await mkdtemp(join(TEST_ROOT, 'coreloom-empty-repo-'));
		await write(root, 'coreloom.json', '{"schemaVersion":1}\n');
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
			'coreloom.json',
			'platform/package.json',
			'platform/src/generated/**',
			'pnpm-lock.yaml',
		]);
		/* edit-module override from task-budgets.yaml */
		expect(plan.git?.budget).toEqual({
			maxChangedFiles: 12,
			maxNewDependencies: 0,
		});
		/* 1 overwrite + 1 removal + 2 new files + 4 composition files + lock */
		expect(plan.git?.changedFiles).toBe(9);
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

	it('commits only the allowed paths, pushes, opens the pull request, and leaves the workspace alone', async () => {
		const session = await sessionWithModules(fx.root);
		const { calls, commands } = commandsFor();
		const context = contextFor(fx.root, session, commands);
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
			'coreloom.json',
			'modules/inventory/module.json',
			'modules/inventory/src/index.ts',
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
		expect(body).toContain('| Gate | Module | Result |');
		expect(body).toContain('| typecheck | inventory | passed |');
		expect(body).toContain('Removed (1):\n- modules/profile/src/old.ts');
		expect(body).toContain(
			'Post-merge: `pnpm oerp auth sync-scopes --module inventory.core --apply`',
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
		expect(ghEnv).not.toContain('OERP_TEST_TOKEN');
		expect(ghEnv).not.toContain('must-not-leak');
		expect(ghEnv).toContain('GH_STUB_LOG=');

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
		).toHaveLength(1);
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
	it('applies defaults and validates the coreloom.json block', () => {
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
			targets: ['workspace', 'git-pr'],
			git: {
				remote: 'origin',
				baseBranch: 'develop',
				branchPrefix: 'sandbox',
				provider: 'github',
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
				'  coreloom.json: pnpm oerp module enable|disable --apply',
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
			cliOwned: { 'coreloom.json': 'pnpm oerp module enable|disable --apply' },
			flags: { requireReviewer: true, count: 18 },
			list: ['one', 'two'],
		});
	});
});
