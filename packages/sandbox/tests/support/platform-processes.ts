import {
	execFileSync,
	spawn,
	type ChildProcessByStdio,
} from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
	startPlatformProcess,
	type PlatformProcess,
	type StartPlatformOptions,
} from '../../src/server/platform-process.ts';

/* Platform tests start real process trees: a launcher, the platform guard, pnpm
   and a fixture server. A test that fails or times out never reaches its own
   finally, so each process records itself in a ledger as it starts and
   cleanupPlatformTests() kills and awaits whatever the ledgers name. */

const LAUNCHER = fileURLToPath(
	new URL('../../bin/flowdular-sandbox.mjs', import.meta.url),
);

const directories: string[] = [];
const ledgers = new Set<string>();
const platforms: {
	readonly controller: AbortController;
	readonly started: Promise<PlatformProcess>;
}[] = [];

function processGroupOf(pid: number): number {
	return Number(
		execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
			encoding: 'utf8',
		}).trim(),
	);
}

export async function freePort(): Promise<number> {
	const socket = createServer();
	await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
	const address = socket.address();
	if (!address || typeof address === 'string') throw new Error('No TCP port');
	await new Promise<void>((resolve) => socket.close(() => resolve()));
	return address.port;
}

/* Darwin answers EPERM for a group that holds only unreaped zombies, and a
   process a test started never belongs to another user, so EPERM is gone. */
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== 'ESRCH' && code !== 'EPERM';
	}
}

export interface RecordedProcess {
	readonly pid: number;
	/** The fixture's process group; null for a launcher, which shares ours. */
	readonly group: number | null;
}

export async function readLedger(ledger: string): Promise<RecordedProcess[]> {
	let text: string;
	try {
		text = await readFile(ledger, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	return text
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [pid, group] = line.split(' ').map(Number);
			return {
				pid: pid!,
				group: Number.isInteger(group) && group! > 1 ? group! : null,
			};
		});
}

/** Module source a fixture runs first: it appends `pid pgid` to the ledger. */
export function recordProcessSource(ledger: string): string {
	return `import { execFileSync as fixtureProcessGroup } from 'node:child_process';
import { appendFileSync as recordFixtureProcess } from 'node:fs';
recordFixtureProcess(${JSON.stringify(ledger)}, process.pid + ' ' + fixtureProcessGroup('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim() + '\\n');
`;
}

/** A serving platform with a worker that ignores SIGTERM, so only SIGKILL to
    its whole process group stops every process. With `server`, the serving
    process ignores SIGTERM too and pnpm never exits on its own. Both record
    themselves. */
export function stubbornPlatformSource(
	ledger: string,
	stubborn: 'worker' | 'server' = 'worker',
): string {
	const ignoreTerm = "process.on('SIGTERM', () => {});\n";
	const worker = `${recordProcessSource(ledger)}${ignoreTerm}setInterval(() => {}, 1000);
`;
	return `import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
${stubborn === 'server' ? ignoreTerm : ''}spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(worker)}], { stdio: 'ignore' });
const args = process.argv;
createServer((request, response) => response.writeHead(404).end()).listen(Number(args[args.indexOf('--port') + 1]), args[args.indexOf('--host') + 1]);
`;
}

export interface PlatformWorkspace {
	readonly root: string;
	readonly ledger: string;
}

export async function platformWorkspace(
	prefix: string,
	ledger?: string,
): Promise<PlatformWorkspace> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	directories.push(root);
	const path = ledger ?? join(root, 'processes.txt');
	trackLedger(path);
	return { root, ledger: path };
}

/** Cleans up the processes a ledger names after the current test. */
export function trackLedger(ledger: string): void {
	ledgers.add(ledger);
}

/** Makes `pnpm dev` in the workspace run `source` as child.mjs, recorded. */
export async function writePlatformChild(
	workspace: PlatformWorkspace,
	source: string,
): Promise<void> {
	await writeFile(
		join(workspace.root, 'package.json'),
		JSON.stringify({ private: true, scripts: { dev: 'node child.mjs' } }),
	);
	await writeFile(
		join(workspace.root, 'child.mjs'),
		recordProcessSource(workspace.ledger) + source,
	);
}

export function startTrackedPlatform(
	options: StartPlatformOptions,
): Promise<PlatformProcess> {
	const controller = new AbortController();
	const started = startPlatformProcess({
		...options,
		signal: options.signal
			? AbortSignal.any([options.signal, controller.signal])
			: controller.signal,
	});
	platforms.push({ controller, started });
	return started;
}

export interface Launcher {
	readonly child: ChildProcessByStdio<null, Readable, Readable>;
	output(): string;
}

export function spawnLauncher(
	workspace: PlatformWorkspace,
	ports: { readonly sandbox: number; readonly platform: number },
): Launcher {
	const child = spawn(
		process.execPath,
		[
			LAUNCHER,
			'--workspace',
			workspace.root,
			'--port',
			String(ports.sandbox),
			'--platform-port',
			String(ports.platform),
		],
		{ cwd: workspace.root, stdio: ['ignore', 'pipe', 'pipe'] },
	);
	if (child.pid !== undefined)
		appendFileSync(workspace.ledger, `${child.pid}\n`);
	let output = '';
	for (const stream of [child.stdout, child.stderr])
		stream.on('data', (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-12_000);
		});
	return { child, output: () => output };
}

/** Polls until the ledger names `count` fixture processes. */
export async function recordedFixtures(
	ledger: string,
	count: number,
	boundMs = 20_000,
): Promise<RecordedProcess[]> {
	const deadline = Date.now() + boundMs;
	for (;;) {
		const fixtures = (await readLedger(ledger)).filter(
			({ group }) => group !== null,
		);
		if (fixtures.length >= count) return fixtures;
		if (Date.now() >= deadline)
			throw new Error(`${ledger} named ${fixtures.length} of ${count}.`);
		await delay(25);
	}
}

/** Kills every process and process group the ledger names, then awaits them. */
export async function stopRecordedProcesses(
	ledger: string,
	boundMs = 10_000,
): Promise<void> {
	const recorded = await readLedger(ledger);
	const ownProcessGroup = processGroupOf(process.pid);
	/* A group equal to ours would mean the platform was never isolated; killing
	   it would kill the test runner, so only the processes are signalled. */
	const groups = new Set(
		recorded.flatMap(({ group }) =>
			group !== null && group !== ownProcessGroup ? [group] : [],
		),
	);
	const kill = (pid: number) => {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			/* Already gone. */
		}
	};
	for (const group of groups) kill(-group);
	for (const { pid } of recorded) kill(pid);
	const deadline = Date.now() + boundMs;
	for (;;) {
		const survivors = [
			...recorded.map(({ pid }) => pid).filter(processAlive),
			...[...groups].map((group) => -group).filter(processAlive),
		];
		if (survivors.length === 0) return;
		if (Date.now() >= deadline)
			throw new Error(`Processes outlived the test: ${survivors.join(' ')}`);
		await delay(25);
	}
}

export async function cleanupPlatformTests(): Promise<void> {
	const owned = platforms.splice(0);
	for (const { controller } of owned) controller.abort();
	const failures: unknown[] = [];
	for (const ledger of ledgers) {
		try {
			await stopRecordedProcesses(ledger);
		} catch (error) {
			failures.push(error);
		}
	}
	ledgers.clear();
	await Promise.all(
		owned.map(({ started }) =>
			started.then(
				(platform) => platform.stop(),
				() => undefined,
			),
		),
	);
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
	if (failures.length > 0) throw failures[0];
}
