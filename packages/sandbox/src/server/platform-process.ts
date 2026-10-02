import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export interface PlatformProcess {
	readonly url: string;
	stop(): Promise<void>;
}

function probe(
	host: string,
	port: number,
	timeoutMs: number,
): Promise<boolean> {
	return new Promise((resolvePromise) => {
		const socket = connect({ host, port });
		const settle = (reachable: boolean) => {
			socket.removeAllListeners();
			socket.destroy();
			resolvePromise(reachable);
		};
		socket.setTimeout(timeoutMs);
		socket.once('connect', () => settle(true));
		socket.once('timeout', () => settle(false));
		socket.once('error', () => settle(false));
	});
}

export async function platformReachable(
	url: string,
	timeoutMs = 750,
): Promise<boolean> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	const hostname = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
	return await probe(
		hostname === 'localhost' ? '127.0.0.1' : hostname,
		Number(parsed.port || 80),
		timeoutMs,
	);
}

export async function findRunningPlatformUrl(
	port: number,
): Promise<string | null> {
	for (const host of ['127.0.0.1', '[::1]']) {
		const url = `http://${host}:${port}`;
		if (await platformReachable(url)) return url;
	}
	return null;
}

/* Readiness is a socket, not a log line. The platform prints its ready block
   only once it is serving, and a business user should not have to read it. */
export async function waitForPlatform(
	url: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (signal?.aborted) return false;
		if (await platformReachable(url)) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
	}
}

export interface StartPlatformOptions {
	readonly workspaceRoot: string;
	readonly port: number;
	readonly host?: string;
	readonly signal?: AbortSignal;
	readonly log?: (line: string) => void;
	readonly onExit?: (code: number | null) => void;
	/* The ready message is kept out of the launcher's own output; both servers
	   print a ready block and two interleaved ones read as one broken one. */
	readonly quiet?: boolean;
}

/* The sandbox is a client of a running application, which is why a business user
   needed two terminals before describing anything. The launcher starts the
   platform when nothing is already serving, waits for the socket, and stops the
   child when it exits, so one command is the whole setup.

   An already-running platform is left alone: a developer working on the platform
   keeps their server, and two writers on one database is worse than a slower
   start. */
export async function startPlatformProcess(
	options: StartPlatformOptions,
): Promise<PlatformProcess> {
	const url = `http://127.0.0.1:${options.port}`;
	if (options.signal?.aborted) throw new PlatformStartAbortedError();
	const existingUrl = await findRunningPlatformUrl(options.port);
	if (existingUrl) {
		options.log?.(`using the platform already serving on ${existingUrl}`);
		return { url: existingUrl, stop: async () => undefined };
	}
	if (options.signal?.aborted) throw new PlatformStartAbortedError();
	options.log?.('starting the platform (first run builds the database)');

	/* Vite's localhost resolution may bind IPv6 only on some hosts while this
	   launcher probes and connects to 127.0.0.1. Bind the address we advertise. */
	const args = [
		'dev',
		'--port',
		String(options.port),
		'--host',
		options.host ?? '127.0.0.1',
	];
	const child = spawn('pnpm', args, {
		cwd: options.workspaceRoot,
		env: { ...process.env, FORCE_COLOR: '0' },
		stdio: options.quiet ? 'ignore' : 'inherit',
		detached: process.platform !== 'win32',
	});
	let spawnError: Error | null = null;
	const closed = new Promise<void>((resolvePromise) => {
		child.once('error', (error) => {
			spawnError = error;
			resolvePromise();
		});
		child.once('close', () => resolvePromise());
		child.once('exit', (code) => {
			options.onExit?.(code);
		});
	});
	let stopPromise: Promise<void> | null = null;
	const stopChild = (): Promise<void> => {
		if (stopPromise) return stopPromise;
		stopPromise = (async () => {
			const active = () => {
				if (process.platform === 'win32' || !child.pid)
					return child.exitCode === null && child.signalCode === null;
				try {
					process.kill(-child.pid, 0);
					return true;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
					throw error;
				}
			};
			const kill = (signal: NodeJS.Signals) => {
				try {
					if (process.platform !== 'win32' && child.pid)
						process.kill(-child.pid, signal);
					else if (child.exitCode === null && child.signalCode === null)
						child.kill(signal);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
				}
			};
			kill('SIGTERM');
			const deadline = Date.now() + 3_000;
			while (active() && Date.now() < deadline) await delay(100);
			if (active()) kill('SIGKILL');
			const killDeadline = Date.now() + 2_000;
			while (active() && Date.now() < killDeadline) await delay(100);
		})();
		return stopPromise;
	};
	const startup = new AbortController();
	const abort = () => {
		startup.abort();
		/* Signal listeners elsewhere may exit the process before async cleanup
		   finishes. Send SIGTERM to the owned process group synchronously. */
		void stopChild().catch(() => undefined);
	};
	options.signal?.addEventListener('abort', abort, { once: true });
	try {
		const outcome = await Promise.race([
			waitForPlatform(url, 180_000, startup.signal).then((ready) =>
				ready ? 'ready' : 'timeout',
			),
			closed.then(() => 'exited'),
		]);
		if (options.signal?.aborted) {
			await stopChild();
			throw new PlatformStartAbortedError();
		}
		if (outcome !== 'ready') {
			await stopChild();
			throw spawnError ?? new PlatformStartError(url);
		}
	} finally {
		startup.abort();
		options.signal?.removeEventListener('abort', abort);
	}
	options.log?.(`platform ready on ${url}`);
	return {
		url,
		stop: stopChild,
	};
}

export class PlatformStartAbortedError extends Error {
	constructor() {
		super('Platform startup was cancelled.');
		this.name = 'PlatformStartAbortedError';
	}
}

export class PlatformStartError extends Error {
	constructor(readonly url: string) {
		super(
			`The platform did not start serving on ${url} within three minutes. Run \`pnpm dev\` in the workspace to see why.`,
		);
		this.name = 'PlatformStartError';
	}
}
