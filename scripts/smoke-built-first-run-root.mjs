import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
	access,
	copyFile,
	cp,
	mkdir,
	mkdtemp,
	rm,
	stat,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const source = resolve(process.argv[2] ?? '.');
const workspace = await mkdtemp(join(tmpdir(), 'flowdular-built-first-run-'));
const platform = join(workspace, 'platform');
await mkdir(platform);
await cp(join(source, 'platform', 'dist'), join(platform, 'dist'), {
	recursive: true,
});
await copyFile(
	join(source, 'platform', 'package.json'),
	join(platform, 'package.json'),
);

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
const child = spawn(process.execPath, ['platform/dist/server/entry.js'], {
	cwd: workspace,
	env: {
		...environment,
		NODE_ENV: 'production',
		PORT: String(port),
	},
	stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
for (const stream of [child.stdout, child.stderr])
	stream.on('data', (chunk) => {
		output = (output + chunk.toString()).slice(-8_000);
	});

try {
	const origin = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 30_000;
	let ready = false;
	while (Date.now() < deadline && child.exitCode === null) {
		try {
			const response = await fetch(`${origin}/setup`, {
				signal: AbortSignal.timeout(2_000),
			});
			if (
				response.status === 200 &&
				response.headers.get('x-flowdular-setup') === 'first-run'
			) {
				ready = true;
				break;
			}
		} catch {
			/* The bundled server is still starting. */
		}
		await delay(200);
	}
	assert.ok(
		ready,
		`Bundled first-run server failed: ${output.replace(/(\bToken\s+)[^\s]+/g, '$1[redacted]')}`,
	);
	const token = await stat(join(workspace, '.flowdular', 'setup-token'));
	assert.ok(token.isFile());
	assert.equal(token.mode & 0o077, 0);
	await assert.rejects(
		access(join(platform, 'dist', '.flowdular', 'setup-token')),
		{ code: 'ENOENT' },
	);
	console.log(
		'Built first-run server uses the workspace root in a Docker layout.',
	);
} finally {
	if (child.exitCode === null) {
		const exited = once(child, 'exit');
		child.kill('SIGTERM');
		await Promise.race([exited, delay(5_000)]);
		if (child.exitCode === null) child.kill('SIGKILL');
	}
	await rm(workspace, { recursive: true, force: true });
}
