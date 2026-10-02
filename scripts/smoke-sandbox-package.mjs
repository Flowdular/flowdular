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
assert.equal(
	metadata.dependencies['create-flowdular'],
	metadata.version,
	'Packed sandbox must carry the matching generator as a runtime dependency',
);
assert.deepEqual(
	Object.keys(metadata.dependencies).filter((name) =>
		name.startsWith('@flowdular/'),
	),
	['@flowdular/sdk'],
);
assert.ok(!JSON.stringify(metadata).includes('workspace:'));
const entry = join(packageRoot, metadata.bin['flowdular-sandbox']);

// Exercise the packed generator through the sandbox's real resolver. The SDK
// smoke above installs the generated app from packed artifacts; here pnpm is
// stubbed so creation also runs from an otherwise empty directory offline.
const freshParent = await mkdtemp(join(tmpdir(), 'sandbox-new-app-'));
try {
	const target = join(freshParent, 'flowdular');
	const bootstrap = spawnSync(
		process.execPath,
		[
			'--import',
			join(packageRoot, 'bin/register-types.mjs'),
			'--input-type=module',
			'-e',
			`
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {bootstrapApplication} from ${JSON.stringify(pathToFileURL(join(packageRoot, 'src/server/bootstrap.ts')).href)};
const result = await bootstrapApplication({target: ${JSON.stringify(target)}, version: ${JSON.stringify(metadata.version)}}, {
  execute: async (command, args, cwd, env) => {
    if (command === 'pnpm') return {code: 0, output: ''};
    const child = spawnSync(command, args, {cwd, env: env ?? process.env, encoding: 'utf8'});
    return {code: child.status, output: child.stdout + child.stderr};
  },
});
assert.equal(result.root, ${JSON.stringify(target)});
`,
		],
		{ cwd: freshParent, encoding: 'utf8', timeout: 30000 },
	);
	assert.equal(bootstrap.status, 0, bootstrap.stdout + bootstrap.stderr);
	const generated = JSON.parse(await readFile(join(target, 'flowdular.json')));
	assert.equal(generated.schemaVersion, 1);
	const gitAuthor = spawnSync('git', ['log', '-1', '--format=%an <%ae>'], {
		cwd: target,
		encoding: 'utf8',
	});
	assert.equal(gitAuthor.status, 0, gitAuthor.stderr);
	assert.equal(
		gitAuthor.stdout.trim(),
		'Flowdular Starter <starter@flowdular.local>',
	);
	const committedSecrets = spawnSync('git', ['ls-files', '.env'], {
		cwd: target,
		encoding: 'utf8',
	});
	assert.equal(
		committedSecrets.stdout.trim(),
		'',
		'Local secrets must not be committed',
	);
	console.log(
		'Packed sandbox creates a standalone app and initial local commit.',
	);
} finally {
	await rm(freshParent, { recursive: true, force: true });
}

const help = spawnSync(process.execPath, [entry, '--help'], {
	cwd: consumer,
	encoding: 'utf8',
});
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /--workspace/);
assert.match(help.stdout, /--connect <git-url>/);
const unsafeConnect = spawnSync(
	process.execPath,
	[
		entry,
		'--connect=https://user:secret@example.test/platform.git',
		'--no-platform',
	],
	{ cwd: runner, encoding: 'utf8', timeout: 10000 },
);
assert.notEqual(unsafeConnect.status, 0);
assert.doesNotMatch(
	unsafeConnect.stdout + unsafeConnect.stderr,
	/secret/,
	'The launcher must reject a credential in a Git URL without printing it',
);
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
	/* A consumer of the packed package has no Flowdular workspace and no
	   application to reach, so it comes up disconnected and waits for one. The
	   launcher prepares its own credential only when it owns the workspace it
	   bootstrapped, which this fixture is not. */
	const state = await response.json();
	assert.equal(state.connection?.connected, false, logs);
	const page = await fetch(`http://127.0.0.1:${port}/`);
	assert.equal(page.status, 200, logs);
	assert.match(await page.text(), /Flowdular/);
	const sdkRequire = createRequire(
		createRequire(join(packageRoot, 'package.json')).resolve(
			'@flowdular/sdk/ui',
		),
	);
	for (const font of [
		'@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2',
		'@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2',
		'@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2',
	]) {
		const fontPath = sdkRequire.resolve(font);
		const asset = await fetch(`http://127.0.0.1:${port}/@fs/${fontPath}`, {
			signal: AbortSignal.timeout(5000),
		});
		assert.equal(asset.status, 200, `Sandbox must serve ${font}`);
		assert.deepEqual(
			Buffer.from(await asset.arrayBuffer()),
			await readFile(fontPath),
		);
	}
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
