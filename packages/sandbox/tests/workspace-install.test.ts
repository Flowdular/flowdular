import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	ensureSessionDependencies,
	runPnpm,
} from '../src/server/workspace-install.ts';

describe('session dependency install', () => {
	it('retries online after an offline failure and records a successful install', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-workspace-install-'));
		try {
			const sessionWorkspace = join(root, 'workspace');
			await mkdir(join(sessionWorkspace, 'modules', 'finance'), {
				recursive: true,
			});
			await writeFile(
				join(sessionWorkspace, 'modules', 'finance', 'package.json'),
				JSON.stringify({ name: '@app/finance' }),
			);
			const attempts: string[][] = [];
			const runCommand: typeof runPnpm = async (_cwd, args) => {
				attempts.push([...args]);
				if (attempts.length === 1)
					return { code: 1, output: 'offline package unavailable' };
				await mkdir(join(sessionWorkspace, 'node_modules'));
				return { code: 0, output: 'installed' };
			};
			const options = {
				sessionRoot: root,
				sessionWorkspace,
				modules: [
					{ id: 'finance.core', directory: 'finance', kind: 'new' as const },
				],
				runCommand,
			};
			expect(await ensureSessionDependencies(options)).toMatchObject({
				ran: true,
				ok: true,
				output: 'installed',
			});
			expect(attempts).toEqual([
				['install', '--offline', '--no-frozen-lockfile'],
				['install', '--prefer-offline', '--no-frozen-lockfile'],
			]);
			expect(await readFile(join(root, 'install-signature'), 'utf8')).toMatch(
				/^[a-f0-9]{64}$/,
			);
			expect(await ensureSessionDependencies(options)).toMatchObject({
				ran: false,
				ok: true,
			});
			expect(attempts).toHaveLength(2);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === 'win32')(
		'stops pnpm and its child after the install timeout',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'flowdular-pnpm-timeout-'));
			const bin = join(root, 'bin');
			let parentPid = 0;
			try {
				await mkdir(bin);
				const childScript = [
					"const fs = require('fs')",
					"fs.appendFileSync('heartbeat', 'x')",
					"setInterval(() => fs.appendFileSync('heartbeat', 'x'), 20)",
				].join(';');
				const parentScript = [
					"const fs = require('fs')",
					"const { spawn } = require('child_process')",
					`spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' })`,
					"fs.writeFileSync('parent.pid', String(process.pid))",
					"process.on('SIGTERM', () => {})",
					'setInterval(() => {}, 1000)',
				].join(';');
				const pnpm = join(bin, 'pnpm');
				await writeFile(pnpm, `#!${process.execPath}\n${parentScript}\n`);
				await chmod(pnpm, 0o755);
				// Concurrent Vitest workers can delay Node startup. Give the fixture
				// time to write parent.pid before the timeout tests process cleanup.
				const timeoutMs = 3_000;
				const started = Date.now();
				const result = await runPnpm(root, ['install'], {
					timeoutMs,
					environment: { PATH: `${bin}:${process.env.PATH ?? ''}` },
				});
				expect(result.code).toBeNull();
				expect(result.output).toContain('exceeded its time budget');
				expect(Date.now() - started).toBeLessThan(timeoutMs + 3_000);
				parentPid = Number(await readFile(join(root, 'parent.pid'), 'utf8'));
				const heartbeat = join(root, 'heartbeat');
				const before = await readFile(heartbeat, 'utf8');
				expect(before.length).toBeGreaterThan(0);
				await new Promise((resolve) => setTimeout(resolve, 120));
				expect(await readFile(heartbeat, 'utf8')).toBe(before);
			} finally {
				parentPid ||= Number(
					await readFile(join(root, 'parent.pid'), 'utf8').catch(() => '0'),
				);
				if (parentPid > 0) {
					try {
						process.kill(-parentPid, 'SIGKILL');
					} catch {
						/* The process group has already exited. */
					}
				}
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});
