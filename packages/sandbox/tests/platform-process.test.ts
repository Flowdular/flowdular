import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
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

it('reports an already-running platform to the launcher without stopping it', async () => {
	const server = createHttpServer((request, response) => {
		if (request.url === '/setup') {
			response
				.writeHead(200, {
					'content-type': 'text/html',
					'x-flowdular-setup': 'first-run',
				})
				.end('<h1>Setup</h1>');
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('No TCP port');
		const ready: { url: string; setup: boolean }[] = [];
		const platform = await startPlatformProcess({
			workspaceRoot: '/unused',
			port: address.port,
			onReady: (state) => {
				ready.push(state);
			},
		});
		expect(ready).toEqual([{ url: platform.url, setup: true }]);
		await platform.stop();
		expect((await fetch(`${platform.url}/setup`)).status).toBe(200);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

it('does not mistake the application shell at /setup for first-run setup', async () => {
	const server = createHttpServer((_request, response) => {
		response
			.writeHead(200, { 'content-type': 'text/html' })
			.end('<h1>Application</h1>');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('No TCP port');
		const ready: boolean[] = [];
		await startPlatformProcess({
			workspaceRoot: '/unused',
			port: address.port,
			onReady: (state) => {
				ready.push(state.setup);
			},
		});
		expect(ready).toEqual([false]);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

it('restarts an owned setup process and calls readiness again for the full application', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-platform-setup-'));
	temporaryDirectories.push(root);
	const marker = join(root, 'configured');
	const pidFile = join(root, 'children.txt');
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({ private: true, scripts: { dev: 'node child.mjs' } }),
	);
	await writeFile(
		join(root, 'child.mjs'),
		`import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + '\\n');
const args = process.argv;
const port = Number(args[args.indexOf('--port') + 1]);
const host = args[args.indexOf('--host') + 1];
const setup = !existsSync(${JSON.stringify(marker)});
const server = createServer((request, response) => {
  if (request.url === '/setup' && setup) {
    if (request.method === 'POST') {
      writeFileSync(${JSON.stringify(marker)}, 'configured');
      response.writeHead(204).end();
      setTimeout(() => process.exit(0), 100);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html', 'x-flowdular-setup': 'first-run' }).end('<h1>Setup</h1>');
    return;
  }
  if (request.url === '/api/health') {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    return;
  }
  response.writeHead(404).end();
});
server.listen(port, host);
`,
	);
	const port = await freePort();
	const ready: { url: string; setup: boolean }[] = [];
	const logs: string[] = [];
	const process = await startPlatformProcess({
		workspaceRoot: root,
		port,
		quiet: true,
		onReady: (state) => {
			ready.push(state);
		},
		log: (line) => logs.push(line),
	});
	try {
		expect(ready).toEqual([{ url: process.url, setup: true }]);
		expect((await fetch(`${process.url}/setup`)).status).toBe(200);
		expect(
			(await fetch(`${process.url}/setup`, { method: 'POST' })).status,
		).toBe(204);
		await waitUntil(async () => ready.length === 2, 400);
		expect(ready).toEqual([
			{ url: process.url, setup: true },
			{ url: process.url, setup: false },
		]);
		expect((await fetch(`${process.url}/api/health`)).status).toBe(200);
		expect(logs).toContain('setup finished; restarting the platform');
	} finally {
		await process.stop();
		const pids = (await readFile(pidFile, 'utf8'))
			.trim()
			.split('\n')
			.map(Number);
		for (const pid of pids) await waitUntil(() => processGone(pid));
	}
}, 40_000);

it('collects readiness after an in-process setup to application transition', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-platform-reload-'));
	temporaryDirectories.push(root);
	const marker = join(root, 'configured');
	const pidFile = join(root, 'child.pid');
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({ private: true, scripts: { dev: 'node child.mjs' } }),
	);
	await writeFile(
		join(root, 'child.mjs'),
		`import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const args = process.argv;
const port = Number(args[args.indexOf('--port') + 1]);
const host = args[args.indexOf('--host') + 1];
createServer((request, response) => {
  const setup = !existsSync(${JSON.stringify(marker)});
  if (request.url === '/shutdown') {
    response.writeHead(204).end();
    setTimeout(() => process.exit(0), 100);
    return;
  }
  if (request.url === '/setup' && setup) {
    if (request.method === 'POST') {
      writeFileSync(${JSON.stringify(marker)}, 'configured');
      response.writeHead(204).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html', 'x-flowdular-setup': 'first-run' }).end('<h1>Setup</h1>');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Application</h1>');
}).listen(port, host);
`,
	);
	const ready: boolean[] = [];
	const logs: string[] = [];
	const platform = await startPlatformProcess({
		workspaceRoot: root,
		port: await freePort(),
		quiet: true,
		onReady: (state) => {
			ready.push(state.setup);
		},
		log: (line) => logs.push(line),
	});
	try {
		expect(ready).toEqual([true]);
		expect(
			(await fetch(`${platform.url}/setup`, { method: 'POST' })).status,
		).toBe(204);
		await waitUntil(async () => ready.length === 2, 200);
		expect(ready).toEqual([true, false]);
		expect(logs).toContain('setup activated the full application');
		expect(logs).not.toContain('setup finished; restarting the platform');
		expect(
			(await fetch(`${platform.url}/setup`)).headers.get('x-flowdular-setup'),
		).toBeNull();
		expect((await fetch(`${platform.url}/shutdown`)).status).toBe(204);
		const pid = Number(await readFile(pidFile, 'utf8'));
		await waitUntil(() => processGone(pid));
		await waitUntil(async () => logs.includes('the platform process stopped'));
		expect(logs).not.toContain('setup finished; restarting the platform');
		expect(ready).toEqual([true, false]);
	} finally {
		await platform.stop();
		const pid = Number(await readFile(pidFile, 'utf8'));
		await waitUntil(() => processGone(pid));
	}
}, 30_000);

it('restarts when the wizard exits after an in-process application transition', async () => {
	const root = await mkdtemp(
		join(tmpdir(), 'flowdular-platform-late-restart-'),
	);
	temporaryDirectories.push(root);
	const marker = join(root, 'configured');
	const pidFile = join(root, 'children.txt');
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({ private: true, scripts: { dev: 'node child.mjs' } }),
	);
	await writeFile(
		join(root, 'child.mjs'),
		`import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + '\\n');
const args = process.argv;
const port = Number(args[args.indexOf('--port') + 1]);
const host = args[args.indexOf('--host') + 1];
createServer((request, response) => {
  if (request.url === '/configure' && request.method === 'POST') {
    writeFileSync(${JSON.stringify(marker)}, 'configured');
    response.writeHead(204).end();
    return;
  }
  if (request.url === '/restart' && request.method === 'POST') {
    response.writeHead(204).end();
    setTimeout(() => process.exit(Number(process.env.FD_SETUP_RESTART_EXIT_CODE)), 100);
    return;
  }
  if (request.url === '/setup' && !existsSync(${JSON.stringify(marker)})) {
    response.writeHead(200, { 'content-type': 'text/html', 'x-flowdular-setup': 'first-run' }).end('<h1>Setup</h1>');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Application</h1>');
}).listen(port, host);
`,
	);
	const ready: boolean[] = [];
	const logs: string[] = [];
	const platform = await startPlatformProcess({
		workspaceRoot: root,
		port: await freePort(),
		quiet: true,
		onReady: (state) => {
			ready.push(state.setup);
		},
		log: (line) => logs.push(line),
	});
	try {
		expect(ready).toEqual([true]);
		expect(
			(await fetch(`${platform.url}/configure`, { method: 'POST' })).status,
		).toBe(204);
		await waitUntil(async () => ready.length === 2, 200);
		expect(ready).toEqual([true, false]);
		expect(
			(await fetch(`${platform.url}/restart`, { method: 'POST' })).status,
		).toBe(204);
		await waitUntil(async () => ready.length === 3, 400);
		expect(ready).toEqual([true, false, false]);
		expect(logs).toContain('setup finished; restarting the platform');
		expect((await readFile(pidFile, 'utf8')).trim().split('\n')).toHaveLength(
			2,
		);
	} finally {
		await platform.stop();
		const pids = (await readFile(pidFile, 'utf8'))
			.trim()
			.split('\n')
			.map(Number);
		for (const pid of pids) await waitUntil(() => processGone(pid));
	}
}, 40_000);

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

it('shows the private setup token once in the launcher terminal without putting it in HTTP state', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-launcher-setup-'));
	temporaryDirectories.push(root);
	const token = 't'.repeat(43);
	const platformToken = 'fd_test_platform_credential';
	const pidFile = join(root, 'children.txt');
	const marker = join(root, 'configured');
	const inbox = join(root, '.flowdular', 'sandbox', 'sandbox-credential.json');
	await mkdir(join(root, '.flowdular'), { mode: 0o700 });
	await mkdir(join(root, '.flowdular', 'sandbox'), { mode: 0o700 });
	await writeFile(join(root, '.flowdular', 'setup-token'), `${token}\n`, {
		mode: 0o600,
	});
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
		`import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + '\\n');
const args = process.argv;
const port = Number(args[args.indexOf('--port') + 1]);
const host = args[args.indexOf('--host') + 1];
const setup = !existsSync(${JSON.stringify(marker)});
if (!setup) writeFileSync(${JSON.stringify(inbox)}, JSON.stringify({ platformTenantId: 'tenant-1', email: 'ada@example.test', token: ${JSON.stringify(platformToken)}, capabilities: ['sandbox.access.use'] }), { mode: 0o600 });
createServer((request, response) => {
  if (request.url === '/setup' && setup) {
    if (request.method === 'POST') {
      writeFileSync(${JSON.stringify(marker)}, 'configured');
      response.writeHead(204).end();
      setTimeout(() => process.exit(0), 100);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html', 'x-flowdular-setup': 'first-run' }).end('<h1>Setup</h1>');
    return;
  }
  if (request.url === '/api/sandbox/authority' && !setup) {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      principal: { accountId: 'account-1', tenantId: 'tenant-1', email: 'ada@example.test', displayName: 'Ada Owner', role: 'owner', scopes: ['sandbox.access.use'], tenantName: 'Acme Finance', tenantSlug: 'acme-finance' },
      authority: { granted: true, grantId: 'grant-1', capabilities: ['sandbox.access.use'], expiresAt: null }
    }));
    return;
  }
  response.writeHead(404).end();
}).listen(port, host);
`,
	);
	const entry = resolve(
		fileURLToPath(new URL('../bin/flowdular-sandbox.mjs', import.meta.url)),
	);
	const sandboxPort = await freePort();
	const platformPort = await freePort();
	const launcher = spawn(
		process.execPath,
		[
			entry,
			'--workspace',
			root,
			'--port',
			String(sandboxPort),
			'--platform-port',
			String(platformPort),
		],
		{ cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
	);
	let output = '';
	for (const stream of [launcher.stdout, launcher.stderr])
		stream.on('data', (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-12_000);
		});
	try {
		await waitUntil(async () => {
			if (launcher.exitCode !== null) throw new Error(output);
			return output.includes(`Setup token: ${token}`);
		}, 400);
		expect(output.match(new RegExp(`Setup token: ${token}`, 'g'))).toHaveLength(
			1,
		);
		expect(output).toContain(
			`Open setup: http://127.0.0.1:${platformPort}/setup`,
		);
		const response = await fetch(
			`http://127.0.0.1:${sandboxPort}/sandbox/api/state`,
		);
		expect(response.status).toBe(200);
		const setupState = await response.text();
		expect(setupState).not.toContain(token);
		expect(setupState).toContain('For multiple workspaces, choose one');
		expect(
			(
				await fetch(`http://127.0.0.1:${platformPort}/setup`, {
					method: 'POST',
				})
			).status,
		).toBe(204);
		await waitUntil(async () => {
			const state = await fetch(
				`http://127.0.0.1:${sandboxPort}/sandbox/api/state`,
			).then((result) => result.json());
			return state.connection?.connected === true;
		}, 400);
		const connected = await fetch(
			`http://127.0.0.1:${sandboxPort}/sandbox/api/state`,
		).then((result) => result.text());
		expect(connected).toContain('Acme Finance');
		expect(connected).not.toContain(token);
		expect(connected).not.toContain(platformToken);
		expect(output).not.toContain(platformToken);
	} finally {
		launcher.kill('SIGTERM');
		if (launcher.exitCode === null)
			await Promise.race([
				once(launcher, 'exit'),
				delay(8_000).then(() => {
					throw new Error(`Launcher did not exit: ${output}`);
				}),
			]);
		const pids = (await readFile(pidFile, 'utf8'))
			.trim()
			.split('\n')
			.map(Number);
		for (const pid of pids) await waitUntil(() => processGone(pid));
	}
}, 40_000);
