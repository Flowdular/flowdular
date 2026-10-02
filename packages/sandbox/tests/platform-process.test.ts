import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import {
	findRunningPlatformUrl,
	PlatformStartAbortedError,
	startPlatformProcess,
} from '../src/server/platform-process.ts';

const temporaryDirectories: string[] = [];
afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function waitUntil(
	check: () => Promise<boolean>,
	attempts = 100,
): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (await check()) return;
		await delay(50);
	}
	throw new Error('Timed out waiting for the platform process');
}

async function freePort(): Promise<number> {
	const socket = createServer();
	await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
	const address = socket.address();
	if (!address || typeof address === 'string') throw new Error('No TCP port');
	await new Promise<void>((resolve) => socket.close(() => resolve()));
	return address.port;
}

async function processGone(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ESRCH';
	}
}

it('recognizes a platform already bound to the IPv6 loopback address', async () => {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '::1', resolve);
	});
	try {
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('No TCP port');
		expect(await findRunningPlatformUrl(address.port)).toBe(
			`http://[::1]:${address.port}`,
		);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

it('stops a platform child when startup is cancelled', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-platform-start-'));
	temporaryDirectories.push(root);
	const childPidFile = join(root, 'child.pid');
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({ private: true, scripts: { dev: 'node child.mjs' } }),
	);
	await writeFile(
		join(root, 'child.mjs'),
		`import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(childPidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
	);
	const controller = new AbortController();
	const startup = startPlatformProcess({
		workspaceRoot: root,
		port: await freePort(),
		quiet: true,
		signal: controller.signal,
	});
	void startup.catch(() => undefined);
	try {
		await waitUntil(async () => {
			try {
				await readFile(childPidFile);
				return true;
			} catch {
				return false;
			}
		});
		const childPid = Number(await readFile(childPidFile, 'utf8'));
		controller.abort();
		await expect(startup).rejects.toBeInstanceOf(PlatformStartAbortedError);
		await waitUntil(() => processGone(childPid));
	} finally {
		controller.abort();
		await startup.catch(() => undefined);
	}
}, 20_000);

it('waits for a starting platform child to stop before the launcher exits', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-launcher-stop-'));
	temporaryDirectories.push(root);
	const childPidFile = join(root, 'child.pid');
	await writeFile(
		join(root, 'flowdular.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
	);
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({ private: true, scripts: { dev: 'node child.mjs' } }),
	);
	await writeFile(
		join(root, 'child.mjs'),
		`import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(childPidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
	);
	const entry = resolve(
		fileURLToPath(new URL('../bin/flowdular-sandbox.mjs', import.meta.url)),
	);
	const launcher = spawn(
		process.execPath,
		[
			entry,
			'--workspace',
			root,
			'--port',
			String(await freePort()),
			'--platform-port',
			String(await freePort()),
		],
		{ cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
	);
	let output = '';
	for (const stream of [launcher.stdout, launcher.stderr])
		stream.on('data', (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-8000);
		});
	let childPid: number | null = null;
	try {
		await waitUntil(async () => {
			try {
				childPid = Number(await readFile(childPidFile, 'utf8'));
				return true;
			} catch {
				if (launcher.exitCode !== null) throw new Error(output);
				return false;
			}
		}, 300).catch((error) => {
			throw new Error(
				`${error instanceof Error ? error.message : error}\n${output}`,
			);
		});
		launcher.kill('SIGTERM');
		await Promise.race([
			once(launcher, 'exit'),
			delay(8_000).then(() => {
				throw new Error(`Launcher did not exit: ${output}`);
			}),
		]);
		expect(childPid).not.toBeNull();
		await waitUntil(() => processGone(childPid!)).catch((error) => {
			let state = '';
			try {
				state = execFileSync(
					'ps',
					['-o', 'pid,ppid,pgid,stat,command', '-p', String(childPid)],
					{ encoding: 'utf8' },
				);
			} catch {
				/* A process can disappear between the checks. */
			}
			throw new Error(
				`${error instanceof Error ? error.message : error}\n${state}\n${output}`,
			);
		});
	} finally {
		if (launcher.exitCode === null) launcher.kill('SIGKILL');
		if (childPid !== null && !(await processGone(childPid))) {
			try {
				process.kill(childPid, 'SIGKILL');
			} catch {
				/* The child may have exited after the last check. */
			}
		}
	}
}, 30_000);
