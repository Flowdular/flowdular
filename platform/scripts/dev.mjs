import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import {
	createOctaneLogger,
	createTheme,
	formatDevEvent,
	installOctaneConsoleBridge,
	printReady as printReadyBlock,
	shouldUseColor,
	watchReloads,
} from '@coreloom/dev-console';

const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
/* Presentation is shared with the sandbox launcher so both terminals read the
   same way. This file keeps only what is specific to the platform. */
export {
	formatDevEvent,
	isClientDisconnectLog,
	shouldUseColor,
} from '@coreloom/dev-console';

export function parseDevArguments(arguments_) {
	let host = '0.0.0.0';
	let port = 4310;
	let verbose = process.env.OERP_DEV_VERBOSE === 'true';
	let help = false;
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === '--') continue;
		if (argument === '--verbose' || argument === '-v') {
			verbose = true;
			continue;
		}
		if (argument === '--help' || argument === '-h') {
			help = true;
			continue;
		}
		if (argument === '--host' || argument?.startsWith('--host=')) {
			const value =
				argument === '--host'
					? arguments_[index + 1]
					: argument.slice('--host='.length);
			if (!value || value.startsWith('--')) {
				throw new Error('--host requires a value.');
			}
			host = value;
			if (argument === '--host') index += 1;
			continue;
		}
		if (argument === '--port' || argument?.startsWith('--port=')) {
			const value =
				argument === '--port'
					? arguments_[index + 1]
					: argument.slice('--port='.length);
			if (!value || value.startsWith('--')) {
				throw new Error('--port requires a value.');
			}
			port = Number(value);
			if (argument === '--port') index += 1;
			continue;
		}
		throw new Error(`Unknown development option: ${argument}`);
	}
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error('--port must be an integer between 1 and 65535.');
	}
	return { help, host, port, verbose };
}

function printHelp(theme) {
	console.log(`${theme.brand('Coreloom')} ${theme.muted('development server')}

${theme.label('Usage:')} ${theme.text('pnpm dev -- [options]')}

${theme.label('Options:')}
  ${theme.info('--host <host>')}  Bind address ${theme.muted('(default: 0.0.0.0)')}
  ${theme.info('--port <port>')}  HTTP port ${theme.muted('(default: 4310)')}
  ${theme.info('-v, --verbose')}  Show Vite and tool warnings
  ${theme.info('-h, --help')}     Show this help`);
}

function printReady(server, elapsedMs, verbose, theme) {
	const local = server.resolvedUrls?.local?.[0] ?? 'http://localhost:4310/';
	printReadyBlock({
		title: 'CORELOOM',
		subtitle: 'development workspace',
		theme,
		lines: [
			['ready', `${elapsedMs} ms`, 'success'],
			['local', local, 'info'],
			...(server.resolvedUrls?.network ?? []).map((url) => [
				'network',
				url,
				'info',
			]),
			['auth', 'auth.core · SQLite · local session', 'success'],
			['reload', 'TSRX · TypeScript · CSS', 'info'],
			[
				'diagnostics',
				verbose ? 'verbose' : 'quiet · use --verbose',
				verbose ? 'warning' : 'muted',
			],
		],
	});
}

export async function startDevelopmentServer(
	arguments_ = process.argv.slice(2),
) {
	const options = parseDevArguments(arguments_);
	const useColor = shouldUseColor();
	const theme = createTheme(useColor);
	if (options.help) {
		printHelp(theme);
		return null;
	}
	const startedAt = performance.now();
	// Regenerate the module composition so enabling a module never requires
	// editing platform files by hand.
	const sync = spawnSync(
		'pnpm',
		['--silent', 'oerp', 'module', 'sync', '--apply'],
		{
			cwd: resolve(appRoot, '..'),
			stdio: options.verbose ? 'inherit' : 'pipe',
		},
	);
	if (sync.status !== 0) {
		throw new Error(
			'Module composition sync failed. Run "pnpm oerp module sync --apply" for details.',
		);
	}
	const restoreConsole = installOctaneConsoleBridge(options.verbose, useColor);
	const logger = createOctaneLogger(options.verbose, useColor);
	let server;
	try {
		server = await createServer({
			root: appRoot,
			configFile: resolve(appRoot, 'vite.config.ts'),
			customLogger: logger,
			clearScreen: false,
			server: {
				host: options.host,
				port: options.port,
				strictPort: true,
			},
		});
		await server.listen();
	} catch (error) {
		restoreConsole();
		throw error;
	}
	printReady(
		server,
		Math.round(performance.now() - startedAt),
		options.verbose,
		theme,
	);

	watchReloads(server, appRoot, useColor);

	const close = async () => {
		console.log(
			`\n${formatDevEvent('process', 'Development server stopped.', useColor)}`,
		);
		await server.close();
		restoreConsole();
	};
	process.once('SIGINT', () => void close());
	process.once('SIGTERM', () => void close());
	return server;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	startDevelopmentServer().catch((error) => {
		console.error(
			formatDevEvent(
				'error',
				error instanceof Error ? error.message : String(error),
			),
		);
		if (process.argv.includes('--verbose') && error instanceof Error) {
			console.error(error.stack);
		}
		process.exitCode = 1;
	});
}
