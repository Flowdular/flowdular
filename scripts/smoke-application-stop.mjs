import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PLATFORM_SHUTDOWN_BUDGET_MS } from '../packages/dev-console/src/shutdown.mjs';

/* Stops an initialized application the way the sandbox and a terminal do and
   starts it again on the same embedded database. The driver removes its lock
   file only when the database has closed, so a lock left behind is a stop that
   cut the drain. */
const root = resolve(process.argv[2]);
const database = join(root, '.flowdular/test-setup');
const lock = join(database, 'flowdular.lock');
const environment = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith('FD_')),
);

async function freePort() {
	const socket = createServer();
	socket.listen(0, '127.0.0.1');
	await once(socket, 'listening');
	const { port } = socket.address();
	await new Promise((resolveClose) => socket.close(resolveClose));
	return port;
}

async function startApplication() {
	const port = await freePort();
	const child = spawn(
		process.execPath,
		[
			`--env-file=${join(root, '.env')}`,
			'platform/scripts/dev.mjs',
			'--port',
			String(port),
			'--host',
			'127.0.0.1',
			'--no-open',
		],
		{
			cwd: root,
			env: {
				...environment,
				NODE_ENV: 'development',
				FD_DATABASE_ADAPTER: 'pglite',
				FD_DATABASE_PGLITE_DIRECTORY: database,
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	let logs = '';
	for (const stream of [child.stdout, child.stderr])
		stream.on('data', (chunk) => {
			logs = (logs + chunk.toString()).slice(-16000);
		});
	const exited = once(child, 'exit');
	const origin = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(logs);
		const healthy = await fetch(`${origin}/api/health`, {
			signal: AbortSignal.timeout(2000),
		})
			.then((response) => response.ok)
			.catch(() => false);
		if (healthy) break;
		await delay(200);
	}
	/* A sign-in reads the workspace and writes a session, so it proves the
	   directory the previous stop left behind opens and accepts writes. */
	const signIn = await fetch(`${origin}/api/auth/sign-in`, {
		method: 'POST',
		headers: { origin, 'content-type': 'application/json' },
		body: JSON.stringify({
			email: 'admin@example.com',
			password: 'Owner!23456789',
		}),
		signal: AbortSignal.timeout(30_000),
	});
	assert.equal(signIn.status, 200, logs);
	return { child, exited, logs: () => logs };
}

let application;
try {
	for (const signal of ['SIGTERM', 'SIGTERM', 'SIGTERM', 'SIGINT', 'SIGHUP']) {
		application = await startApplication();
		const stoppedAt = performance.now();
		application.child.kill(signal);
		const [code, killedBy] = await application.exited;
		const elapsed = performance.now() - stoppedAt;
		assert.deepEqual(
			[code, killedBy],
			[0, null],
			`${signal} ended the application with ${code ?? killedBy}:\n${application.logs()}`,
		);
		assert.ok(
			elapsed < PLATFORM_SHUTDOWN_BUDGET_MS,
			`${signal} took ${Math.round(elapsed)} ms to stop:\n${application.logs()}`,
		);
		await assert.rejects(
			access(lock),
			{ code: 'ENOENT' },
			`${signal} exited before the embedded database closed:\n${application.logs()}`,
		);
		console.log(
			`${signal} drained the application in ${Math.round(elapsed)} ms.`,
		);
	}
	application = await startApplication();
	console.log(
		'The embedded database opens and accepts writes after repeated stops.',
	);
} finally {
	if (application && application.child.exitCode === null) {
		const force = setTimeout(() => application.child.kill('SIGKILL'), 10_000);
		application.child.kill('SIGTERM');
		await application.exited;
		clearTimeout(force);
	}
}
