import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	PLATFORM_SHUTDOWN_BUDGET_MS,
	PLATFORM_STOP_ESCALATION_MS,
} from '@flowdular/dev-console/shutdown';
import { afterEach, expect, it, vi } from 'vitest';
import {
	findRunningPlatformUrl,
	PlatformStartAbortedError,
	startPlatformProcess,
} from '../src/server/platform-process.ts';
import {
	cleanupPlatformTests,
	freePort,
	platformWorkspace,
	readLedger,
	recordedFixtures,
	spawnLauncher,
	startTrackedPlatform,
	stubbornPlatformSource,
	survivors,
	survivorsAfter,
	trackLedger,
	writePlatformChild,
} from './support/platform-processes.ts';

afterEach(async () => {
	vi.restoreAllMocks();
	/* The cleanup runs ps, which a stubbed PATH would hide. */
	vi.unstubAllEnvs();
	await cleanupPlatformTests();
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
	const workspace = await platformWorkspace('flowdular-platform-setup-');
	const root = workspace.root;
	const marker = join(root, 'configured');
	const pidFile = join(root, 'children.txt');
	await writePlatformChild(
		workspace,
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
	const process = await startTrackedPlatform({
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
	const workspace = await platformWorkspace('flowdular-platform-reload-');
	const root = workspace.root;
	const marker = join(root, 'configured');
	const pidFile = join(root, 'child.pid');
	await writePlatformChild(
		workspace,
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
	const platform = await startTrackedPlatform({
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
	const workspace = await platformWorkspace('flowdular-platform-late-restart-');
	const root = workspace.root;
	const marker = join(root, 'configured');
	const pidFile = join(root, 'children.txt');
	await writePlatformChild(
		workspace,
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
	const platform = await startTrackedPlatform({
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

it('recognizes setup behind a slow first answer and restarts into the application on the setup exit code', async () => {
	const workspace = await platformWorkspace('flowdular-platform-cold-');
	const root = workspace.root;
	const marker = join(root, 'configured');
	const pidFile = join(root, 'children.txt');
	/* Like the development server, the socket opens before the configuration
	   is evaluated, and every request waits for that evaluation. A cold
	   first-run boot takes far longer than a quick probe would wait. */
	await writePlatformChild(
		workspace,
		`import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + '\\n');
const args = process.argv;
const port = Number(args[args.indexOf('--port') + 1]);
const host = args[args.indexOf('--host') + 1];
const setup = !existsSync(${JSON.stringify(marker)});
const evaluated = new Promise((resolve) => setTimeout(resolve, setup ? 4000 : 0));
createServer(async (request, response) => {
  await evaluated;
  if (request.url === '/setup' && setup) {
    if (request.method === 'POST') {
      writeFileSync(${JSON.stringify(marker)}, 'configured');
      response.writeHead(204).end();
      setTimeout(() => process.exit(Number(process.env.FD_SETUP_RESTART_EXIT_CODE)), 100);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html', 'x-flowdular-setup': 'first-run' }).end('<h1>Setup</h1>');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Application</h1>');
}).listen(port, host);
`,
	);
	const ready: { url: string; setup: boolean }[] = [];
	const logs: string[] = [];
	let applicationReady = () => {};
	const restarted = new Promise<void>((resolve) => {
		applicationReady = resolve;
	});
	const platform = await startTrackedPlatform({
		workspaceRoot: root,
		port: await freePort(),
		quiet: true,
		onReady: (state) => {
			ready.push(state);
			if (!state.setup) applicationReady();
		},
		log: (line) => logs.push(line),
	});
	try {
		expect(ready).toEqual([{ url: platform.url, setup: true }]);
		expect(
			(await fetch(`${platform.url}/setup`, { method: 'POST' })).status,
		).toBe(204);
		await restarted;
		expect(ready).toEqual([
			{ url: platform.url, setup: true },
			{ url: platform.url, setup: false },
		]);
		expect(logs).toContain('setup finished; restarting the platform');
		const application = await fetch(`${platform.url}/setup`);
		expect(application.headers.get('x-flowdular-setup')).toBeNull();
		expect(await application.text()).toContain('Application');
	} finally {
		await platform.stop();
		const pids = (await readFile(pidFile, 'utf8'))
			.trim()
			.split('\n')
			.map(Number);
		for (const pid of pids) await waitUntil(() => processGone(pid));
	}
}, 90_000);

it('restarts after setup when the exited process group answers EPERM', async () => {
	const workspace = await platformWorkspace('flowdular-platform-eperm-');
	const root = workspace.root;
	const marker = join(root, 'configured');
	const pidFile = join(root, 'children.txt');
	await writePlatformChild(
		workspace,
		`import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + '\\n');
const args = process.argv;
const port = Number(args[args.indexOf('--port') + 1]);
const host = args[args.indexOf('--host') + 1];
const setup = !existsSync(${JSON.stringify(marker)});
createServer((request, response) => {
  if (request.url === '/setup' && setup) {
    if (request.method === 'POST') {
      writeFileSync(${JSON.stringify(marker)}, 'configured');
      response.writeHead(204).end();
      setTimeout(() => process.exit(Number(process.env.FD_SETUP_RESTART_EXIT_CODE)), 100);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html', 'x-flowdular-setup': 'first-run' }).end('<h1>Setup</h1>');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Application</h1>');
}).listen(port, host);
`,
	);
	/* Darwin reports a process group whose members have exited but are not
	   reaped yet as EPERM rather than ESRCH. */
	const signal = process.kill.bind(process);
	const kill = vi
		.spyOn(process, 'kill')
		.mockImplementation((pid: number, name?: string | number) => {
			try {
				return signal(pid, name);
			} catch (error) {
				if (pid < 0 && (error as NodeJS.ErrnoException).code === 'ESRCH')
					throw Object.assign(new Error('kill EPERM'), {
						code: 'EPERM',
						syscall: 'kill',
					});
				throw error;
			}
		});
	const ready: boolean[] = [];
	const logs: string[] = [];
	let settle = () => {};
	const settled = new Promise<void>((resolve) => {
		settle = resolve;
	});
	try {
		const platform = await startTrackedPlatform({
			workspaceRoot: root,
			port: await freePort(),
			quiet: true,
			onReady: (state) => {
				ready.push(state.setup);
				if (!state.setup) settle();
			},
			log: (line) => {
				logs.push(line);
				if (/restart failed|did not restart|process stopped/.test(line))
					settle();
			},
		});
		try {
			expect(ready).toEqual([true]);
			expect(
				(await fetch(`${platform.url}/setup`, { method: 'POST' })).status,
			).toBe(204);
			await settled;
			expect(logs).not.toContain('the platform restart failed: kill EPERM');
			expect(ready).toEqual([true, false]);
		} finally {
			await platform.stop();
		}
	} finally {
		kill.mockRestore();
		const pids = (await readFile(pidFile, 'utf8'))
			.trim()
			.split('\n')
			.map(Number);
		for (const pid of pids) await waitUntil(() => processGone(pid));
	}
}, 90_000);

it('cancels startup while the platform has not answered its first request', async () => {
	const workspace = await platformWorkspace('flowdular-platform-unanswered-');
	const root = workspace.root;
	const pidFile = join(root, 'child.pid');
	const asked = join(root, 'asked');
	await writePlatformChild(
		workspace,
		`import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const args = process.argv;
const port = Number(args[args.indexOf('--port') + 1]);
const host = args[args.indexOf('--host') + 1];
createServer(() => writeFileSync(${JSON.stringify(asked)}, 'asked')).listen(port, host);
`,
	);
	const controller = new AbortController();
	const startup = startTrackedPlatform({
		workspaceRoot: root,
		port: await freePort(),
		quiet: true,
		signal: controller.signal,
	});
	void startup.catch(() => undefined);
	try {
		await waitUntil(async () => {
			try {
				await readFile(asked);
				return true;
			} catch {
				return false;
			}
		}, 600);
		controller.abort();
		await expect(startup).rejects.toBeInstanceOf(PlatformStartAbortedError);
		const pid = Number(await readFile(pidFile, 'utf8'));
		await waitUntil(() => processGone(pid));
	} finally {
		controller.abort();
		await startup.catch(() => undefined);
	}
}, 60_000);

it('stops waiting for an already-serving platform that has not answered when cancelled', async () => {
	let asked = () => {};
	const requested = new Promise<void>((resolve) => {
		asked = resolve;
	});
	const server = createHttpServer(() => asked());
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('No TCP port');
		const controller = new AbortController();
		const ready: boolean[] = [];
		const startup = startPlatformProcess({
			workspaceRoot: '/unused',
			port: address.port,
			signal: controller.signal,
			onReady: (state) => {
				ready.push(state.setup);
			},
		});
		await requested;
		controller.abort();
		expect((await startup).url).toBe(`http://127.0.0.1:${address.port}`);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}, 30_000);

it('stops a platform child when startup is cancelled', async () => {
	const workspace = await platformWorkspace('flowdular-platform-start-');
	const root = workspace.root;
	const childPidFile = join(root, 'child.pid');
	await writePlatformChild(
		workspace,
		`import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(childPidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
	);
	const controller = new AbortController();
	const startup = startTrackedPlatform({
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
	const workspace = await platformWorkspace('flowdular-launcher-stop-');
	const root = workspace.root;
	const childPidFile = join(root, 'child.pid');
	await writeFile(
		join(root, 'flowdular.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
	);
	await writePlatformChild(
		workspace,
		`import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(childPidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
	);
	const { child: launcher, output } = spawnLauncher(workspace, {
		sandbox: await freePort(),
		platform: await freePort(),
	});
	let childPid: number | null = null;
	await waitUntil(async () => {
		try {
			childPid = Number(await readFile(childPidFile, 'utf8'));
			return true;
		} catch {
			if (launcher.exitCode !== null) throw new Error(output());
			return false;
		}
	}, 300).catch((error) => {
		throw new Error(
			`${error instanceof Error ? error.message : error}\n${output()}`,
		);
	});
	launcher.kill('SIGTERM');
	await Promise.race([
		once(launcher, 'exit'),
		delay(8_000).then(() => {
			throw new Error(`Launcher did not exit: ${output()}`);
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
			`${error instanceof Error ? error.message : error}\n${state}\n${output()}`,
		);
	});
}, 30_000);

it('reports the address of the platform it starts before that platform answers', async () => {
	const workspace = await platformWorkspace('flowdular-launcher-address-');
	const root = workspace.root;
	const childPidFile = join(root, 'child.pid');
	await writeFile(
		join(root, 'flowdular.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
	);
	/* A first-run platform is still booting when the banner prints. */
	await writePlatformChild(
		workspace,
		`import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(childPidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
	);
	const sandboxPort = await freePort();
	const platformPort = await freePort();
	const started = `http://127.0.0.1:${platformPort}`;
	const { child: launcher, output } = spawnLauncher(workspace, {
		sandbox: sandboxPort,
		platform: platformPort,
	});
	const plain = () => output().replace(/\x1b\[[0-9;]*m/g, '');
	const bannerPrinted = new Promise<void>((resolve, reject) => {
		for (const stream of [launcher.stdout, launcher.stderr])
			stream.on('data', () => {
				if (/^\s*diagnostics\s/m.test(plain())) resolve();
			});
		launcher.once('exit', () => reject(new Error(output())));
	});
	try {
		await bannerPrinted;
		expect(/^\s*platform\s+(\S+) · /m.exec(plain())?.[1]).toBe(started);
		const state = await fetch(
			`http://127.0.0.1:${sandboxPort}/sandbox/api/state`,
		).then((response) => response.json());
		expect(state.configuration.platformUrl).toBe(started);
		const stored = JSON.parse(
			await readFile(
				join(root, '.flowdular', 'sandbox', 'config.json'),
				'utf8',
			),
		);
		expect(stored.platformUrl).toBe(started);
	} finally {
		launcher.kill('SIGTERM');
		if (launcher.exitCode === null)
			await Promise.race([
				once(launcher, 'exit'),
				delay(8_000).then(() => {
					throw new Error(`Launcher did not exit: ${output()}`);
				}),
			]);
		const childPid = await readFile(childPidFile, 'utf8').then(
			Number,
			() => null,
		);
		if (childPid !== null) await waitUntil(() => processGone(childPid));
	}
}, 90_000);

/* Most of the budget goes to the sandbox's first Vite request, which
   transforms its server modules cold and has taken a minute on a loaded
   machine. */
it('shows the private setup token once in the launcher terminal without putting it in HTTP state', async () => {
	const workspace = await platformWorkspace('flowdular-launcher-setup-');
	const root = workspace.root;
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
	await writePlatformChild(
		workspace,
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
	const sandboxPort = await freePort();
	const platformPort = await freePort();
	const { child: launcher, output } = spawnLauncher(workspace, {
		sandbox: sandboxPort,
		platform: platformPort,
	});
	try {
		await waitUntil(async () => {
			if (launcher.exitCode !== null) throw new Error(output());
			return output().includes(`Setup token: ${token}`);
		}, 400);
		expect(
			output().match(new RegExp(`Setup token: ${token}`, 'g')),
		).toHaveLength(1);
		expect(output()).toContain(
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
		expect(output()).not.toContain(platformToken);
	} finally {
		launcher.kill('SIGTERM');
		if (launcher.exitCode === null)
			await Promise.race([
				once(launcher, 'exit'),
				delay(8_000).then(() => {
					throw new Error(`Launcher did not exit: ${output()}`);
				}),
			]);
		const pids = (await readFile(pidFile, 'utf8'))
			.trim()
			.split('\n')
			.map(Number);
		for (const pid of pids) await waitUntil(() => processGone(pid));
	}
}, 120_000);

it('stops every process in the platform group, including one that ignores SIGTERM', async () => {
	const workspace = await platformWorkspace('flowdular-platform-group-');
	await writePlatformChild(workspace, stubbornPlatformSource(workspace.ledger));
	const platform = await startTrackedPlatform({
		workspaceRoot: workspace.root,
		port: await freePort(),
		quiet: true,
	});
	const recorded = await recordedFixtures(workspace.ledger, 2);
	expect(survivors(recorded)).toHaveLength(4);
	await platform.stop();
	/* stop() can return while killed members wait to be reaped. */
	await waitUntil(async () => survivors(recorded).length === 0, 40).catch(
		() => undefined,
	);
	expect(survivors(recorded)).toEqual([]);
}, 30_000);

/* pnpm delivers the stop's SIGTERM twice; the drain outlasts the old
   three-second SIGKILL and ends a second before the budget. A shell that does
   not exec the script dies on the SIGTERM, and pnpm exits with it while the
   platform still drains. */
it.each([
	['directly', 'node child.mjs'],
	['through a shell that stays', 'sh run.sh'],
])(
	'lets the platform drain past three seconds within its shutdown budget, started %s',
	async (_, dev) => {
		const workspace = await platformWorkspace('flowdular-platform-drain-');
		const drained = join(workspace.root, 'drained');
		const shutdown = pathToFileURL(
			createRequire(import.meta.url).resolve('@flowdular/dev-console/shutdown'),
		).href;
		await writeFile(
			join(workspace.root, 'run.sh'),
			'node child.mjs "$@"\nexit $?\n',
		);
		await writePlatformChild(
			workspace,
			`import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { stopOnSignals } from ${JSON.stringify(shutdown)};
const args = process.argv;
const server = createServer((request, response) => response.writeHead(404).end()).listen(Number(args[args.indexOf('--port') + 1]), args[args.indexOf('--host') + 1]);
stopOnSignals(() => {
	server.close();
	setTimeout(() => {
		writeFileSync(${JSON.stringify(drained)}, 'drained');
		process.exit(0);
	}, ${PLATFORM_SHUTDOWN_BUDGET_MS - 1_000});
});
`,
			dev,
		);
		const platform = await startTrackedPlatform({
			workspaceRoot: workspace.root,
			port: await freePort(),
			quiet: true,
		});
		const stopping = Date.now();
		await platform.stop();
		expect(await readFile(drained, 'utf8')).toBe('drained');
		/* The stop ends with the drain, not with the SIGKILL after the grace. */
		expect(Date.now() - stopping).toBeLessThan(PLATFORM_STOP_ESCALATION_MS);
	},
	30_000,
);

it('reports a platform command that cannot be started', async () => {
	const workspace = await platformWorkspace('flowdular-platform-missing-');
	/* The guard starts by absolute path; pnpm is looked up in an empty PATH. */
	vi.stubEnv('PATH', workspace.root);
	await expect(
		startTrackedPlatform({
			workspaceRoot: workspace.root,
			port: await freePort(),
			quiet: true,
		}),
	).rejects.toThrow('spawn pnpm ENOENT');
});

it.each([
	['SIGKILL', 'worker'],
	['SIGHUP', 'worker'],
	['SIGKILL', 'server'],
] as const)(
	'stops the platform tree when the launcher dies by %s and its %s ignores SIGTERM',
	async (signal, stubborn) => {
		const workspace = await platformWorkspace('flowdular-launcher-abrupt-');
		await writeFile(
			join(workspace.root, 'flowdular.json'),
			JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
		);
		await writePlatformChild(
			workspace,
			stubbornPlatformSource(workspace.ledger, stubborn),
		);
		const { child: launcher, output } = spawnLauncher(workspace, {
			sandbox: await freePort(),
			platform: await freePort(),
		});
		const recorded = await recordedFixtures(workspace.ledger, 2).catch(
			(error: Error) => {
				throw new Error(`${error.message}\n${output()}`);
			},
		);
		expect(launcher.exitCode).toBeNull();
		launcher.kill(signal);
		await waitUntil(async () => launcher.signalCode !== null);
		expect(launcher.signalCode).toBe(signal);
		/* The guard escalates to SIGKILL after PLATFORM_STOP_ESCALATION_MS;
		   seven more seconds bound that on a loaded machine. */
		expect(
			await survivorsAfter(recorded, PLATFORM_STOP_ESCALATION_MS + 7_000),
		).toEqual([]);
	},
	60_000,
);

it('stops the platform tree when a second Ctrl+C ends the launcher during shutdown', async () => {
	const workspace = await platformWorkspace('flowdular-launcher-interrupt-');
	await writeFile(
		join(workspace.root, 'flowdular.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
	);
	await writePlatformChild(workspace, stubbornPlatformSource(workspace.ledger));
	const { child: launcher, output } = spawnLauncher(workspace, {
		sandbox: await freePort(),
		platform: await freePort(),
	});
	const recorded = await recordedFixtures(workspace.ledger, 2).catch(
		(error: Error) => {
			throw new Error(`${error.message}\n${output()}`);
		},
	);
	launcher.kill('SIGINT');
	/* Printed once the platform's stop has begun. */
	await waitUntil(async () => output().includes('Sandbox stopped.'));
	launcher.kill('SIGINT');
	await waitUntil(
		async () => launcher.exitCode !== null || launcher.signalCode !== null,
	);
	expect(
		await survivorsAfter(recorded, PLATFORM_STOP_ESCALATION_MS + 7_000),
	).toEqual([]);
}, 60_000);

it('leaves no process behind when a launcher test fails or times out', async () => {
	const workspace = await platformWorkspace('flowdular-abandoned-run-');
	const ledger = join(workspace.root, 'abandoned.txt');
	trackLedger(ledger);
	const support = fileURLToPath(
		new URL('./support/platform-processes.ts', import.meta.url),
	);
	await writeFile(
		join(workspace.root, 'abandoned.test.ts'),
		`import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupPlatformTests, freePort, platformWorkspace, recordedFixtures, spawnLauncher, stubbornPlatformSource, writePlatformChild } from ${JSON.stringify(support)};

const ledger = ${JSON.stringify(ledger)};
let platforms = 0;
afterEach(cleanupPlatformTests);
beforeEach(async () => {
  const workspace = await platformWorkspace('flowdular-abandoned-', ledger);
  await writeFile(join(workspace.root, 'flowdular.json'), JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }));
  await writePlatformChild(workspace, stubbornPlatformSource(ledger));
  spawnLauncher(workspace, { sandbox: await freePort(), platform: await freePort() });
  platforms += 2;
  await recordedFixtures(ledger, platforms, 45_000);
}, 60_000);
it('fails while its platform runs', () => {
  throw new Error('deliberate failure');
});
it('times out while its platform runs', () => new Promise(() => undefined), 250);
`,
	);
	const environment = Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => !/^(?:VITEST|TINYPOOL|FORCE_COLOR)/.test(name),
		),
	);
	const run = spawn(
		process.execPath,
		[
			fileURLToPath(
				new URL('../node_modules/vitest/vitest.mjs', import.meta.url),
			),
			'run',
			'--root',
			workspace.root,
			'--globals',
			'--hookTimeout=60000',
		],
		{
			cwd: workspace.root,
			env: { ...environment, NO_COLOR: '1' },
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: process.platform !== 'win32',
		},
	);
	await writeFile(workspace.ledger, `${run.pid} ${run.pid}\n`);
	let output = '';
	for (const stream of [run.stdout, run.stderr])
		stream.on('data', (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-20_000);
		});
	const [code] = await once(run, 'exit');
	expect(output).toContain('deliberate failure');
	expect(output).toContain('Test timed out in 250ms');
	expect(code, output).toBe(1);
	const recorded = await readLedger(ledger);
	expect(recorded.filter(({ group }) => group === null)).toHaveLength(2);
	expect(recorded.filter(({ group }) => group !== null)).toHaveLength(4);
	expect(survivors([...recorded, { pid: run.pid!, group: run.pid! }])).toEqual(
		[],
	);
}, 120_000);
