import { spawn } from 'node:child_process';

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
			child = spawn(command, [...args], {
				cwd: options.cwd,
				env: options.env,
				stdio: ['ignore', 'pipe', 'pipe'],
				detached: process.platform !== 'win32',
			});
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
			if (process.platform !== 'win32' && child.pid !== undefined) {
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
		child.on('error', (error) => {
			append(error.message);
			if (!timedOut) finish(null);
		});
		child.on('close', (code) => {
			childClosed = true;
			if (timedOut) finishIfStopped();
			else finish(code);
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
			}, 1_000);
		}, options.timeoutMs);
	});
}
