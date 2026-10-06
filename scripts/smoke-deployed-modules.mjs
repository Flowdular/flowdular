import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
	copyFile,
	cp,
	mkdtemp,
	readFile,
	realpath,
	rm,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/* A deployment ships no node_modules. Package the application the way the
   Vercel build does, boot its server from the function alone, away from the
   workspace, and check that every enabled module is active, the modules
   @flowdular/sdk ships included. */
const root = resolve(process.argv[2]);
const packaged = spawnSync(
	process.execPath,
	['infra/vercel/build.mjs', '--package-only'],
	{ cwd: root, stdio: 'inherit' },
);
if (packaged.status !== 0) throw new Error('Vercel packaging failed.');

const deployed = await mkdtemp(join(tmpdir(), 'flowdular-deployed-'));
await cp(join(root, '.vercel/output/functions/flowdular.func'), deployed, {
	recursive: true,
	verbatimSymlinks: true,
});
/* The bundle loads PGlite's runtime files from beside itself. A deployment
   runs on PostgreSQL and never needs them; this check reuses the consumer's
   embedded database, so it supplies them. */
const sdk = await realpath(join(root, 'platform/node_modules/@flowdular/sdk'));
const pglite = dirname(
	createRequire(join(sdk, 'package.json')).resolve('@electric-sql/pglite'),
);
for (const name of ['pglite.data', 'pglite.wasm', 'initdb.wasm']) {
	await copyFile(
		join(pglite, name),
		join(deployed, 'platform/dist/server', name),
	);
}

const socket = createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const address = socket.address();
if (!address || typeof address === 'string') throw new Error('No test port');
const port = address.port;
await new Promise((done) => socket.close(done));

const environment = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith('FD_')),
);
const child = spawn(
	process.execPath,
	[`--env-file=${join(root, '.env')}`, 'platform/dist/server/entry.js'],
	{
		cwd: deployed,
		env: {
			...environment,
			NODE_ENV: 'development',
			PORT: String(port),
			FD_DATABASE_ADAPTER: 'pglite',
			FD_DATABASE_PGLITE_DIRECTORY: join(root, '.flowdular/test-setup'),
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	},
);
let output = '';
for (const stream of [child.stdout, child.stderr])
	stream.on('data', (chunk) => {
		output = (output + chunk.toString()).slice(-8_000);
	});

try {
	const origin = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 45_000;
	let ready = false;
	while (Date.now() < deadline && child.exitCode === null) {
		try {
			const response = await fetch(`${origin}/api/health`, {
				signal: AbortSignal.timeout(2_000),
			});
			if (response.ok) {
				ready = true;
				break;
			}
		} catch {
			/* The deployed server is still starting. */
		}
		await delay(200);
	}
	assert.ok(ready, `Deployed server failed: ${output}`);
	const login = await fetch(`${origin}/api/auth/sign-in`, {
		method: 'POST',
		headers: { origin, 'content-type': 'application/json' },
		body: JSON.stringify({
			email: 'admin@example.com',
			password: 'Owner!23456789',
		}),
		signal: AbortSignal.timeout(30_000),
	});
	assert.equal(login.status, 200, output);
	const cookie = login.headers
		.getSetCookie()
		.map((value) => value.split(';')[0])
		.join('; ');
	const active = await fetch(`${origin}/api/system/modules/active`, {
		headers: { cookie },
		signal: AbortSignal.timeout(30_000),
	});
	assert.equal(active.status, 200, output);
	const { enabled } = JSON.parse(
		await readFile(join(deployed, 'flowdular.json'), 'utf8'),
	).modules;
	assert.deepEqual(
		(await active.json()).modules,
		[...enabled].sort(),
		'A deployment without node_modules has every enabled module active',
	);
	console.log(
		'Deployed function without node_modules reports every enabled module active.',
	);
} finally {
	if (child.exitCode === null) {
		const exited = once(child, 'exit');
		child.kill('SIGTERM');
		await Promise.race([exited, delay(5_000)]);
		if (child.exitCode === null) child.kill('SIGKILL');
	}
	await rm(deployed, { recursive: true, force: true });
	await rm(join(root, '.vercel/output'), { recursive: true, force: true });
}
