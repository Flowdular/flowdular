import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const consumer = resolve(process.argv[2]);
const runner = resolve(process.argv[3] ?? consumer);
const require = createRequire(join(runner, 'package.json'));
// Resolve the installed binary through its package metadata, not authoring source.
const packageRoot = dirname(dirname(require.resolve('@flowdular/sandbox')));
const metadata = JSON.parse(
	await readFile(join(packageRoot, 'package.json'), 'utf8'),
);
assert.equal(metadata.name, '@flowdular/sandbox');
assert.equal(typeof metadata.dependencies['@flowdular/sdk'], 'string');
assert.deepEqual(
	Object.keys(metadata.dependencies).filter((name) =>
		name.startsWith('@flowdular/'),
	),
	['@flowdular/sdk'],
);
assert.ok(!JSON.stringify(metadata).includes('workspace:'));
const entry = join(packageRoot, metadata.bin['flowdular-sandbox']);
const help = spawnSync(process.execPath, [entry, '--help'], {
	cwd: consumer,
	encoding: 'utf8',
});
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /--workspace/);
// npm-exec invokes a symlink in node_modules/.bin, not the physical entry file.
const binDirectory = await mkdtemp(join(tmpdir(), 'sandbox-bin-'));
try {
	const link = join(binDirectory, 'flowdular-sandbox');
	await symlink(entry, link);
	const linkedHelp = spawnSync(process.execPath, [link, '--help'], {
		cwd: consumer,
		encoding: 'utf8',
		timeout: 10000,
	});
	assert.equal(linkedHelp.status, 0, linkedHelp.stderr);
	assert.match(
		linkedHelp.stdout,
		/--workspace/,
		'npm binary symlink must execute the launcher',
	);
} finally {
	await rm(binDirectory, { recursive: true, force: true });
}

const preview = spawnSync(
	process.execPath,
	[
		'--import',
		join(packageRoot, 'bin/register-types.mjs'),
		'--input-type=module',
		'-e',
		`
import assert from 'node:assert/strict';
import {createSession} from ${JSON.stringify(pathToFileURL(join(packageRoot, 'src/server/index.ts')).href)};
import {createIsolatedPreviewRuntime} from ${JSON.stringify(pathToFileURL(join(packageRoot, 'src/server/preview-worker-manager.ts')).href)};
const root = process.cwd();
const session = await createSession({workspaceRoot: root, kind: 'edit-module', moduleId: 'example.core', title: 'Package smoke', brief: 'Verify isolated preview from installed packages', blueprint: 'edit-module@1.0.0', role: 'backend-engineer', driver: 'fake', install: true});
const runtime = createIsolatedPreviewRuntime(root);
try {
  const composition = await runtime.compose(session);
  assert.equal(composition.error, null);
  assert.ok(composition.routes.length > 0);
} finally { await runtime.dispose(); }
`,
	],
	{ cwd: consumer, encoding: 'utf8', timeout: 45000 },
);
assert.equal(preview.status, 0, preview.stdout + preview.stderr);
console.log(
	'Packed sandbox isolated preview composes the consumer example module.',
);

const socket = createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const { port } = socket.address();
await new Promise((resolve) => socket.close(resolve));
const server = spawn(
	process.execPath,
	[entry, '--workspace', consumer, '--port', String(port)],
	{
		cwd: consumer,
		env: { ...process.env, NODE_ENV: 'test' },
		stdio: ['ignore', 'pipe', 'pipe'],
	},
);
let logs = '';
for (const stream of [server.stdout, server.stderr]) {
	stream.on('data', (chunk) => {
		logs = (logs + chunk).slice(-16000);
	});
}
try {
	let response;
	for (let attempt = 0; attempt < 150; attempt++) {
		if (server.exitCode !== null) throw new Error(logs);
		try {
			response = await fetch(`http://127.0.0.1:${port}/sandbox/api/state`, {
				signal: AbortSignal.timeout(2000),
			});
			if (response.ok) break;
		} catch {
			/* Wait for the Vite application to become ready. */
		}
		await setTimeout(200);
	}
	assert.ok(response?.ok, logs);
	const state = await response.json();
	assert.equal(state.connection.connected, false);
	const page = await fetch(`http://127.0.0.1:${port}/`);
	assert.equal(page.status, 200, logs);
	assert.match(await page.text(), /Flowdular/);
	console.log(
		'Independent sandbox: installed SDK dependency, launcher, HTTP state and SSR page pass.',
	);
} finally {
	if (server.exitCode === null) {
		const exited = once(server, 'exit');
		server.kill('SIGTERM');
		const force = globalThis.setTimeout(() => server.kill('SIGKILL'), 5000);
		await exited;
		clearTimeout(force);
	}
}
