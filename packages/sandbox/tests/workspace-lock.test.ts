import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { main as runEvals } from '../src/evals/cli.ts';
import { hashSpec } from '../src/server/spec.ts';
import {
	acquireWorkspaceLock,
	SandboxAlreadyRunningError,
} from '../src/server/workspace-lock.ts';

const LAUNCHER = fileURLToPath(
	new URL('../bin/flowdular-sandbox.mjs', import.meta.url),
);
const REGISTER_TYPES = pathToFileURL(
	fileURLToPath(new URL('../bin/register-types.mjs', import.meta.url)),
).href;
const WORKSPACE_LOCK = pathToFileURL(
	fileURLToPath(new URL('../src/server/workspace-lock.ts', import.meta.url)),
).href;

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-workspace-lock-'));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	await writeFile(
		join(root, 'flowdular.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
	);
	await writeFile(join(root, 'tsconfig.base.json'), '{}');
	await writeFile(join(root, '.prettierrc.json'), '{}');
	return root;
}

function stateDirectory(root: string): string {
	return join(root, '.flowdular', 'sandbox');
}

/* A lock still on disk after its holder ended was left, not released. */
async function lockOnDisk(root: string): Promise<boolean> {
	return (await readdir(stateDirectory(root))).includes('workspace.lock');
}

function track(child: ChildProcess): ChildProcess {
	cleanup.push(async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		child.kill('SIGKILL');
		await once(child, 'exit');
	});
	return child;
}

function outputOf(child: ChildProcess): () => string {
	let output = '';
	for (const stream of [child.stdout, child.stderr])
		stream?.on('data', (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-12_000);
		});
	return () => output;
}

/* Resolves once the child has printed text, and fails if its output ends
   first. */
function printed(child: ChildProcess, text: string): Promise<void> {
	const output = outputOf(child);
	return new Promise((resolve, reject) => {
		const check = () => {
			if (!output().includes(text)) return;
			child.stdout?.off('data', check);
			child.off('close', closed);
			resolve();
		};
		const closed = () =>
			reject(new Error(`ended before printing ${text}:\n${output()}`));
		child.stdout?.on('data', check);
		child.once('close', closed);
	});
}

type Ending = 'hold' | 'return' | 'exit' | 'throw';

const ENDINGS: Record<Ending, string> = {
	hold: 'setInterval(() => undefined, 1 << 30);',
	return: '',
	exit: 'process.exit(0);',
	throw:
		"setImmediate(() => { throw new Error('crashed while holding the lock'); });",
};

/* Another process that takes the workspace lock through the real module,
   says so, and then ends the way ending says. */
async function holder(root: string, ending: Ending): Promise<ChildProcess> {
	const child = track(
		spawn(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`await import(${JSON.stringify(REGISTER_TYPES)});
const { acquireWorkspaceLock } = await import(${JSON.stringify(WORKSPACE_LOCK)});
await acquireWorkspaceLock(${JSON.stringify(root)});
process.stdout.write('held\\n');
${ENDINGS[ending]}`,
			],
			{ stdio: ['ignore', 'pipe', 'pipe'] },
		),
	);
	await printed(child, 'held');
	return child;
}

describe('workspace lock', () => {
	it('refuses a second holder and names the process that holds it', async () => {
		const root = await workspace();
		const running = await holder(root, 'hold');

		const refusal = acquireWorkspaceLock(root);

		await expect(refusal).rejects.toBeInstanceOf(SandboxAlreadyRunningError);
		await expect(refusal).rejects.toMatchObject({
			code: 'SANDBOX_ALREADY_RUNNING',
			pid: running.pid,
			message: expect.stringContaining(`PID ${running.pid}`),
		});
	});

	it.each(['return', 'exit', 'throw'] as const)(
		'releases the lock when its holder ends by %s',
		async (ending) => {
			const root = await workspace();
			const child = await holder(root, ending);
			if (child.exitCode === null) await once(child, 'exit');

			expect(await lockOnDisk(root)).toBe(false);
			const lock = await acquireWorkspaceLock(root);
			await lock.release();
		},
	);

	it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
		'releases the lock when %s ends a holder that does not handle it',
		async (signal) => {
			const root = await workspace();
			const child = await holder(root, 'hold');

			child.kill(signal);
			const [, ended] = (await once(child, 'exit')) as [null, string];

			expect(ended).toBe(signal);
			expect(await lockOnDisk(root)).toBe(false);
		},
	);

	it('takes over a lock left by a killed holder', async () => {
		const root = await workspace();
		const child = await holder(root, 'hold');
		child.kill('SIGKILL');
		await once(child, 'exit');
		expect(await lockOnDisk(root)).toBe(true);

		const lock = await acquireWorkspaceLock(root);

		/* The lock taken over excludes the next process like any other. */
		const next = spawn(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`await import(${JSON.stringify(REGISTER_TYPES)});
const { acquireWorkspaceLock } = await import(${JSON.stringify(WORKSPACE_LOCK)});
await acquireWorkspaceLock(${JSON.stringify(root)}).then(
	() => process.stdout.write('acquired\\n'),
	(error) => process.stdout.write(error.message + '\\n'),
);`,
			],
			{ stdio: ['ignore', 'pipe', 'pipe'] },
		);
		const output = outputOf(track(next));
		await once(next, 'exit');
		expect(output()).toContain(`PID ${process.pid}`);
		await lock.release();
		expect(await lockOnDisk(root)).toBe(false);
	});

	it('takes over a lock whose PID now belongs to a process that started later', async (context) => {
		context.skip(
			process.platform !== 'linux' && process.platform !== 'darwin',
			'this platform does not report when a process started, so a live PID always counts as the holder',
		);
		const root = await workspace();
		const unrelated = track(
			spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1 << 30)'], {
				stdio: 'ignore',
			}),
		);
		await once(unrelated, 'spawn');
		await mkdir(join(stateDirectory(root), 'workspace.lock'), {
			recursive: true,
		});
		await writeFile(
			join(stateDirectory(root), 'workspace.lock', 'owner.json'),
			JSON.stringify({
				pid: unrelated.pid,
				id: randomUUID(),
				start: 'when the crashed sandbox started',
			}),
		);

		const lock = await acquireWorkspaceLock(root);

		await lock.release();
	});

	it('keeps a lock whose live holder cannot be told apart from a reused PID', async () => {
		const root = await workspace();
		await mkdir(join(stateDirectory(root), 'workspace.lock'), {
			recursive: true,
		});
		await writeFile(
			join(stateDirectory(root), 'workspace.lock', 'owner.json'),
			JSON.stringify({ pid: process.ppid, id: randomUUID() }),
		);

		await expect(acquireWorkspaceLock(root)).rejects.toMatchObject({
			pid: process.ppid,
		});
	});
});

async function freePort(): Promise<number> {
	const socket = createServer();
	await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
	const address = socket.address();
	if (!address || typeof address === 'string') throw new Error('No TCP port');
	await new Promise<void>((resolve) => socket.close(() => resolve()));
	return address.port;
}

async function launcher(root: string): Promise<ChildProcess> {
	return track(
		spawn(
			process.execPath,
			[
				LAUNCHER,
				'--no-platform',
				'--workspace',
				root,
				'--port',
				String(await freePort()),
				'--platform-port',
				String(await freePort()),
			],
			{ cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
		),
	);
}

describe('sandbox launcher', () => {
	it('refuses a second launcher on the same workspace and releases the lock when stopped', async () => {
		const root = await workspace();
		const first = await launcher(root);
		await printed(first, 'FLOWDULAR SANDBOX');

		const second = await launcher(root);
		const secondOutput = outputOf(second);
		/* Fails fast if the second launcher starts serving instead. */
		const outcome = await Promise.race([
			once(second, 'exit').then(() => 'exited'),
			printed(second, 'FLOWDULAR SANDBOX').then(
				() => 'serving',
				() => 'exited',
			),
		]);

		expect(outcome).toBe('exited');
		expect(second.exitCode).toBe(1);
		expect(secondOutput()).toContain(
			`The sandbox is already running for this workspace (PID ${first.pid})`,
		);
		first.kill('SIGINT');
		const [firstCode] = (await once(first, 'exit')) as [number | null];
		expect(firstCode).toBe(0);
		expect(await lockOnDisk(root)).toBe(false);
	}, 180_000);
});

describe('evaluation runner', () => {
	it('refuses to run while a sandbox holds the workspace', async () => {
		const root = await workspace();
		const suite = join(root, 'evals');
		const spec = 'schemaVersion: 2\nid: eval.lock\n';
		await mkdir(join(suite, 'cases', 'lock', 'spec'), { recursive: true });
		await writeFile(join(suite, 'cases', 'lock', 'spec', 'module.yaml'), spec);
		await writeFile(
			join(suite, 'cases', 'lock', 'case.json'),
			JSON.stringify({
				id: 'lock',
				title: 'Lock',
				moduleId: 'eval.lock',
				directory: 'lock',
				kind: 'new-module',
				blueprint: 'new-module',
				role: 'agentic-engineer',
				brief: 'Never runs.',
				maxTurns: 1,
				gates: [],
				checks: [],
				approval: {
					specHash: hashSpec(spec),
					approvedBy: 'operator',
					approvedAt: '2026-10-06',
				},
			}),
		);
		const running = await holder(root, 'hold');
		const errors: string[] = [];
		const error = console.error;
		console.error = (...values: unknown[]) => errors.push(values.join(' '));
		cleanup.push(async () => {
			console.error = error;
		});

		const code = await runEvals([
			'--workspace',
			root,
			'--suite',
			suite,
			'--driver',
			'no-such-driver',
			'--json',
		]);

		expect(code).toBe(1);
		expect(errors.join('\n')).toContain(`PID ${running.pid}`);
		expect(await readdir(stateDirectory(root))).toEqual(['workspace.lock']);
	});
});
