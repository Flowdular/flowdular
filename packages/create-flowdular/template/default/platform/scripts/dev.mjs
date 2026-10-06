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
	stopOnSignals,
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

let server;
try {
	server = await createServer({
		root: appRoot,
		configFile: resolve(appRoot, 'vite.config.ts'),
		customLogger: createOctaneLogger(verbose, color),
		clearScreen: false,
		...(Number.isInteger(port) && port > 0
			? { server: { port, strictPort: true, ...(host ? { host } : {}) } }
			: host
				? { server: { host } }
				: {}),
	});
	await server.listen();
} catch (error) {
	restoreConsole();
	throw error;
}
printReady({
	title: 'FLOWDULAR',
	subtitle: 'development workspace',
	theme: createTheme(color),
	lines: [
		[
			'local',
			server.resolvedUrls?.local?.[0] ??
				server.resolvedUrls?.network?.[0] ??
				'the address vite.config.ts sets',
			'info',
		],
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

const localUrl = server.resolvedUrls?.local?.[0];
if (localUrl && !process.argv.includes('--no-open')) {
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

/* Closing without exiting lets octane.config.ts release the database on the
   same signal; the process ends once both have drained. */
const stop = () => void server.close().finally(restoreConsole);
stopOnSignals(stop, { deadlineMs: PLATFORM_SHUTDOWN_BUDGET_MS });
