import { createServer as createHttpServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'vite';
import {
	createOctaneLogger,
	installOctaneConsoleBridge,
	shouldUseColor,
	createTheme,
	printReady,
} from '@flowdular/sdk/dev-console';
import {
	PLATFORM_SHUTDOWN_BUDGET_MS,
	retirePlatformRuntimes,
	stopOnSignals,
	stopServing,
} from '@flowdular/sdk/dev-console/shutdown';

const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
/* `pnpm dev -- --port 4396 --host 0.0.0.0` overrides vite.config.ts, so a
   second application runs beside the first one. */
const flag = (name) => {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
};
const port = Number(flag('--port'));
const host = flag('--host');
if (Number.isInteger(port) && port > 0) process.env.PORT = String(port);
const verbose =
	process.argv.includes('--verbose') ||
	process.argv.includes('-v') ||
	process.env.FD_DEV_VERBOSE === 'true';
const color = shouldUseColor();
const restoreConsole = installOctaneConsoleBridge(verbose, color);

/* Vite serves in middleware mode behind this server. A Vite that listens
   itself exits the process on SIGTERM as soon as it has closed, before
   octane.config.ts has released its databases. */
let server;
const httpServer = createHttpServer((request, response) =>
	server.middlewares(request, response),
);
let localUrl;
try {
	server = await createServer({
		root: appRoot,
		configFile: resolve(appRoot, 'vite.config.ts'),
		customLogger: createOctaneLogger(verbose, color),
		clearScreen: false,
		server: {
			middlewareMode: true,
			ws: { server: httpServer },
			...(Number.isInteger(port) && port > 0 ? { port, strictPort: true } : {}),
			...(host ? { host } : {}),
		},
	});
	/* The address Vite would have bound: vite.config.ts or the flags above,
	   and localhost when neither names a host. */
	const listenPort = server.config.server.port;
	const configuredHost = server.config.server.host;
	const listenHost =
		configuredHost === true ? undefined : configuredHost || 'localhost';
	await new Promise((resolveListen, rejectListen) => {
		httpServer.once('error', rejectListen);
		httpServer.listen(listenPort, listenHost, () => {
			httpServer.off('error', rejectListen);
			resolveListen();
		});
	});
	const displayHost =
		listenHost === undefined || listenHost === '0.0.0.0' || listenHost === '::'
			? 'localhost'
			: listenHost;
	localUrl = `http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${listenPort}/`;
} catch (error) {
	if (httpServer.listening) httpServer.close();
	restoreConsole();
	throw error;
}

/* The process ends on its own once every runtime generation has released
   what it holds, so one that was still preparing when the stop arrived
   drains as well; the deadline bounds the wait. */
async function stop() {
	process.env.FD_INTERNAL_PLATFORM_TERMINATING = 'true';
	try {
		await Promise.all([
			stopServing(httpServer, server),
			retirePlatformRuntimes(),
		]);
	} finally {
		await server.close();
		restoreConsole();
	}
}
stopOnSignals(
	() =>
		void stop().catch((error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}),
	{ deadlineMs: PLATFORM_SHUTDOWN_BUDGET_MS },
);

printReady({
	title: 'FLOWDULAR',
	subtitle: 'development workspace',
	theme: createTheme(color),
	lines: [
		['local', localUrl, 'info'],
		['diagnostics', verbose ? 'verbose' : 'quiet · use --verbose', 'muted'],
	],
});

function openBrowser(url) {
	if (
		process.platform === 'linux' &&
		!process.env.DISPLAY &&
		!process.env.WAYLAND_DISPLAY
	)
		return false;
	const command =
		process.platform === 'darwin'
			? 'open'
			: process.platform === 'win32'
				? 'rundll32.exe'
				: 'xdg-open';
	const args =
		process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
	const result = spawnSync(command, args, { stdio: 'ignore', timeout: 10000 });
	return !result.error && result.status === 0;
}

if (!process.argv.includes('--no-open')) {
	const setupUrl = new URL('/setup', localUrl).href;
	try {
		const response = await fetch(setupUrl, {
			signal: AbortSignal.timeout(30000),
		});
		if (response.ok && (await response.text()).includes('setup-page')) {
			console.log(`First-run setup: ${setupUrl}`);
			if (!openBrowser(setupUrl))
				console.log('Open the setup URL in a browser on this workstation.');
		}
	} catch {
		// The server remains usable when a browser is unavailable.
	}
}
