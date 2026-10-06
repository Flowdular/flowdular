import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { PLATFORM_SHUTDOWN_BUDGET_MS } from '@flowdular/dev-console/shutdown';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { scaffold } from '../src/scaffold.ts';

/* The generated scripts/dev.mjs with the real Vite and the real stop sequence.
   The configuration stands in for octane.config.ts with one runtime
   generation: a worker that holds the process open until the generation
   retires, and a retirement that takes a while and leaves a marker. Without
   a watcher, macOS cannot report the configuration this test just wrote as a
   change and restart Vite into a second generation. */

const require = createRequire(import.meta.url);
const shutdown = require.resolve('@flowdular/dev-console/shutdown');
const devConsole = join(dirname(shutdown), 'index.mjs');
const vite = dirname(createRequire(shutdown).resolve('vite/package.json'));

let root: string;
let platform: string;
const children: ChildProcess[] = [];

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), 'flowdular-template-dev-'));
	const generated = await scaffold({
		cwd: root,
		target: 'app',
		template: 'default',
		force: false,
	});
	platform = join(generated.directory, 'platform');
	const sdk = join(platform, 'node_modules', '@flowdular', 'sdk');
	await mkdir(sdk, { recursive: true });
	await writeFile(
		join(sdk, 'package.json'),
		JSON.stringify({
			name: '@flowdular/sdk',
			type: 'module',
			exports: {
				'./dev-console': './dev-console.mjs',
				'./dev-console/shutdown': './shutdown.mjs',
			},
		}),
	);
	await writeFile(
		join(sdk, 'dev-console.mjs'),
		`export * from ${JSON.stringify(pathToFileURL(devConsole).href)};\n`,
	);
	await writeFile(
		join(sdk, 'shutdown.mjs'),
		`export * from ${JSON.stringify(pathToFileURL(shutdown).href)};\n`,
	);
	await symlink(vite, join(platform, 'node_modules', 'vite'), 'dir');
});

afterEach(() => {
	for (const child of children.splice(0))
		if (child.exitCode === null && child.signalCode === null)
			child.kill('SIGKILL');
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
	const socket = createServer();
	await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
	const address = socket.address();
	if (!address || typeof address === 'string') throw new Error('No TCP port');
	await new Promise<void>((resolve) => socket.close(() => resolve()));
	return address.port;
}

async function writeRuntimeGeneration(marker: string): Promise<void> {
	await writeFile(
		join(platform, 'vite.config.ts'),
		`import { writeFileSync } from 'node:fs';

const worker = setInterval(() => {}, 1000);
process.on('flowdular:platform-runtime-retire', (report) => {
	report(
		(async () => {
			await new Promise((resolve) => setTimeout(resolve, 300));
			clearInterval(worker);
			writeFileSync(${JSON.stringify(marker)}, 'retired');
		})(),
	);
});

export default {
	optimizeDeps: { noDiscovery: true, include: [] },
	server: { watch: null },
	plugins: [
		{
			name: 'readiness',
			configureServer(server) {
				server.middlewares.use('/ready', (_request, response) => {
					response.end('ready');
				});
			},
		},
	],
};
`,
	);
}

it.each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)(
	'retires the runtime and exits 0 within the budget on %s',
	async (signal) => {
		const marker = join(root, `retired-${signal}`);
		await writeRuntimeGeneration(marker);
		const port = await freePort();
		const child = spawn(
			process.execPath,
			[
				join(platform, 'scripts', 'dev.mjs'),
				'--port',
				String(port),
				'--host',
				'127.0.0.1',
				'--no-open',
			],
			{
				cwd: platform,
				env: { ...process.env, FORCE_COLOR: '0' },
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		);
		children.push(child);
		let output = '';
		for (const stream of [child.stdout!, child.stderr!])
			stream.on('data', (chunk: Buffer) => {
				output += chunk.toString();
			});
		const exited = once(child, 'exit');

		const deadline = Date.now() + 30_000;
		let ready = false;
		while (!ready && Date.now() < deadline && child.exitCode === null) {
			ready = await fetch(`http://127.0.0.1:${port}/ready`)
				.then((response) => response.ok)
				.catch(() => false);
			if (!ready) await delay(100);
		}
		expect(ready, output).toBe(true);

		const stoppedAt = performance.now();
		child.kill(signal);
		expect(await exited, output).toEqual([0, null]);
		expect(performance.now() - stoppedAt).toBeLessThan(
			PLATFORM_SHUTDOWN_BUDGET_MS,
		);
		expect(await readFile(marker, 'utf8')).toBe('retired');
	},
	60_000,
);
