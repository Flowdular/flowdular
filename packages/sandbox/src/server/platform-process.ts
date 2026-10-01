import { spawn } from 'node:child_process';
import { connect } from 'node:net';

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
	return await probe(
		parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname,
		Number(parsed.port || 80),
		timeoutMs,
	);
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
	if (await platformReachable(url)) {
		options.log?.(`using the platform already serving on ${url}`);
		return { url, stop: async () => undefined };
	}
	options.log?.('starting the platform (first run builds the database)');

	const args = ['dev', '--port', String(options.port)];
	if (options.host) args.push('--host', options.host);
	const child = spawn('pnpm', args, {
		cwd: options.workspaceRoot,
		env: { ...process.env, FORCE_COLOR: '0' },
		stdio: options.quiet ? ['ignore', 'ignore', 'pipe'] : 'inherit',
	});
	/* Resolves when the child is gone, so stop() can wait for the port to be
	   released instead of assuming SIGTERM was enough. */
	const exited = new Promise<void>((resolvePromise) => {
		child.once('exit', (code) => {
			options.onExit?.(code);
			resolvePromise();
		});
	});

	const ready = await waitForPlatform(url, 180_000);
	if (!ready) {
		child.kill('SIGTERM');
		throw new PlatformStartError(url);
	}
	options.log?.(`platform ready on ${url}`);
	return {
		url,
		stop: async () => {
			if (!child || child.exitCode !== null) return;
			child.kill('SIGTERM');
			await Promise.race([
				exited,
				new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000)),
			]);
			if (child.exitCode === null) child.kill('SIGKILL');
		},
	};
}

export class PlatformStartError extends Error {
	constructor(readonly url: string) {
		super(
			`The platform did not start serving on ${url} within three minutes. Run \`pnpm dev\` in the workspace to see why.`,
		);
		this.name = 'PlatformStartError';
	}
}
