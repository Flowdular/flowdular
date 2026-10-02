import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnCommand } from '../src/server/delivery/steps.ts';
import { runBoundedProcess } from '../src/server/process-command.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe('delivery subprocess limits', () => {
	it('stops a hung command and reports the timeout', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'flowdular-process-command-'));
		temporaryDirectories.push(cwd);
		const child = [
			"require('fs').writeFileSync('process.pid', String(process.pid))",
			"process.on('SIGTERM', () => {})",
			'setInterval(() => {}, 1000)',
		].join(';');
		const started = Date.now();
		const result = await spawnCommand(process.execPath, ['-e', child], cwd, {
			timeoutMs: 400,
		});
		expect(result.code).toBeNull();
		expect(result.output).toContain('Command timed out');
		expect(Date.now() - started).toBeLessThan(4_000);
		const pid = Number(await readFile(join(cwd, 'process.pid'), 'utf8'));
		expect(() => process.kill(pid, 0)).toThrow();
	});

	it.skipIf(process.platform === 'win32')(
		'waits for a stubborn grandchild after its parent exits on timeout',
		async () => {
			const cwd = await mkdtemp(join(tmpdir(), 'flowdular-process-group-'));
			temporaryDirectories.push(cwd);
			const grandchild = [
				"const fs = require('fs')",
				"process.on('SIGTERM', () => {})",
				"setInterval(() => fs.appendFileSync('heartbeat', 'x'), 20)",
			].join(';');
			const parent = [
				"const fs = require('fs')",
				"const { spawn } = require('child_process')",
				`spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' })`,
				"fs.writeFileSync('group.pid', String(process.pid))",
				'setInterval(() => {}, 1000)',
			].join(';');
			let groupPid: number | undefined;
			try {
				const result = await runBoundedProcess(
					process.execPath,
					['-e', parent],
					{
						cwd,
						env: process.env,
						timeoutMs: 1_500,
						outputLimit: 0,
					},
				);
				expect(result).toMatchObject({ code: null, timedOut: true });
				groupPid = Number(await readFile(join(cwd, 'group.pid'), 'utf8'));
				const heartbeat = join(cwd, 'heartbeat');
				const before = await readFile(heartbeat, 'utf8');
				expect(before.length).toBeGreaterThan(0);
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
				expect(await readFile(heartbeat, 'utf8')).toBe(before);
			} finally {
				groupPid ??= Number(
					await readFile(join(cwd, 'group.pid'), 'utf8').catch(() => '0'),
				);
				if (groupPid > 0) {
					try {
						process.kill(-groupPid, 'SIGKILL');
					} catch {
						/* The process group already exited. */
					}
				}
			}
		},
	);
});
