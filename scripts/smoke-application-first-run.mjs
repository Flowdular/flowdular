import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(process.argv[2]);
const database = join(root, '.flowdular', 'test-first-run');
const credentialPath = join(
	root,
	'.flowdular',
	'sandbox',
	'sandbox-credential.json',
);
const sandboxState = join(root, '.flowdular', 'sandbox');
const environment = Object.fromEntries(
	Object.entries(process.env).filter(
		([key]) => !key.startsWith('FD_') && !key.startsWith('CORELOOM_'),
	),
);
const socket = createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const { port } = socket.address();
await new Promise((resolveClose) => socket.close(resolveClose));

const child = spawn(
	process.execPath,
	[
		`--env-file-if-exists=${join(root, '.env')}`,
		'platform/scripts/dev.mjs',
		'--port',
		String(port),
		'--host',
		'127.0.0.1',
	],
	{
		cwd: root,
		env: {
			...environment,
			NODE_ENV: 'development',
			FD_DATABASE_ADAPTER: 'pglite',
			FD_DATABASE_PGLITE_DIRECTORY: database,
			FD_SANDBOX_PROVISION: 'true',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	},
);
let logs = '';
for (const stream of [child.stdout, child.stderr])
	stream.on('data', (chunk) => {
		logs = (logs + chunk.toString()).slice(-12000);
	});

try {
	const deadline = Date.now() + 60_000;
	let credential;
	let healthy = false;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(logs);
		try {
			credential = JSON.parse(await readFile(credentialPath, 'utf8'));
			const health = await fetch(`http://127.0.0.1:${port}/api/health`, {
				signal: AbortSignal.timeout(2000),
			});
			if (health.ok) {
				healthy = true;
				break;
			}
		} catch {
			/* Provisioning and the application boot can take several seconds. */
		}
		await delay(200);
	}
	assert.ok(credential, logs);
	assert.ok(healthy, logs);
	assert.ok(
		typeof credential.token === 'string' && credential.token.length > 20,
	);
	assert.ok(credential.capabilities.includes('sandbox.access.use'));
	console.log(
		'Fresh application boot provisions sandbox access on embedded PostgreSQL.',
	);
} finally {
	if (child.exitCode === null) {
		const exited = once(child, 'exit');
		child.kill('SIGTERM');
		const force = setTimeout(() => child.kill('SIGKILL'), 5000);
		await exited;
		clearTimeout(force);
	}
	await rm(sandboxState, { recursive: true, force: true });
	await rm(database, { recursive: true, force: true });
}
