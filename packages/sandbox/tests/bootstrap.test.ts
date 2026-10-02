import {
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rm,
	writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	BootstrapError,
	assertBootstrapPrerequisites,
	assertRefIsPinned,
	assertTargetIsSafe,
	bootstrapApplication,
	directoryEntries,
	prepareWorkspace,
	spawnBootstrapCommand,
	workspaceTarget,
} from '../src/server/bootstrap.ts';

const execFileAsync = promisify(execFile);

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function empty(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), 'flowdular-bootstrap-'));
	directories.push(path);
	return path;
}

/* The first run of a business user is `npx @flowdular/sandbox` in an empty
   directory. Everything here exists so that produces a working workspace
   without a checkout, a lockfile decision or a git remote. */
describe('workspace bootstrap', () => {
	it('refuses a moving ref and accepts a tag or a commit', () => {
		expect(() => assertRefIsPinned('v0.4.3')).not.toThrow();
		expect(() => assertRefIsPinned('main')).toThrow(BootstrapError);
		expect(() => assertRefIsPinned('release/next')).toThrow(BootstrapError);
		expect(() => assertRefIsPinned('a'.repeat(40))).not.toThrow();
	});

	it('names the missing tools instead of failing half way through', async () => {
		await expect(
			assertBootstrapPrerequisites(async () => true),
		).resolves.toBeUndefined();
		await expect(
			assertBootstrapPrerequisites(async (command) => command === 'git'),
		).rejects.toMatchObject({ code: 'BOOTSTRAP_PREREQUISITE_MISSING' });
		await expect(
			assertBootstrapPrerequisites(async () => false),
		).rejects.toThrow(/git and pnpm/);
	});

	it('refuses a directory that already holds something', async () => {
		const target = await empty();
		await mkdir(join(target, 'my-notes'), { recursive: true });
		await expect(
			assertTargetIsSafe(target, async () => true, directoryEntries),
		).rejects.toMatchObject({ code: 'BOOTSTRAP_TARGET_NOT_EMPTY' });
	});

	it('accepts a missing or empty directory and refuses pre-existing state', async () => {
		const target = await empty();
		const exists = async () => false;
		await expect(
			assertTargetIsSafe(target, exists, directoryEntries),
		).resolves.toBeUndefined();

		await expect(
			assertTargetIsSafe(target, async () => true, directoryEntries),
		).resolves.toBeUndefined();

		for (const name of ['.git', '.flowdular', 'node_modules']) {
			await writeFile(join(target, name), '');
		}
		await expect(
			assertTargetIsSafe(target, async () => true, directoryEntries),
		).rejects.toMatchObject({ code: 'BOOTSTRAP_TARGET_NOT_EMPTY' });
	});

	it('names the offending entries so the operator can move them', async () => {
		const target = await empty();
		await writeFile(join(target, 'notes.txt'), 'hello');
		await writeFile(join(target, 'budget.csv'), 'x');
		await expect(
			assertTargetIsSafe(target, async () => true, directoryEntries),
		).rejects.toThrow(/budget\.csv, notes\.txt/);
	});

	it('resolves the target relative to where the command was run', () => {
		expect(workspaceTarget(undefined, 'flowdular')).toMatch(/\/flowdular$/);
		expect(workspaceTarget('my-company', 'flowdular')).toMatch(
			/[/\\]my-company$/,
		);
	});
});

describe('repository default', () => {
	it('points at the OSS repository', async () => {
		const { DEFAULT_REPOSITORY } = await import('../src/server/bootstrap.ts');
		expect(DEFAULT_REPOSITORY).toBe(
			'https://github.com/Flowdular/flowdular.git',
		);
	});
});

describe('empty directories', () => {
	it('reports no entries for a path that does not exist', async () => {
		expect(await readdir('/definitely/not/here').catch(() => [])).toEqual([]);
	});
});

describe('launcher workspace selection', () => {
	const setup = (cwd: string, workspaceArgument?: string) => {
		const create = vi.fn(async ({ target }: { target: string }) => ({
			root: target,
			steps: ['created standalone app'],
		}));
		const clone = vi.fn(async ({ target }: { target: string }) => ({
			root: target,
			steps: ['created a workspace'],
		}));
		const probe = vi.fn(async () => true);
		return {
			options: {
				cwd,
				...(workspaceArgument === undefined ? {} : { workspaceArgument }),
				bootstrap: 'auto' as const,
				ref: 'v0.5.0',
				repository: 'https://example.invalid/flowdular.git',
			},
			dependencies: { create, clone, probe },
		};
	};

	it('bootstraps ./flowdular from an existing empty cwd', async () => {
		const cwd = await empty();
		const { options, dependencies } = setup(cwd);
		const result = await prepareWorkspace(options, dependencies);
		expect(result).toMatchObject({
			root: join(cwd, 'flowdular'),
			created: true,
		});
		expect(dependencies.create).toHaveBeenCalledWith(
			expect.objectContaining({
				target: join(cwd, 'flowdular'),
				version: '0.5.0',
			}),
		);
		expect(dependencies.clone).not.toHaveBeenCalled();
		expect(dependencies.probe).toHaveBeenCalledTimes(2);
	});

	it('reuses ./flowdular on a later run from the same cwd', async () => {
		const cwd = await empty();
		const root = join(cwd, 'flowdular');
		await mkdir(root);
		await writeFile(join(root, 'flowdular.json'), '{}');
		const { options, dependencies } = setup(cwd);
		await expect(
			prepareWorkspace(options, dependencies),
		).resolves.toMatchObject({
			root,
			created: false,
		});
		expect(dependencies.clone).not.toHaveBeenCalled();
		expect(dependencies.create).not.toHaveBeenCalled();
		expect(dependencies.probe).not.toHaveBeenCalled();
	});

	it('uses the nearest existing Flowdular workspace', async () => {
		const root = await empty();
		await writeFile(join(root, 'flowdular.json'), '{}');
		const cwd = join(root, 'packages', 'sandbox');
		await mkdir(cwd, { recursive: true });
		const { options, dependencies } = setup(cwd);
		await expect(
			prepareWorkspace(options, dependencies),
		).resolves.toMatchObject({
			root,
			created: false,
		});
		expect(dependencies.clone).not.toHaveBeenCalled();
		expect(dependencies.create).not.toHaveBeenCalled();
	});

	it('uses an explicit existing root and creates an explicit new target', async () => {
		const cwd = await empty();
		const root = await empty();
		await writeFile(join(root, 'flowdular.json'), '{}');
		const existing = setup(cwd, root);
		await expect(
			prepareWorkspace(existing.options, existing.dependencies),
		).resolves.toMatchObject({ root, created: false });
		expect(existing.dependencies.clone).not.toHaveBeenCalled();
		expect(existing.dependencies.create).not.toHaveBeenCalled();

		const target = join(cwd, 'customer-platform');
		const fresh = setup(cwd, target);
		await expect(
			prepareWorkspace(fresh.options, fresh.dependencies),
		).resolves.toMatchObject({ root: target, created: true });
		expect(fresh.dependencies.create).toHaveBeenCalledWith(
			expect.objectContaining({ target }),
		);
	});

	it('fails clearly when bootstrap is disabled or an explicit root already exists', async () => {
		const cwd = await empty();
		const missing = setup(cwd);
		await expect(
			prepareWorkspace(
				{ ...missing.options, bootstrap: 'never' },
				missing.dependencies,
			),
		).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
		expect(missing.dependencies.clone).not.toHaveBeenCalled();
		expect(missing.dependencies.create).not.toHaveBeenCalled();

		await writeFile(join(cwd, 'flowdular.json'), '{}');
		const existing = setup(cwd, cwd);
		await expect(
			prepareWorkspace(
				{ ...existing.options, bootstrap: 'always' },
				existing.dependencies,
			),
		).rejects.toMatchObject({ code: 'BOOTSTRAP_TARGET_IS_WORKSPACE' });
		expect(existing.dependencies.clone).not.toHaveBeenCalled();
		expect(existing.dependencies.create).not.toHaveBeenCalled();
	});

	it('keeps explicit pinned repository cloning available', async () => {
		const cwd = await empty();
		const { options, dependencies } = setup(cwd);
		const result = await prepareWorkspace(
			{ ...options, cloneRepository: true },
			dependencies,
		);
		expect(result.created).toBe(true);
		expect(dependencies.clone).toHaveBeenCalledWith(
			expect.objectContaining({ ref: 'v0.5.0' }),
		);
		expect(dependencies.create).not.toHaveBeenCalled();
	});
});

describe('standalone application bootstrap', () => {
	it('terminates a generator process that ignores shutdown', async () => {
		const cwd = await empty();
		const child = [
			"require('fs').writeFileSync('process.pid', String(process.pid))",
			"process.on('SIGTERM', () => {})",
			'setInterval(() => {}, 1000)',
		].join(';');
		const started = Date.now();
		const result = await spawnBootstrapCommand(
			process.execPath,
			['-e', child],
			cwd,
			process.env,
			400,
		);
		expect(result).toMatchObject({ code: null, timedOut: true });
		expect(Date.now() - started).toBeLessThan(4_000);
		const pid = Number(await readFile(join(cwd, 'process.pid'), 'utf8'));
		expect(() => process.kill(pid, 0)).toThrow();
	});

	it('scaffolds, installs and commits with a transparent starter identity', async () => {
		const cwd = await empty();
		const target = join(cwd, 'flowdular');
		const calls: {
			command: string;
			args: readonly string[];
			cwd: string;
			env?: NodeJS.ProcessEnv;
		}[] = [];
		const execute = vi.fn(
			async (
				command: string,
				args: readonly string[],
				commandCwd: string,
				env?: NodeJS.ProcessEnv,
			) => {
				calls.push({ command, args, cwd: commandCwd, ...(env ? { env } : {}) });
				if (command === process.execPath) {
					await mkdir(target);
					await writeFile(
						join(target, 'flowdular.json'),
						JSON.stringify({
							schemaVersion: 1,
							modules: { roots: ['modules'] },
						}),
					);
				}
				return { code: 0, output: '' };
			},
		);
		const result = await bootstrapApplication(
			{ target, version: '0.5.0' },
			{ generator: async () => '/generator/dist/bin.js', execute },
		);
		expect(result.root).toBe(target);
		expect(result.steps).toContain('verified flowdular.json');
		expect(calls.map(({ command }) => command)).toEqual([
			process.execPath,
			'pnpm',
			'git',
			'git',
			'git',
		]);
		expect(calls[0]).toMatchObject({
			args: ['/generator/dist/bin.js', 'flowdular', '--no-install', '--no-git'],
			cwd,
		});
		expect(calls[1]).toMatchObject({ args: ['install'], cwd: target });
		expect(calls[4]?.env).toMatchObject({
			GIT_AUTHOR_NAME: 'Flowdular Starter',
			GIT_AUTHOR_EMAIL: 'starter@flowdular.local',
			GIT_COMMITTER_NAME: 'Flowdular Starter',
			GIT_COMMITTER_EMAIL: 'starter@flowdular.local',
		});
	});

	it('refuses an invalid generator result before install', async () => {
		const cwd = await empty();
		const target = join(cwd, 'flowdular');
		const execute = vi.fn(async () => ({ code: 0, output: '' }));
		await expect(
			bootstrapApplication(
				{ target, version: '0.5.0' },
				{ generator: async () => '/generator/dist/bin.js', execute },
			),
		).rejects.toMatchObject({ code: 'BOOTSTRAP_INCOMPLETE' });
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it('does not make a Git commit when dependency installation fails', async () => {
		const cwd = await empty();
		const target = join(cwd, 'flowdular');
		const execute = vi.fn(async (command: string) => {
			if (command === process.execPath) {
				await mkdir(target);
				await writeFile(
					join(target, 'flowdular.json'),
					JSON.stringify({ schemaVersion: 1, modules: {} }),
				);
			}
			return { code: command === 'pnpm' ? 1 : 0, output: '' };
		});
		await expect(
			bootstrapApplication(
				{ target, version: '0.5.0' },
				{ generator: async () => '/generator/dist/bin.js', execute },
			),
		).rejects.toMatchObject({ code: 'BOOTSTRAP_INSTALL_FAILED' });
		expect(execute).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ step: 'generator', failedCall: 1, code: 'BOOTSTRAP_GENERATOR_TIMEOUT' },
		{ step: 'pnpm install', failedCall: 2, code: 'BOOTSTRAP_INSTALL_TIMEOUT' },
		{ step: 'git init', failedCall: 3, code: 'BOOTSTRAP_GIT_TIMEOUT' },
		{ step: 'git add', failedCall: 4, code: 'BOOTSTRAP_GIT_TIMEOUT' },
		{ step: 'git commit', failedCall: 5, code: 'BOOTSTRAP_GIT_TIMEOUT' },
	])(
		'stops at a timed-out $step with a clear error',
		async ({ failedCall, code }) => {
			const cwd = await empty();
			const target = join(cwd, 'flowdular');
			let count = 0;
			const execute = vi.fn(async (command: string) => {
				count++;
				if (command === process.execPath) {
					await mkdir(target);
					await writeFile(
						join(target, 'flowdular.json'),
						JSON.stringify({ schemaVersion: 1, modules: {} }),
					);
				}
				return count === failedCall
					? { code: null, output: 'secret-from-command', timedOut: true }
					: { code: 0, output: '' };
			});
			let error: unknown;
			try {
				await bootstrapApplication(
					{ target, version: '0.5.0' },
					{ generator: async () => '/generator/dist/bin.js', execute },
				);
			} catch (caught) {
				error = caught;
			}
			expect(error).toMatchObject({ code });
			expect((error as Error).message).toContain('did not finish');
			expect((error as Error).message).not.toContain('secret-from-command');
			expect(execute).toHaveBeenCalledTimes(failedCall);
		},
	);
});

describe('source launcher', () => {
	it('prints help on supported Node without NODE_OPTIONS', async () => {
		const launcher = resolve(
			import.meta.dirname,
			'../bin/flowdular-sandbox.mjs',
		);
		const { stdout } = await execFileAsync(
			process.execPath,
			[launcher, '--help'],
			{
				env: { ...process.env, NODE_OPTIONS: '' },
			},
		);
		expect(stdout).toContain('Flowdular sandbox');
		expect(stdout).toContain('Usage: npx @flowdular/sandbox');
	});

	it('reports an empty external directory when bootstrap is disabled', async () => {
		const cwd = await empty();
		const launcher = resolve(
			import.meta.dirname,
			'../bin/flowdular-sandbox.mjs',
		);
		await expect(
			execFileAsync(process.execPath, [launcher, '--no-bootstrap'], {
				cwd,
				env: { ...process.env, NODE_OPTIONS: '' },
			}),
		).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining('No Flowdular workspace was found'),
		});
	});
});
