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
	/** Called after each owned boot, including the boot after first-run setup. */
	readonly onReady?: (state: {
		readonly url: string;
		readonly setup: boolean;
	}) => void | Promise<void>;
	/* The ready message is kept out of the launcher's own output; both servers
	   print a ready block and two interleaved ones read as one broken one. */
	readonly quiet?: boolean;
}

interface OwnedPlatform {
	readonly closed: Promise<{ readonly code: number | null }>;
	readonly spawnError: () => Error | null;
	stop(): Promise<void>;
}

function spawnPlatform(options: StartPlatformOptions): OwnedPlatform {
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
		env: {
			...process.env,
			FORCE_COLOR: '0',
			FD_SETUP_AUTO_RESTART: 'true',
			FD_SETUP_RESTART_EXIT_CODE: '75',
		},
		stdio: options.quiet ? 'ignore' : 'inherit',
		detached: process.platform !== 'win32',
	});
	let spawnError: Error | null = null;
	const closed = new Promise<{ readonly code: number | null }>((resolve) => {
		child.once('error', (error) => {
			spawnError = error;
			resolve({ code: null });
		});
		child.once('close', (code) => resolve({ code }));
		child.once('exit', (code) => options.onExit?.(code));
	});
	let stopPromise: Promise<void> | null = null;
	const stop = (): Promise<void> => {
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
	return { closed, spawnError: () => spawnError, stop };
}

async function platformMode(
	url: string,
	signal?: AbortSignal,
): Promise<'setup' | 'application' | null> {
	try {
		const response = await fetch(new URL('/setup', url), {
			headers: { accept: 'text/html' },
			redirect: 'manual',
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(2_000)])
				: AbortSignal.timeout(2_000),
		});
		await response.body?.cancel();
		if (
			response.status === 200 &&
			response.headers.get('x-flowdular-setup') === 'first-run'
		)
			return 'setup';
		if (response.status >= 500) return null;
		return 'application';
	} catch {
		return null;
	}
}

async function platformServesSetup(url: string): Promise<boolean> {
	return (await platformMode(url)) === 'setup';
}

async function waitForApplicationTransition(
	url: string,
	signal: AbortSignal,
): Promise<boolean> {
	/* Vite can rebuild its configuration in this process after the wizard
	   writes .env, without exiting pnpm dev. A bounded one-request poll catches
	   that handoff so the launcher can collect the credential it just prepared. */
	while (!signal.aborted) {
		try {
			await delay(1_000, undefined, { signal });
		} catch {
			return false;
		}
		if ((await platformMode(url, signal)) === 'application') return true;
	}
	return false;
}

async function waitForPortRelease(
	url: string,
	signal: AbortSignal,
): Promise<boolean> {
	const deadline = Date.now() + 10_000;
	while (!signal.aborted && Date.now() < deadline) {
		if (!(await platformReachable(url))) return true;
		await delay(200);
	}
	return false;
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
		try {
			await options.onReady?.({
				url: existingUrl,
				setup: await platformServesSetup(existingUrl),
			});
		} catch {
			options.log?.('platform ready callback failed');
		}
		return { url: existingUrl, stop: async () => undefined };
	}
	if (options.signal?.aborted) throw new PlatformStartAbortedError();
	options.log?.('starting the platform (first run builds the database)');
	const lifetime = new AbortController();
	let current: OwnedPlatform | null = null;
	let monitor: Promise<void> = Promise.resolve();
	let stopPromise: Promise<void> | null = null;
	const stop = (): Promise<void> => {
		if (stopPromise) return stopPromise;
		stopPromise = (async () => {
			lifetime.abort();
			await current?.stop();
			await monitor;
			options.signal?.removeEventListener('abort', abort);
		})();
		return stopPromise;
	};
	const abort = () => {
		/* Signal listeners elsewhere may exit before async cleanup finishes. */
		void stop().catch(() => undefined);
	};
	options.signal?.addEventListener('abort', abort, { once: true });
	const launch = async (): Promise<{
		readonly process: OwnedPlatform;
		readonly setup: boolean;
		readonly startedInSetup: boolean;
	}> => {
		if (lifetime.signal.aborted) throw new PlatformStartAbortedError();
		const owned = spawnPlatform(options);
		current = owned;
		const startup = new AbortController();
		const abortStartup = () => startup.abort();
		lifetime.signal.addEventListener('abort', abortStartup, { once: true });
		try {
			const outcome = await Promise.race([
				waitForPlatform(url, 180_000, startup.signal).then((ready) =>
					ready ? 'ready' : 'timeout',
				),
				owned.closed.then(() => 'exited'),
			]);
			if (lifetime.signal.aborted) throw new PlatformStartAbortedError();
			if (outcome !== 'ready')
				throw owned.spawnError() ?? new PlatformStartError(url);
		} catch (error) {
			await owned.stop();
			throw error;
		} finally {
			startup.abort();
			lifetime.signal.removeEventListener('abort', abortStartup);
		}
		const setup = await platformServesSetup(url);
		if (lifetime.signal.aborted) {
			await owned.stop();
			throw new PlatformStartAbortedError();
		}
		options.log?.(`platform ready on ${url}`);
		try {
			await options.onReady?.({ url, setup });
		} catch {
			/* A UI notification or credential collection failure must not kill an
			   otherwise healthy application, and may carry sensitive details. */
			options.log?.('platform ready callback failed');
		}
		return { process: owned, setup, startedInSetup: setup };
	};
	try {
		let active = await launch();
		monitor = (async () => {
			const maxSetupRestarts = 2;
			let restarts = 0;
			while (!lifetime.signal.aborted) {
				if (active.setup) {
					const transition = new AbortController();
					const signal = AbortSignal.any([lifetime.signal, transition.signal]);
					const outcome = await Promise.race([
						active.process.closed.then(() => 'exit'),
						waitForApplicationTransition(url, signal).then((changed) =>
							changed ? 'application' : 'cancelled',
						),
					]);
					transition.abort();
					if (outcome === 'application' && !lifetime.signal.aborted) {
						options.log?.('setup activated the full application');
						active = { ...active, setup: false };
						try {
							await options.onReady?.({ url, setup: false });
						} catch {
							options.log?.('platform ready callback failed');
						}
					}
				}
				const exit = await active.process.closed;
				if (lifetime.signal.aborted) return;
				const setupRestart =
					(active.setup && exit.code === 0) ||
					(active.startedInSetup && exit.code === 75);
				if (!setupRestart || restarts >= maxSetupRestarts) {
					options.log?.('the platform process stopped');
					return;
				}
				restarts++;
				/* The wizard's exit code still identifies its restart after Vite
				   begins serving the application in the same process. Stop its process
				   group before binding the same port again. */
				await active.process.stop();
				if (!(await waitForPortRelease(url, lifetime.signal))) {
					if (!lifetime.signal.aborted)
						options.log?.('the platform port stayed occupied after setup');
					return;
				}
				if (lifetime.signal.aborted) return;
				options.log?.('setup finished; restarting the platform');
				try {
					active = await launch();
				} catch (error) {
					if (!lifetime.signal.aborted)
						options.log?.(
							`the platform did not restart: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					return;
				}
			}
		})().catch((error: unknown) => {
			if (!lifetime.signal.aborted)
				options.log?.(
					`the platform restart failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
		});
		return { url, stop };
	} catch (error) {
		await stop();
		throw error;
	}
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
