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
			server.resolvedUrls?.local?.[0] ?? 'http://localhost:4310/',
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
