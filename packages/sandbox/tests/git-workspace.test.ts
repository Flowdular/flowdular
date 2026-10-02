import { execFile } from 'node:child_process';
import {
	mkdtemp,
	mkdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	cloneGitWorkspace,
	spawnGitWorkspaceCommand,
	type GitWorkspaceCommandRunner,
} from '../src/server/git-workspace.ts';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), 'flowdular-git-workspace-'));
	temporaryDirectories.push(path);
	return path;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await execFileAsync('git', args, { cwd });
	return result.stdout.trim();
}

async function repository(
	root: string,
	manifest: string | null = JSON.stringify({
		schemaVersion: 1,
		modules: { roots: ['modules'], enabled: [] },
	}),
	lockfile = true,
): Promise<string> {
	const source = join(root, 'source');
	await mkdir(source);
	await git(source, 'init', '-b', 'main');
	await git(source, 'config', 'user.name', 'Sandbox Test');
	await git(source, 'config', 'user.email', 'sandbox@example.test');
	await writeFile(join(source, 'package.json'), '{"name":"test-platform"}');
	if (manifest !== null)
		await writeFile(join(source, 'flowdular.json'), manifest);
	if (lockfile)
		await writeFile(join(source, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
	await git(source, 'add', '.');
	await git(source, 'commit', '-m', 'platform fixture');
	return source;
}

function recordingRunner(): {
	run: GitWorkspaceCommandRunner;
	calls: Array<{ command: string; args: readonly string[]; cwd: string }>;
} {
	const calls: Array<{
		command: string;
		args: readonly string[];
		cwd: string;
	}> = [];
	return {
		calls,
		run: async (command, args, cwd) => {
			calls.push({ command, args, cwd });
			if (command === 'pnpm') return { code: 0 };
			try {
				await execFileAsync(command, [...args], { cwd });
				return { code: 0 };
			} catch {
				return { code: 1 };
			}
		},
	};
}

describe('connecting a Git workspace', () => {
	it('clones a selected branch from a local Git repository and installs from its lockfile', async () => {
		const base = await temporaryDirectory();
		const source = await repository(base);
		await git(source, 'checkout', '-b', 'finance');
		await writeFile(join(source, 'finance.txt'), 'selected branch\n');
		await git(source, 'add', '.');
		await git(source, 'commit', '-m', 'finance branch');
		const target = join(base, 'connected');
		const runner = recordingRunner();

		const result = await cloneGitWorkspace(
			{ repository: source, target, branch: 'finance' },
			{ run: runner.run },
		);

		expect(result.root).toBe(target);
		expect(result.steps).toContain('verified flowdular.json');
		expect(await readFile(join(target, 'finance.txt'), 'utf8')).toBe(
			'selected branch\n',
		);
		expect(await git(target, 'branch', '--show-current')).toBe('finance');
		expect(runner.calls).toEqual([
			{
				command: 'git',
				args: [
					'clone',
					'--branch',
					'finance',
					'--single-branch',
					'--',
					source,
					target,
				],
				cwd: base,
			},
			{
				command: 'pnpm',
				args: ['install', '--frozen-lockfile'],
				cwd: target,
			},
		]);
	});

	it('accepts a local repository path containing an at sign', async () => {
		const base = await temporaryDirectory();
		const source = await repository(base);
		const renamed = join(base, 'source@team');
		await rename(source, renamed);
		const target = join(base, 'connected');
		const runner = recordingRunner();
		await expect(
			cloneGitWorkspace({ repository: renamed, target }, { run: runner.run }),
		).resolves.toMatchObject({ root: target });
	});

	it.each([
		'https://github.com/example/platform.git',
		'https://git.example.test/group/platform.git',
		'git@git.example.test:group/platform.git',
		'ssh://git@git.example.test/group/platform.git',
	])('accepts a Git remote with no embedded credential: %s', async (remote) => {
		const base = await temporaryDirectory();
		const target = join(base, 'connected');
		const run = vi.fn<GitWorkspaceCommandRunner>(async (command, args) => {
			if (command === 'git') {
				expect(args).toEqual(['clone', '--', remote, target]);
				await mkdir(target);
				await writeFile(
					join(target, 'flowdular.json'),
					JSON.stringify({ schemaVersion: 1, modules: {} }),
				);
				await writeFile(join(target, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
			}
			return { code: 0 };
		});
		await expect(
			cloneGitWorkspace({ repository: remote, target }, { run }),
		).resolves.toMatchObject({ root: target });
		expect(run).toHaveBeenCalledTimes(2);
	});

	it.each([
		'https://user:secret@git.example.test/group/platform.git',
		'https://secret@git.example.test/group/platform.git',
		'https://git.example.test/group/platform.git?token=secret',
		'git://git.example.test/group/platform.git',
		'git@-oProxyCommand=evil:group/platform.git',
		'git@git.example.test:$(evil)',
		'ssh://git@git.example.test/%24%28evil%29',
		'ext::sh -c echo-secret',
		'--upload-pack=evil',
	])('rejects an unsafe remote before running Git: %s', async (remote) => {
		const base = await temporaryDirectory();
		const run = vi.fn<GitWorkspaceCommandRunner>(async () => ({ code: 0 }));
		let error: unknown;
		try {
			await cloneGitWorkspace(
				{ repository: remote, target: join(base, 'connected') },
				{ run },
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toMatchObject({ code: 'GIT_WORKSPACE_REPOSITORY_INVALID' });
		expect((error as Error).message).not.toContain('secret');
		expect(run).not.toHaveBeenCalled();
	});

	it.each([
		{ manifest: null, code: 'GIT_WORKSPACE_MANIFEST_MISSING' },
		{ manifest: '{bad json', code: 'GIT_WORKSPACE_MANIFEST_INVALID' },
		{ manifest: '{}', code: 'GIT_WORKSPACE_MANIFEST_INVALID' },
	])(
		'checks the cloned manifest before installing: $code',
		async ({ manifest, code }) => {
			const base = await temporaryDirectory();
			const source = await repository(base, manifest);
			const runner = recordingRunner();
			await expect(
				cloneGitWorkspace(
					{ repository: source, target: join(base, 'connected') },
					{ run: runner.run },
				),
			).rejects.toMatchObject({ code });
			expect(runner.calls.map((call) => call.command)).toEqual(['git']);
		},
	);

	it('requires a committed pnpm lockfile before installation', async () => {
		const base = await temporaryDirectory();
		const source = await repository(base, undefined, false);
		const runner = recordingRunner();
		await expect(
			cloneGitWorkspace(
				{ repository: source, target: join(base, 'connected') },
				{ run: runner.run },
			),
		).rejects.toMatchObject({ code: 'GIT_WORKSPACE_LOCKFILE_MISSING' });
		expect(runner.calls.map((call) => call.command)).toEqual(['git']);
	});

	it('refuses a lockfile symlink before installation', async () => {
		const base = await temporaryDirectory();
		const source = await repository(base, undefined, false);
		await symlink('package.json', join(source, 'pnpm-lock.yaml'));
		await git(source, 'add', '.');
		await git(source, 'commit', '-m', 'symlink lockfile');
		const runner = recordingRunner();
		await expect(
			cloneGitWorkspace(
				{ repository: source, target: join(base, 'connected') },
				{ run: runner.run },
			),
		).rejects.toMatchObject({ code: 'GIT_WORKSPACE_LOCKFILE_INVALID' });
		expect(runner.calls.map((call) => call.command)).toEqual(['git']);
	});

	it('refuses occupied, symlinked, and nested destinations before running Git', async () => {
		const base = await temporaryDirectory();
		const source = await repository(base);
		const occupied = join(base, 'occupied');
		await mkdir(occupied);
		await writeFile(join(occupied, 'notes.txt'), 'keep');
		const linked = join(base, 'linked');
		await symlink(occupied, linked);
		const linkedSource = join(base, 'linked-source');
		await symlink(source, linkedSource);
		const run = vi.fn<GitWorkspaceCommandRunner>(async () => ({ code: 0 }));
		await expect(
			cloneGitWorkspace({ repository: source, target: occupied }, { run }),
		).rejects.toMatchObject({ code: 'GIT_WORKSPACE_TARGET_OCCUPIED' });
		await expect(
			cloneGitWorkspace({ repository: source, target: linked }, { run }),
		).rejects.toMatchObject({ code: 'GIT_WORKSPACE_TARGET_UNSAFE' });
		await expect(
			cloneGitWorkspace(
				{ repository: source, target: join(source, 'nested') },
				{ run },
			),
		).rejects.toMatchObject({ code: 'GIT_WORKSPACE_TARGET_UNSAFE' });
		await expect(
			cloneGitWorkspace(
				{ repository: source, target: join(linkedSource, 'nested') },
				{ run },
			),
		).rejects.toMatchObject({ code: 'GIT_WORKSPACE_TARGET_UNSAFE' });
		expect(run).not.toHaveBeenCalled();
	});

	it('does not pass Git or package manager output into errors', async () => {
		const base = await temporaryDirectory();
		const source = await repository(base);
		const run = vi.fn<GitWorkspaceCommandRunner>(async () => {
			throw new Error('secret-token-from-tool');
		});
		let error: unknown;
		try {
			await cloneGitWorkspace(
				{ repository: source, target: join(base, 'connected') },
				{ run },
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toMatchObject({ code: 'GIT_WORKSPACE_CLONE_FAILED' });
		expect((error as Error).message).not.toContain('secret-token-from-tool');
	});

	it('reports a clone timeout without exposing command output', async () => {
		const base = await temporaryDirectory();
		const run = vi.fn<GitWorkspaceCommandRunner>(async () => ({
			code: null,
			timedOut: true,
		}));
		await expect(
			cloneGitWorkspace(
				{
					repository: 'https://git.example.test/team/platform.git',
					target: join(base, 'connected'),
				},
				{ run },
			),
		).rejects.toMatchObject({ code: 'GIT_WORKSPACE_CLONE_TIMEOUT' });
	});

	it('reports an install timeout after a successful clone', async () => {
		const base = await temporaryDirectory();
		const source = await repository(base);
		const target = join(base, 'connected');
		const run: GitWorkspaceCommandRunner = async (command, args, cwd) => {
			if (command === 'pnpm') return { code: null, timedOut: true };
			await execFileAsync(command, [...args], { cwd });
			return { code: 0 };
		};
		await expect(
			cloneGitWorkspace({ repository: source, target }, { run }),
		).rejects.toMatchObject({ code: 'GIT_WORKSPACE_INSTALL_TIMEOUT' });
	});

	it('stops a hung Git workspace command after its timeout', async () => {
		const base = await temporaryDirectory();
		const pidFile = join(base, 'process.pid');
		const command = [
			"require('fs').writeFileSync('process.pid', String(process.pid))",
			"process.on('SIGTERM', () => {})",
			'setInterval(() => {}, 1000)',
		].join(';');
		const started = Date.now();
		const result = await spawnGitWorkspaceCommand(
			process.execPath,
			['-e', command],
			base,
			{ timeoutMs: 400 },
		);
		expect(result).toEqual({ code: null, timedOut: true });
		expect(Date.now() - started).toBeLessThan(4_000);
		const pid = Number(await readFile(pidFile, 'utf8'));
		expect(() => process.kill(pid, 0)).toThrow();
	});
});
