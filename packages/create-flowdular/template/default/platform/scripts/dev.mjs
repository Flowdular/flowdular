import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import {
	createOctaneLogger,
	installOctaneConsoleBridge,
	shouldUseColor,
	createTheme,
	printReady,
} from '@flowdular/sdk/dev-console';

const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
/* `pnpm dev -- --port 4396 --host 0.0.0.0` overrides vite.config.ts, so a
   second application runs beside the first one. */
const flag = (name) => {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
};
const port = Number(flag('--port'));
const host = flag('--host');
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

/* Closing without exiting lets octane.config.ts release the database on the
   same signal; the process ends once both have drained. */
const stop = () => void server.close().finally(restoreConsole);
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
