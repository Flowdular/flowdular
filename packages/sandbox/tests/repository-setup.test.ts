import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouter } from '@octanejs/app-core';
import {
	DEFAULT_CONFIGURATION,
	type SandboxConfiguration,
} from '../src/server/config.ts';
import {
	createGitPullRequestDeliveryTarget,
	DEFAULT_DELIVERY_CONFIGURATION,
	type CommandRunner,
	type DeliveryContext,
} from '../src/server/delivery/index.ts';
import type { PreviewRuntime } from '../src/server/preview-runtime.ts';
import { createSandboxRoutes } from '../src/server/routes.ts';
import type { SandboxRuntime } from '../src/server/runtime.ts';
import type { SandboxSession } from '../src/server/sessions.ts';
import {
	applyRepositorySetup,
	cancelPendingRepositorySetup,
	planRepositorySetup,
	readPendingRepositorySetup,
} from '../src/server/repository-setup.ts';

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function checkout(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-repository-setup-'));
	directories.push(root);
	await execFileAsync('git', ['init', '-b', 'source'], { cwd: root });
	await execFileAsync('git', ['config', 'user.name', 'Sandbox Test'], {
		cwd: root,
	});
	await execFileAsync('git', ['config', 'user.email', 'sandbox@example.test'], {
		cwd: root,
	});
	await writeFile(
		join(root, 'flowdular.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
	);
	await writeFile(join(root, '.gitignore'), '.flowdular/\n');
	await execFileAsync('git', ['add', '.'], { cwd: root });
	await execFileAsync('git', ['commit', '-m', 'application base'], {
		cwd: root,
	});
	return root;
}

async function git(root: string, ...args: string[]): Promise<string> {
	return (await execFileAsync('git', args, { cwd: root })).stdout.trim();
}

function fixtureRunner(
	root: string,
	options: {
		readonly remoteHead?: string | null;
		readonly pushFails?: boolean;
		readonly verificationFailsOnce?: boolean;
		readonly private?: boolean;
		readonly createFails?: boolean;
		readonly createDeniedOnce?: boolean;
		readonly absenceLookupUnavailable?: boolean;
		readonly createFailsAfterWrite?: boolean;
		readonly onCreate?: () => void;
	} = {},
) {
	let remoteHead = options.remoteHead ?? null;
	let created = false;
	let createCount = 0;
	let createAttempts = 0;
	let pushed = false;
	let verificationFailed = false;
	const calls: Array<{
		command: string;
		args: readonly string[];
		env: NodeJS.ProcessEnv | undefined;
	}> = [];
	const commands: CommandRunner = async (command, args, cwd, runOptions) => {
		calls.push({ command, args, env: runOptions?.env });
		if (command === 'gh') {
			if (args[0] === 'api' && args[1] === 'user')
				return { code: 0, output: 'example\n' };
			if (args[0] === 'repo' && args[1] === 'view')
				return { code: created ? 0 : 1, output: created ? 'example/app' : '' };
			if (args[0] === 'repo' && args[1] === 'create') {
				createAttempts++;
				if (options.createFails) return { code: 1, output: 'secret-token' };
				if (options.createDeniedOnce && createAttempts === 1)
					return {
						code: 1,
						output:
							'GraphQL: Resource not accessible by integration (createRepository)',
					};
				created = true;
				createCount++;
				options.onCreate?.();
				if (options.createFailsAfterWrite)
					return { code: 1, output: 'response lost after creation' };
				return { code: 0, output: 'created' };
			}
			if (args[0] === 'api' && args[1] === 'repos/example/app') {
				if (options.absenceLookupUnavailable)
					return { code: 1, output: 'temporary GitHub error' };
				if (!created) return { code: 1, output: 'gh: Not Found (HTTP 404)' };
				return {
					code: 0,
					output: options.private === false ? 'false' : 'true',
				};
			}
			return { code: 1, output: '' };
		}
		if (command === 'git' && args[0] === 'ls-remote') {
			if (pushed && options.verificationFailsOnce && !verificationFailed) {
				verificationFailed = true;
				return { code: 1, output: 'temporary GitHub error' };
			}
			return {
				code: 0,
				output: remoteHead ? `${remoteHead}\trefs/heads/main\n` : '',
			};
		}
		if (command === 'git' && args[0] === 'push') {
			if (options.pushFails) return { code: 1, output: 'secret-token' };
			remoteHead = await git(root, 'rev-parse', 'HEAD');
			pushed = true;
			return { code: 0, output: 'pushed' };
		}
		try {
			const result = await execFileAsync(command, [...args], { cwd });
			return { code: 0, output: result.stdout + result.stderr };
		} catch {
			return { code: 1, output: '' };
		}
	};
	return {
		commands,
		calls,
		created: () => created,
		createCount: () => createCount,
		createAttempts: () => createAttempts,
		remoteHead: () => remoteHead,
		setRemoteHead: (head: string | null) => {
			remoteHead = head;
		},
	};
}

const TOKEN = 'ghp_testtoken';

describe('application repository setup', () => {
	it('plans and connects only an empty GitHub repository, then pushes HEAD to main', async () => {
		const root = await checkout();
		const beforeBranch = await git(root, 'branch', '--show-current');
		const beforeHead = await git(root, 'rev-parse', 'HEAD');
		await git(
			root,
			'remote',
			'add',
			'origin',
			'https://github.com/Flowdular/flowdular.git',
		);
		const fixture = fixtureRunner(root);
		const dependencies = { commands: fixture.commands, providerToken: TOKEN };
		const plan = await planRepositorySetup(
			root,
			{ mode: 'connect', repository: 'example/app' },
			dependencies,
		);
		expect(plan).toMatchObject({
			mode: 'connect',
			repository: 'example/app',
			remote: 'app',
			branch: 'main',
			head: beforeHead,
			visibility: 'existing',
			remoteAlreadyConfigured: false,
			resuming: false,
		});
		expect(fixture.calls.some((call) => call.args[0] === 'push')).toBe(false);
		const result = await applyRepositorySetup(root, plan, dependencies);
		expect(result).toMatchObject({
			url: 'https://github.com/example/app',
			created: false,
			head: beforeHead,
		});
		expect(fixture.remoteHead()).toBe(beforeHead);
		expect(await git(root, 'remote', 'get-url', 'app')).toBe(
			'https://github.com/example/app.git',
		);
		expect(await git(root, 'remote', 'get-url', 'origin')).toBe(
			'https://github.com/Flowdular/flowdular.git',
		);
		expect(await git(root, 'branch', '--show-current')).toBe(beforeBranch);
		expect(await git(root, 'rev-parse', 'HEAD')).toBe(beforeHead);
		expect(fixture.calls.find((call) => call.args[0] === 'push')?.args).toEqual(
			['push', 'https://github.com/example/app.git', 'HEAD:refs/heads/main'],
		);
		expect(
			JSON.stringify(fixture.calls.map((call) => call.args)),
		).not.toContain(TOKEN);
		expect(
			fixture.calls.find((call) => call.args[0] === 'push')?.env
				?.GIT_CONFIG_VALUE_0,
		).toContain('AUTHORIZATION: basic ');
	});

	it('creates a private repository only during apply, verifies privacy, then pushes', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root);
		const dependencies = { commands: fixture.commands, providerToken: TOKEN };
		const plan = await planRepositorySetup(
			root,
			{ mode: 'create', repository: 'example/app' },
			dependencies,
		);
		expect(plan.visibility).toBe('private');
		expect(fixture.created()).toBe(false);
		const result = await applyRepositorySetup(root, plan, dependencies);
		expect(result.created).toBe(true);
		expect(fixture.created()).toBe(true);
		const create = fixture.calls.find(
			(call) => call.command === 'gh' && call.args[1] === 'create',
		);
		expect(create?.args).toEqual([
			'repo',
			'create',
			'example/app',
			'--private',
		]);
		expect(await git(root, 'remote', 'get-url', 'app')).toBe(
			'https://github.com/example/app.git',
		);
		const privacyIndex = fixture.calls.findIndex(
			(call) => call.command === 'gh' && call.args[1] === 'repos/example/app',
		);
		const pushIndex = fixture.calls.findIndex(
			(call) => call.args[0] === 'push',
		);
		expect(privacyIndex).toBeGreaterThan(-1);
		expect(pushIndex).toBeGreaterThan(privacyIndex);
	});

	it('does not push when GitHub fails to confirm private visibility', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root, { private: false });
		const dependencies = { commands: fixture.commands, providerToken: TOKEN };
		const plan = await planRepositorySetup(
			root,
			{ mode: 'create', repository: 'example/app' },
			dependencies,
		);
		await expect(
			applyRepositorySetup(root, plan, dependencies),
		).rejects.toMatchObject({ code: 'REPO_SETUP_PRIVACY_UNVERIFIED' });
		expect(fixture.calls.some((call) => call.args[0] === 'push')).toBe(false);
	});

	it('does not create a second repository when GitHub loses the create response', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root, { createFailsAfterWrite: true });
		const dependencies = { commands: fixture.commands, providerToken: TOKEN };
		const plan = await planRepositorySetup(
			root,
			{ mode: 'create', repository: 'example/app' },
			dependencies,
		);
		await expect(
			applyRepositorySetup(root, plan, dependencies),
		).rejects.toMatchObject({ code: 'REPO_SETUP_CREATE_FAILED' });
		await expect(
			applyRepositorySetup(root, plan, dependencies),
		).resolves.toMatchObject({ created: true, head: plan.head });
		expect(fixture.createCount()).toBe(1);
		expect(
			fixture.calls.filter((call) => call.args[0] === 'push'),
		).toHaveLength(1);
	});

	it('releases a rejected create so the operator can retry or choose another name', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root, { createDeniedOnce: true });
		const dependencies = { commands: fixture.commands, providerToken: TOKEN };
		const plan = await planRepositorySetup(
			root,
			{ mode: 'create', repository: 'example/app' },
			dependencies,
		);
		await expect(
			applyRepositorySetup(root, plan, dependencies),
		).rejects.toMatchObject({ code: 'REPO_SETUP_CREATE_FAILED' });
		expect(fixture.createAttempts()).toBe(1);
		expect(fixture.calls.some((call) => call.args[0] === 'push')).toBe(false);
		await expect(
			planRepositorySetup(
				root,
				{ mode: 'create', repository: 'example/other' },
				dependencies,
			),
		).resolves.toMatchObject({ repository: 'example/other', resuming: false });
		const retry = await planRepositorySetup(
			root,
			{ mode: 'create', repository: 'example/app' },
			dependencies,
		);
		expect(retry.resuming).toBe(false);
		await expect(
			applyRepositorySetup(root, retry, dependencies),
		).resolves.toMatchObject({ repository: 'example/app', created: true });
		expect(fixture.createAttempts()).toBe(2);
		expect(fixture.createCount()).toBe(1);
	});

	it('retains the pending create after an ambiguous command failure', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root, { createFails: true });
		const dependencies = { commands: fixture.commands, providerToken: TOKEN };
		const plan = await planRepositorySetup(
			root,
			{ mode: 'create', repository: 'example/app' },
			dependencies,
		);
		await expect(
			applyRepositorySetup(root, plan, dependencies),
		).rejects.toMatchObject({ code: 'REPO_SETUP_CREATE_FAILED' });
		await expect(
			planRepositorySetup(
				root,
				{ mode: 'create', repository: 'example/app' },
				dependencies,
			),
		).rejects.toMatchObject({ code: 'REPO_SETUP_CREATE_UNVERIFIED' });
		await expect(
			planRepositorySetup(
				root,
				{ mode: 'create', repository: 'example/other' },
				dependencies,
			),
		).rejects.toMatchObject({ code: 'REPO_SETUP_PENDING_OTHER' });
		expect(fixture.createAttempts()).toBe(1);
	});

	it('lets the operator discard a failed create only after authenticated 404 and choose another repository', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root, { createFails: true });
		const dependencies = { commands: fixture.commands, providerToken: TOKEN };
		const plan = await planRepositorySetup(
			root,
			{ mode: 'create', repository: 'example/app' },
			dependencies,
		);
		await expect(
			applyRepositorySetup(root, plan, dependencies),
		).rejects.toMatchObject({ code: 'REPO_SETUP_CREATE_FAILED' });
		await expect(readPendingRepositorySetup(root)).resolves.toMatchObject({
			mode: 'create',
			repository: 'example/app',
		});
		await cancelPendingRepositorySetup(root, 'example/app', dependencies);
		await expect(readPendingRepositorySetup(root)).resolves.toBeNull();
		await expect(
			planRepositorySetup(
				root,
				{ mode: 'create', repository: 'example/other' },
				dependencies,
			),
		).resolves.toMatchObject({ repository: 'example/other', resuming: false });
		expect(fixture.createAttempts()).toBe(1);
	});

	it('refuses cancellation when creation may have succeeded or absence cannot be confirmed', async () => {
		for (const options of [
			{ createFailsAfterWrite: true },
			{ createFails: true, absenceLookupUnavailable: true },
		]) {
			const root = await checkout();
			const fixture = fixtureRunner(root, options);
			const dependencies = { commands: fixture.commands, providerToken: TOKEN };
			const plan = await planRepositorySetup(
				root,
				{ mode: 'create', repository: 'example/app' },
				dependencies,
			);
			await expect(
				applyRepositorySetup(root, plan, dependencies),
			).rejects.toMatchObject({ code: 'REPO_SETUP_CREATE_FAILED' });
			await expect(
				cancelPendingRepositorySetup(root, 'example/app', dependencies),
			).rejects.toMatchObject({
				code: options.createFailsAfterWrite
					? 'REPO_SETUP_CANCEL_UNSAFE'
					: 'REPO_SETUP_CREATE_UNVERIFIED',
			});
			await expect(readPendingRepositorySetup(root)).resolves.toMatchObject({
				repository: 'example/app',
			});
		}
	});

	it('removes only the pending app remote after a confirmed absent create', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root, { createFails: true });
		const dependencies = { commands: fixture.commands, providerToken: TOKEN };
		const plan = await planRepositorySetup(
			root,
			{ mode: 'create', repository: 'example/app' },
			dependencies,
		);
		await expect(
			applyRepositorySetup(root, plan, dependencies),
		).rejects.toMatchObject({ code: 'REPO_SETUP_CREATE_FAILED' });
		await git(
			root,
			'remote',
			'add',
			'app',
			'https://github.com/example/app.git',
		);
		await cancelPendingRepositorySetup(root, 'example/app', dependencies);
		expect(await git(root, 'remote')).toBe('');
		expect(await readPendingRepositorySetup(root)).toBeNull();
	});

	it('keeps the journal when write authority is revoked before cancellation', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root, { createFails: true });
		const dependencies = { commands: fixture.commands, providerToken: TOKEN };
		const plan = await planRepositorySetup(
			root,
			{ mode: 'create', repository: 'example/app' },
			dependencies,
		);
		await expect(
			applyRepositorySetup(root, plan, dependencies),
		).rejects.toMatchObject({ code: 'REPO_SETUP_CREATE_FAILED' });
		await expect(
			cancelPendingRepositorySetup(root, 'example/app', {
				...dependencies,
				assertCanPublish: async () => {
					throw new Error('write authority revoked');
				},
			}),
		).rejects.toThrow('write authority revoked');
		await expect(readPendingRepositorySetup(root)).resolves.toMatchObject({
			repository: 'example/app',
		});
	});

	it('retains the pending create when GitHub cannot confirm absence after a rejection', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root, {
			createDeniedOnce: true,
			absenceLookupUnavailable: true,
		});
		const dependencies = { commands: fixture.commands, providerToken: TOKEN };
		const plan = await planRepositorySetup(
			root,
			{ mode: 'create', repository: 'example/app' },
			dependencies,
		);
		await expect(
			applyRepositorySetup(root, plan, dependencies),
		).rejects.toMatchObject({ code: 'REPO_SETUP_CREATE_FAILED' });
		await expect(
			planRepositorySetup(
				root,
				{ mode: 'create', repository: 'example/app' },
				dependencies,
			),
		).rejects.toMatchObject({ code: 'REPO_SETUP_CREATE_UNVERIFIED' });
		expect(fixture.createAttempts()).toBe(1);
	});

	it('rejects a populated remote before adding a local remote or pushing', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root, { remoteHead: 'a'.repeat(40) });
		await expect(
			planRepositorySetup(
				root,
				{ mode: 'connect', repository: 'example/app' },
				{ commands: fixture.commands, providerToken: TOKEN },
			),
		).rejects.toMatchObject({ code: 'REPO_SETUP_REMOTE_NOT_EMPTY' });
		expect(fixture.calls.some((call) => call.args[0] === 'push')).toBe(false);
		expect(await git(root, 'remote')).toBe('');
	});

	it('rejects a stale plan when HEAD changes before apply', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root);
		const dependencies = { commands: fixture.commands, providerToken: TOKEN };
		const plan = await planRepositorySetup(
			root,
			{ mode: 'connect', repository: 'example/app' },
			dependencies,
		);
		await writeFile(join(root, 'second.txt'), 'new commit');
		await git(root, 'add', '.');
		await git(root, 'commit', '-m', 'second');
		await expect(
			applyRepositorySetup(root, plan, dependencies),
		).rejects.toMatchObject({ code: 'REPO_SETUP_PLAN_STALE' });
		expect(fixture.calls.some((call) => call.args[0] === 'push')).toBe(false);
	});

	it('serializes a push through real and symlinked workspace paths', async () => {
		const root = await checkout();
		const aliasDirectory = await mkdtemp(
			join(tmpdir(), 'flowdular-repo-alias-'),
		);
		directories.push(aliasDirectory);
		const alias = join(aliasDirectory, 'checkout');
		await symlink(root, alias, 'dir');
		const fixture = fixtureRunner(root);
		let blockNextCheckoutRead = false;
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const reached = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const commands: CommandRunner = async (command, args, cwd, options) => {
			if (
				blockNextCheckoutRead &&
				command === 'git' &&
				args[0] === 'rev-parse' &&
				args[1] === '--show-toplevel'
			) {
				blockNextCheckoutRead = false;
				entered();
				await gate;
			}
			return fixture.commands(command, args, cwd, options);
		};
		const dependencies = { commands, providerToken: TOKEN };
		const plan = await planRepositorySetup(
			root,
			{ mode: 'connect', repository: 'example/app' },
			dependencies,
		);
		blockNextCheckoutRead = true;
		const first = applyRepositorySetup(root, plan, dependencies);
		await reached;
		try {
			await expect(
				applyRepositorySetup(alias, plan, dependencies),
			).rejects.toMatchObject({ code: 'REPO_SETUP_BUSY' });
		} finally {
			release();
		}
		await expect(first).resolves.toMatchObject({ repository: 'example/app' });
		expect(
			fixture.calls.filter((call) => call.args[0] === 'push'),
		).toHaveLength(1);
	});

	it('keeps cancellation out while another module instance is creating the repository', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root);
		const dependencies = { commands: fixture.commands, providerToken: TOKEN };
		const plan = await planRepositorySetup(
			root,
			{ mode: 'create', repository: 'example/app' },
			dependencies,
		);
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const reached = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const first = applyRepositorySetup(root, plan, {
			...dependencies,
			assertCanPublish: async () => {
				entered();
				await gate;
			},
		});
		await reached;
		try {
			/* The second import has an independent in-memory inFlight set, as a
			   second sandbox process would, but shares the checkout on disk. */
			vi.resetModules();
			const other = await import('../src/server/repository-setup.ts');
			await expect(
				other.cancelPendingRepositorySetup(root, 'example/app', dependencies),
			).rejects.toMatchObject({ code: 'REPO_SETUP_BUSY' });
			expect(await readPendingRepositorySetup(root)).toMatchObject({
				repository: 'example/app',
			});
			expect(fixture.createAttempts()).toBe(0);
		} finally {
			release();
		}
		await expect(first).resolves.toMatchObject({ repository: 'example/app' });
		expect(fixture.createAttempts()).toBe(1);
		expect(
			fixture.calls.filter((call) => call.args[0] === 'push'),
		).toHaveLength(1);
	});

	it('recovers a dead process lock while retaining the pending publication', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root, { createFailsAfterWrite: true });
		const dependencies = { commands: fixture.commands, providerToken: TOKEN };
		const plan = await planRepositorySetup(
			root,
			{ mode: 'create', repository: 'example/app' },
			dependencies,
		);
		await expect(
			applyRepositorySetup(root, plan, dependencies),
		).rejects.toMatchObject({ code: 'REPO_SETUP_CREATE_FAILED' });
		const lock = join(root, '.flowdular', 'repository-setup-operation.lock');
		await mkdir(lock);
		await writeFile(
			join(lock, 'owner.json'),
			JSON.stringify({ pid: 2_147_483_647, id: randomUUID() }),
		);
		const abandonedRecovery = join(lock, 'recovery');
		await mkdir(abandonedRecovery);
		await writeFile(
			join(abandonedRecovery, 'owner.json'),
			JSON.stringify({ pid: 2_147_483_647, id: randomUUID() }),
		);
		const resumed = await planRepositorySetup(
			root,
			{ mode: 'create', repository: 'example/app' },
			dependencies,
		);
		expect(resumed.resuming).toBe(true);
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const reached = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const recovering = applyRepositorySetup(root, resumed, {
			...dependencies,
			assertCanPublish: async () => {
				entered();
				await gate;
			},
		});
		await reached;
		try {
			vi.resetModules();
			const other = await import('../src/server/repository-setup.ts');
			await expect(
				other.applyRepositorySetup(root, resumed, dependencies),
			).rejects.toMatchObject({ code: 'REPO_SETUP_BUSY' });
		} finally {
			release();
		}
		await expect(recovering).resolves.toMatchObject({
			repository: 'example/app',
			created: true,
		});
		expect(fixture.createAttempts()).toBe(1);
		expect(await readPendingRepositorySetup(root)).toMatchObject({
			repository: 'example/app',
		});
	});

	it('requires a committed, clean checkout before planning a push', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root);
		await writeFile(join(root, 'untracked.txt'), 'not committed');
		await expect(
			planRepositorySetup(
				root,
				{ mode: 'connect', repository: 'example/app' },
				{ commands: fixture.commands, providerToken: TOKEN },
			),
		).rejects.toMatchObject({ code: 'REPO_SETUP_CHECKOUT_DIRTY' });
		expect(fixture.calls.some((call) => call.args[0] === 'push')).toBe(false);
	});

	it('does not expose command output when an initial push fails', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root, { pushFails: true });
		const dependencies = { commands: fixture.commands, providerToken: TOKEN };
		const plan = await planRepositorySetup(
			root,
			{ mode: 'connect', repository: 'example/app' },
			dependencies,
		);
		let failure: unknown;
		try {
			await applyRepositorySetup(root, plan, dependencies);
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({ code: 'REPO_SETUP_PUSH_FAILED' });
		expect((failure as Error).message).not.toContain('secret-token');
		/* A retry can use Connect because the app remote points at the same
		   still-empty repository. */
		await expect(
			planRepositorySetup(
				root,
				{ mode: 'connect', repository: 'example/app' },
				dependencies,
			),
		).resolves.toMatchObject({ fingerprint: plan.fingerprint });
		expect(await git(root, 'remote', 'get-url', 'app')).toBe(
			'https://github.com/example/app.git',
		);
	});

	it('resumes an uncertain push only when the remote still has the approved HEAD', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root, { verificationFailsOnce: true });
		const dependencies = { commands: fixture.commands, providerToken: TOKEN };
		const plan = await planRepositorySetup(
			root,
			{ mode: 'connect', repository: 'example/app' },
			dependencies,
		);
		await expect(
			applyRepositorySetup(root, plan, dependencies),
		).rejects.toMatchObject({ code: 'REPO_SETUP_PUSH_UNVERIFIED' });
		expect(fixture.remoteHead()).toBe(plan.head);
		const recoveredPlan = await planRepositorySetup(
			root,
			{ mode: 'connect', repository: 'example/app' },
			dependencies,
		);
		expect(recoveredPlan.fingerprint).toBe(plan.fingerprint);
		expect(recoveredPlan.resuming).toBe(true);
		await expect(
			applyRepositorySetup(root, recoveredPlan, dependencies),
		).resolves.toMatchObject({ head: plan.head });
		expect(
			fixture.calls.filter((call) => call.args[0] === 'push'),
		).toHaveLength(1);
	});

	it('refuses an uncertain push if GitHub now points to another commit', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root, { verificationFailsOnce: true });
		const dependencies = { commands: fixture.commands, providerToken: TOKEN };
		const plan = await planRepositorySetup(
			root,
			{ mode: 'connect', repository: 'example/app' },
			dependencies,
		);
		await expect(
			applyRepositorySetup(root, plan, dependencies),
		).rejects.toMatchObject({ code: 'REPO_SETUP_PUSH_UNVERIFIED' });
		fixture.setRemoteHead('a'.repeat(40));
		await expect(
			applyRepositorySetup(root, plan, dependencies),
		).rejects.toMatchObject({ code: 'REPO_SETUP_REMOTE_NOT_EMPTY' });
		expect(
			fixture.calls.filter((call) => call.args[0] === 'push'),
		).toHaveLength(1);
	});
});

describe('repository setup through the sandbox API', () => {
	const preview = {
		compose: () => Promise.reject(new Error('no preview in this test')),
		cached: () => null,
		forget: () => undefined,
		dispose: () => undefined,
	} as PreviewRuntime;

	function routeFixture(
		root: string,
		commands: CommandRunner,
		granted = true,
		failUpdateOnce = false,
		mode: 'loopback' | 'self-hosted' = 'loopback',
		beforeUpdate?: () => Promise<void>,
	) {
		let liveGranted = granted;
		let liveWriteAllowed: boolean | undefined = true;
		let configuration: SandboxConfiguration = {
			...DEFAULT_CONFIGURATION,
			mode,
		};
		let updates = 0;
		const authority = {
			writeAllowed: true,
			principal: {
				accountId: 'operator',
				tenantId: 'tenant',
				email: 'operator@example.test',
				displayName: 'Operator',
				role: 'owner',
				scopes: [],
				tenantName: 'Tenant',
				tenantSlug: 'tenant',
			},
			authority: {
				granted: true as const,
				grantId: 'grant',
				capabilities: granted
					? ['sandbox.access.use', 'sandbox.modules.eject']
					: ['sandbox.access.use'],
				expiresAt: null,
			},
		};
		const connection = { connected: true, authority, error: null };
		const liveAuthority = () => ({
			...authority,
			writeAllowed: liveWriteAllowed,
			authority: {
				...authority.authority,
				capabilities: liveGranted
					? ['sandbox.access.use', 'sandbox.modules.eject']
					: ['sandbox.access.use'],
			},
		});
		if (mode === 'self-hosted') {
			vi.stubGlobal('fetch', async () => Response.json(liveAuthority()));
		}
		const runtime = {
			workspaceRoot: root,
			configuration: () => configuration,
			connection: () => connection,
			platform: () => ({ authority: async () => liveAuthority() }),
			browserSession: (id: string | null) =>
				id === 'browser-session'
					? {
							id,
							token: 'flowdular-test-token',
							authority,
							createdAt: Date.now(),
						}
					: null,
			update: async (patch: Partial<SandboxConfiguration>) => {
				if (failUpdateOnce && updates++ === 0)
					throw new Error('sensitive configuration failure');
				await beforeUpdate?.();
				configuration = { ...configuration, ...patch };
				return connection;
			},
		} as unknown as SandboxRuntime;
		const router = createRouter([
			...createSandboxRoutes(runtime, preview, {
				port: 4320,
				repositoryCommands: commands,
			}),
		]);
		const post = async (
			path: string,
			body: unknown,
			includeMutationHeader = true,
		) => {
			const url = new URL(path, 'http://127.0.0.1:4320');
			const headers: Record<string, string> = {
				host: '127.0.0.1:4320',
				origin: 'http://127.0.0.1:4320',
				'content-type': 'application/json',
				...(mode === 'self-hosted'
					? { cookie: 'flowdular_sandbox=browser-session' }
					: {}),
			};
			if (includeMutationHeader) headers['x-flowdular-sandbox'] = '1';
			const request = new Request(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
			});
			const match = router.match('POST', url.pathname);
			if (!match || match.route.type !== 'server')
				throw new Error('Repository route missing');
			return match.route.handler({
				request,
				params: match.params,
				url,
				state: new Map(),
			});
		};
		const get = async (path: string) => {
			const url = new URL(path, 'http://127.0.0.1:4320');
			const request = new Request(url, {
				headers: {
					host: '127.0.0.1:4320',
					...(mode === 'self-hosted'
						? { cookie: 'flowdular_sandbox=browser-session' }
						: {}),
				},
			});
			const match = router.match('GET', url.pathname);
			if (!match || match.route.type !== 'server')
				throw new Error('Repository route missing');
			return match.route.handler({
				request,
				params: match.params,
				url,
				state: new Map(),
			});
		};
		return {
			post,
			get,
			configuration: () => configuration,
			revoke: () => {
				liveGranted = false;
			},
			revokeWrites: () => {
				liveWriteAllowed = false;
			},
			omitWriteAuthority: () => {
				liveWriteAllowed = undefined;
			},
		};
	}

	it('persists the app remote after apply so git-pr delivery is available', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root);
		const routes = routeFixture(root, fixture.commands);
		const planned = await routes.post('/sandbox/api/repository/plan', {
			mode: 'connect',
			repository: 'example/app',
		});
		expect(planned.status).toBe(200);
		const { token } = (await planned.json()) as { token: string };
		const applied = await routes.post('/sandbox/api/repository/apply', {
			token,
		});
		expect(applied.status).toBe(200);
		expect(routes.configuration().github).toMatchObject({
			enabled: true,
			overridesProject: true,
			remote: 'app',
			repository: 'example/app',
			baseBranch: 'main',
			mode: 'direct',
		});
		const delivery = {
			...DEFAULT_DELIVERY_CONFIGURATION,
			git: {
				...DEFAULT_DELIVERY_CONFIGURATION.git,
				remote: routes.configuration().github.remote,
				repository: routes.configuration().github.repository,
				baseBranch: routes.configuration().github.baseBranch,
				mode: routes.configuration().github.mode,
				provider: 'none' as const,
			},
		};
		const context: DeliveryContext = {
			workspaceRoot: root,
			session: {
				id: '12345678-1234-1234-1234-123456789abc',
				moduleSuffix: 'app',
			} as SandboxSession,
			capabilities: ['sandbox.modules.eject'],
			platformUrl: 'http://localhost:4310',
			delivery,
			gitProviderToken: async () => null,
			runGates: async () => [],
			commands: fixture.commands,
		};
		await expect(
			createGitPullRequestDeliveryTarget().available(context),
		).resolves.toMatchObject({ available: true, reason: null });
	});

	it('exposes a failed create for explicit cancellation and a new plan', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root, { createFails: true });
		const routes = routeFixture(root, fixture.commands);
		const initial = await routes.get('/sandbox/api/repository/pending');
		expect(initial.status).toBe(200);
		expect((await initial.json()).pending).toBeNull();
		const planned = await routes.post('/sandbox/api/repository/plan', {
			mode: 'create',
			repository: 'example/app',
		});
		expect(planned.status).toBe(200);
		const { token } = (await planned.json()) as { token: string };
		const failed = await routes.post('/sandbox/api/repository/apply', {
			token,
		});
		expect((await failed.json()).error.code).toBe('REPO_SETUP_CREATE_FAILED');
		const pending = await routes.get('/sandbox/api/repository/pending');
		expect((await pending.json()).pending).toMatchObject({
			mode: 'create',
			repository: 'example/app',
		});
		const wrong = await routes.post('/sandbox/api/repository/cancel', {
			repository: 'example/other',
		});
		expect(wrong.status).toBe(409);
		const cancelled = await routes.post('/sandbox/api/repository/cancel', {
			repository: 'example/app',
		});
		expect(cancelled.status).toBe(200);
		expect((await cancelled.json()).cancelled).toBe(true);
		const stale = await routes.post('/sandbox/api/repository/apply', { token });
		expect(stale.status).toBe(409);
		expect((await stale.json()).error.code).toBe('REPO_SETUP_PLAN_MISSING');
		expect(fixture.createAttempts()).toBe(1);
		expect(
			(await (await routes.get('/sandbox/api/repository/pending')).json())
				.pending,
		).toBeNull();
		const next = await routes.post('/sandbox/api/repository/plan', {
			mode: 'create',
			repository: 'example/other',
		});
		expect(next.status).toBe(200);
		expect(fixture.createAttempts()).toBe(1);
	});

	it('requires both the same-origin mutation header and eject capability before planning', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root);
		const allowed = routeFixture(root, fixture.commands);
		const missingHeader = await allowed.post(
			'/sandbox/api/repository/plan',
			{ mode: 'connect', repository: 'example/app' },
			false,
		);
		expect(missingHeader.status).toBe(403);
		const denied = routeFixture(root, fixture.commands, false);
		const noCapability = await denied.post('/sandbox/api/repository/plan', {
			mode: 'connect',
			repository: 'example/app',
		});
		expect(noCapability.status).toBe(403);
		expect(fixture.calls.some((call) => call.args[0] === 'push')).toBe(false);
	});

	it('checks the current grant again before a planned push', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root);
		const routes = routeFixture(root, fixture.commands);
		const planned = await routes.post('/sandbox/api/repository/plan', {
			mode: 'connect',
			repository: 'example/app',
		});
		expect(planned.status).toBe(200);
		const { token } = (await planned.json()) as { token: string };
		routes.revoke();
		const denied = await routes.post('/sandbox/api/repository/apply', {
			token,
		});
		expect(denied.status).toBe(403);
		expect(fixture.calls.some((call) => call.args[0] === 'push')).toBe(false);
	});

	it('rejects a read-only self-hosted token before planning a repository', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root);
		const routes = routeFixture(
			root,
			fixture.commands,
			true,
			false,
			'self-hosted',
		);
		routes.revokeWrites();
		const denied = await routes.post('/sandbox/api/repository/plan', {
			mode: 'create',
			repository: 'example/app',
		});
		expect(denied.status).toBe(403);
		expect((await denied.json()).error.code).toBe('TOKEN_MUTATION_DENIED');
		expect(fixture.calls.some((call) => call.args[0] === 'create')).toBe(false);
	});

	it('refuses publication when an older platform omits write authority', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root);
		const routes = routeFixture(
			root,
			fixture.commands,
			true,
			false,
			'self-hosted',
		);
		routes.omitWriteAuthority();
		const denied = await routes.post('/sandbox/api/repository/plan', {
			mode: 'connect',
			repository: 'example/app',
		});
		expect(denied.status).toBe(403);
		expect((await denied.json()).error.code).toBe('TOKEN_MUTATION_DENIED');
		expect(fixture.calls.some((call) => call.args[0] === 'push')).toBe(false);
	});

	it('rechecks the token write bit before applying a reviewed plan', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root);
		const routes = routeFixture(
			root,
			fixture.commands,
			true,
			false,
			'self-hosted',
		);
		const planned = await routes.post('/sandbox/api/repository/plan', {
			mode: 'create',
			repository: 'example/app',
		});
		expect(planned.status).toBe(200);
		const { token } = (await planned.json()) as { token: string };
		routes.revokeWrites();
		const denied = await routes.post('/sandbox/api/repository/apply', {
			token,
		});
		expect(denied.status).toBe(403);
		expect((await denied.json()).error.code).toBe('TOKEN_MUTATION_DENIED');
		expect(fixture.createAttempts()).toBe(0);
		expect(fixture.calls.some((call) => call.args[0] === 'push')).toBe(false);
	});

	it('rechecks the token write bit after creating a private repository', async () => {
		const root = await checkout();
		let revokeWrites: () => void = () => undefined;
		const fixture = fixtureRunner(root, { onCreate: () => revokeWrites() });
		const routes = routeFixture(
			root,
			fixture.commands,
			true,
			false,
			'self-hosted',
		);
		revokeWrites = routes.revokeWrites;
		const planned = await routes.post('/sandbox/api/repository/plan', {
			mode: 'create',
			repository: 'example/app',
		});
		expect(planned.status).toBe(200);
		const { token } = (await planned.json()) as { token: string };
		const denied = await routes.post('/sandbox/api/repository/apply', {
			token,
		});
		expect(denied.status).toBe(403);
		expect((await denied.json()).error.code).toBe('TOKEN_MUTATION_DENIED');
		expect(fixture.createCount()).toBe(1);
		expect(fixture.calls.some((call) => call.args[0] === 'push')).toBe(false);
	});

	it('checks the current grant after creating a private repository and before pushing', async () => {
		const root = await checkout();
		let revoke: () => void = () => undefined;
		const fixture = fixtureRunner(root, { onCreate: () => revoke() });
		const routes = routeFixture(root, fixture.commands);
		revoke = routes.revoke;
		const planned = await routes.post('/sandbox/api/repository/plan', {
			mode: 'create',
			repository: 'example/app',
		});
		const { token } = (await planned.json()) as { token: string };
		const denied = await routes.post('/sandbox/api/repository/apply', {
			token,
		});
		expect(denied.status).toBe(403);
		expect(fixture.createCount()).toBe(1);
		expect(fixture.calls.some((call) => call.args[0] === 'push')).toBe(false);
	});

	it('retries saving local delivery settings without pushing the same commit twice', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root);
		const routes = routeFixture(root, fixture.commands, true, true);
		const planned = await routes.post('/sandbox/api/repository/plan', {
			mode: 'connect',
			repository: 'example/app',
		});
		const { token } = (await planned.json()) as { token: string };
		const first = await routes.post('/sandbox/api/repository/apply', { token });
		expect(first.status).toBe(500);
		expect(await readPendingRepositorySetup(root)).toMatchObject({
			repository: 'example/app',
		});
		expect(JSON.stringify(await first.json())).not.toContain(
			'sensitive configuration failure',
		);
		const retry = await routes.post('/sandbox/api/repository/apply', { token });
		expect(retry.status).toBe(200);
		expect(routes.configuration().github).toMatchObject({
			remote: 'app',
			repository: 'example/app',
		});
		expect(
			fixture.calls.filter((call) => call.args[0] === 'push'),
		).toHaveLength(1);
		expect(await readPendingRepositorySetup(root)).toBeNull();
	});

	it('keeps finalization and journal cleanup inside the cross-process lock', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root);
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const reached = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const firstRoutes = routeFixture(
			root,
			fixture.commands,
			true,
			false,
			'loopback',
			async () => {
				entered();
				await gate;
			},
		);
		const planned = await firstRoutes.post('/sandbox/api/repository/plan', {
			mode: 'connect',
			repository: 'example/app',
		});
		const { token, plan } = (await planned.json()) as {
			token: string;
			plan: Awaited<ReturnType<typeof planRepositorySetup>>;
		};
		const first = firstRoutes.post('/sandbox/api/repository/apply', { token });
		await reached;
		try {
			vi.resetModules();
			const other = await import('../src/server/repository-setup.ts');
			await expect(
				other.applyRepositorySetup(root, plan, {
					commands: fixture.commands,
					providerToken: TOKEN,
				}),
			).rejects.toMatchObject({ code: 'REPO_SETUP_BUSY' });
			const secondRoutes = routeFixture(root, fixture.commands);
			const resumed = await secondRoutes.post('/sandbox/api/repository/plan', {
				mode: 'connect',
				repository: 'example/app',
			});
			expect(resumed.status).toBe(200);
			const { token: secondToken } = (await resumed.json()) as {
				token: string;
			};
			const blocked = await secondRoutes.post('/sandbox/api/repository/apply', {
				token: secondToken,
			});
			expect((await blocked.json()).error.code).toBe('REPO_SETUP_BUSY');
			expect(await readPendingRepositorySetup(root)).toMatchObject({
				repository: 'example/app',
			});
		} finally {
			release();
		}
		expect((await first).status).toBe(200);
		expect(await readPendingRepositorySetup(root)).toBeNull();
		expect(
			fixture.calls.filter((call) => call.args[0] === 'push'),
		).toHaveLength(1);
	});

	it('does not finish a saved outcome after the remote HEAD changes', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root);
		const routes = routeFixture(root, fixture.commands, true, true);
		const planned = await routes.post('/sandbox/api/repository/plan', {
			mode: 'connect',
			repository: 'example/app',
		});
		const { token } = (await planned.json()) as { token: string };
		const first = await routes.post('/sandbox/api/repository/apply', { token });
		expect(first.status).toBe(500);
		fixture.setRemoteHead('b'.repeat(40));
		const retry = await routes.post('/sandbox/api/repository/apply', { token });
		expect(retry.status).toBe(409);
		expect(routes.configuration().github.repository).not.toBe('example/app');
		expect(
			fixture.calls.filter((call) => call.args[0] === 'push'),
		).toHaveLength(1);
	});

	it('recovers a created repository after an uncertain push and sandbox restart', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root, { verificationFailsOnce: true });
		const firstRoutes = routeFixture(root, fixture.commands);
		const planned = await firstRoutes.post('/sandbox/api/repository/plan', {
			mode: 'create',
			repository: 'example/app',
		});
		expect(planned.status).toBe(200);
		const { token, plan } = (await planned.json()) as {
			token: string;
			plan: { fingerprint: string };
		};
		const first = await firstRoutes.post('/sandbox/api/repository/apply', {
			token,
		});
		expect(first.status).toBe(503);
		expect((await first.json()).error.code).toBe('REPO_SETUP_PUSH_UNVERIFIED');
		expect(fixture.createCount()).toBe(1);
		const restarted = routeFixture(root, fixture.commands);
		const resumed = await restarted.post('/sandbox/api/repository/plan', {
			mode: 'create',
			repository: 'example/app',
		});
		expect(resumed.status).toBe(200);
		const receipt = (await resumed.json()) as {
			token: string;
			plan: { fingerprint: string; resuming: boolean };
		};
		expect(receipt.plan.fingerprint).toBe(plan.fingerprint);
		expect(receipt.plan.resuming).toBe(true);
		const applied = await restarted.post('/sandbox/api/repository/apply', {
			token: receipt.token,
		});
		expect(applied.status).toBe(200);
		expect(restarted.configuration().github).toMatchObject({
			repository: 'example/app',
			remote: 'app',
		});
		expect(fixture.createCount()).toBe(1);
		expect(
			fixture.calls.filter((call) => call.args[0] === 'push'),
		).toHaveLength(1);
	});

	it('retains the same apply receipt after verification fails', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root, { verificationFailsOnce: true });
		const routes = routeFixture(root, fixture.commands);
		const planned = await routes.post('/sandbox/api/repository/plan', {
			mode: 'connect',
			repository: 'example/app',
		});
		const { token } = (await planned.json()) as { token: string };
		const first = await routes.post('/sandbox/api/repository/apply', { token });
		expect((await first.json()).error.code).toBe('REPO_SETUP_PUSH_UNVERIFIED');
		const retry = await routes.post('/sandbox/api/repository/apply', { token });
		expect(retry.status).toBe(200);
		expect(
			fixture.calls.filter((call) => call.args[0] === 'push'),
		).toHaveLength(1);
	});

	it('apply rejects an unknown receipt without pushing', async () => {
		const root = await checkout();
		const fixture = fixtureRunner(root);
		const routes = routeFixture(root, fixture.commands);
		const result = await routes.post('/sandbox/api/repository/apply', {
			token: 'forged',
		});
		expect(result.status).toBe(409);
		expect(fixture.calls.some((call) => call.args[0] === 'push')).toBe(false);
	});
});
