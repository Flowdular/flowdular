import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const PROCESS_GUARD = fileURLToPath(
	new URL('./platform-guard.mjs', import.meta.url),
);
/* From SIGTERM to SIGKILL, after a timeout here or in the guard once the
   launcher is gone. */
const STOP_GRACE_MS = 1_000;

export interface ProcessCommandOptions {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly timeoutMs: number;
	readonly outputLimit: number;
}

export interface ProcessCommandResult {
	readonly code: number | null;
	readonly output: string;
	readonly timedOut: boolean;
}

/* A command can start children of its own (pnpm and Git credential helpers do).
   On POSIX, give it a process group so a timeout stops the whole command tree.
   The group outlives the launcher, so the guard that leads it stops it when
   the launcher ends without doing so (SIGKILL, a closed terminal, a crash).
   Keep draining both pipes even when output is intentionally discarded. */
export function runBoundedProcess(
	command: string,
	args: readonly string[],
	options: ProcessCommandOptions,
): Promise<ProcessCommandResult> {
	return new Promise((resolvePromise) => {
		let output = '';
		let timedOut = false;
		let settled = false;
		let childClosed = false;
		let termTimer: NodeJS.Timeout | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		let deadline: NodeJS.Timeout | undefined;
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			clearTimeout(termTimer);
			clearTimeout(killTimer);
			resolvePromise({ code: timedOut ? null : code, output, timedOut });
		};
		let child;
		try {
			/* spawn's typed stdio tuples have no 'ipc' slot. */
			child = spawn(
				process.execPath,
				[PROCESS_GUARD, String(STOP_GRACE_MS), command, ...args],
				{
					cwd: options.cwd,
					env: options.env,
					stdio: ['ipc', 'pipe', 'pipe'],
					detached: process.platform !== 'win32',
				},
			) as ChildProcessByStdio<null, Readable, Readable>;
		} catch (error) {
			resolvePromise({
				code: null,
				output: error instanceof Error ? error.message : '',
				timedOut: false,
			});
			return;
		}
		const append = (chunk: string) => {
			if (options.outputLimit === 0) return;
			output = (output + chunk).slice(-options.outputLimit);
		};
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', append);
		child.stderr.on('data', append);
		const signal = (name: NodeJS.Signals) => {
			if (process.platform === 'win32') {
				/* No process groups: end the guard's whole tree. */
				if (child.pid !== undefined)
					spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
						stdio: 'ignore',
						windowsHide: true,
					}).once('error', () => undefined);
				return;
			}
			if (child.pid !== undefined) {
				try {
					process.kill(-child.pid, name);
					return;
				} catch {
					/* The group may already have exited. Try the direct child too. */
				}
			}
			try {
				child.kill(name);
			} catch {
				/* A concurrent exit is harmless. */
			}
		};
		const groupIsRunning = () => {
			if (process.platform === 'win32' || child.pid === undefined)
				return !childClosed;
			try {
				process.kill(-child.pid, 0);
				return true;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code !== 'ESRCH';
			}
		};
		const finishIfStopped = () => {
			if (childClosed && !groupIsRunning()) finish(null);
		};
		/* The guard starts the command, so `spawn git ENOENT` arrives as a message. */
		let spawnError: string | null = null;
		child.on('message', (message) => {
			const report = message as { type?: unknown; message?: unknown } | null;
			if (report?.type === 'spawn-error' && typeof report.message === 'string')
				spawnError = report.message;
		});
		child.on('error', (error) => {
			append(error.message);
			if (!timedOut) finish(null);
		});
		child.on('close', (code) => {
			childClosed = true;
			if (timedOut) finishIfStopped();
			else if (spawnError !== null) {
				append(spawnError);
				finish(null);
			} else finish(code);
		});
		deadline = setTimeout(() => {
			timedOut = true;
			signal('SIGTERM');
			termTimer = setTimeout(() => {
				if (childClosed && !groupIsRunning()) {
					finish(null);
					return;
				}
				signal('SIGKILL');
				const cleanupDeadline = Date.now() + 1_000;
				const waitForGroup = () => {
					if (settled) return;
					if (childClosed && !groupIsRunning()) {
						finish(null);
						return;
					}
					/* A zombie or unkillable OS process cannot keep the launcher waiting forever. */
					if (Date.now() >= cleanupDeadline) {
						finish(null);
						return;
					}
					killTimer = setTimeout(waitForGroup, 25);
				};
				waitForGroup();
			}, STOP_GRACE_MS);
		}, options.timeoutMs);
	});
}
