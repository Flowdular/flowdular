import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BroadcastChannel } from 'node:worker_threads';
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
const SHUTDOWN_TIMEOUT_MS = 3_000;
/* Presentation is shared with the sandbox launcher so both terminals read the
   same way. This file keeps only what is specific to the platform. */
export {
	formatDevEvent,
	isClientDisconnectLog,
	shouldUseColor,
} from '@coreloom/dev-console';

export function withShutdownDeadline(promise, timeoutMs = SHUTDOWN_TIMEOUT_MS) {
	let timer;
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new Error(`Development server shutdown exceeded ${timeoutMs} ms.`),
				),
			timeoutMs,
		);
		timer.unref?.();
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export function parseDevArguments(arguments_) {
	let host = '0.0.0.0';
	let port = 4310;
	let verbose = process.env.CL_DEV_VERBOSE === 'true';
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
		['--silent', 'coreloom', 'module', 'sync', '--apply'],
		{
			cwd: resolve(appRoot, '..'),
			stdio: options.verbose ? 'inherit' : 'pipe',
		},
	);
	if (sync.status !== 0) {
		throw new Error(
			'Module composition sync failed. Run "pnpm coreloom module sync --apply" for details.',
		);
	}
	const restoreConsole = installOctaneConsoleBridge(options.verbose, useColor);
	const logger = createOctaneLogger(options.verbose, useColor);
	let server;
	let middleware = (_request, response) => {
		response.statusCode = 503;
		response.end('Development server is starting.');
	};
	const httpServer = createHttpServer((request, response) =>
		middleware(request, response),
	);
	try {
		server = await createServer({
			root: appRoot,
			configFile: resolve(appRoot, 'vite.config.ts'),
			customLogger: logger,
			clearScreen: false,
			server: {
				middlewareMode: true,
				host: options.host,
				port: options.port,
				strictPort: true,
				ws: { server: httpServer },
			},
		});
		middleware = server.middlewares;
		await new Promise((resolveListen, rejectListen) => {
			const onError = (error) => rejectListen(error);
			httpServer.once('error', onError);
			httpServer.listen(options.port, options.host, () => {
				httpServer.off('error', onError);
				resolveListen();
			});
		});
		const displayHost =
			options.host === '0.0.0.0' || options.host === '::'
				? 'localhost'
				: options.host;
		server.resolvedUrls = {
			local: [`http://${displayHost}:${options.port}/`],
			network: [],
		};
	} catch (error) {
		if (httpServer.listening) httpServer.close();
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

	let httpClosing;
	const closeHttpServer = () => {
		if (httpClosing) return httpClosing;
		httpClosing = new Promise((resolveClose, rejectClose) => {
			if (!httpServer.listening) {
				resolveClose();
				return;
			}
			httpServer.close((error) =>
				error ? rejectClose(error) : resolveClose(),
			);
		});
		return httpClosing;
	};
	const closeVite = server.close.bind(server);
	let closing;
	const onSignal = () => {
		void close().then(
			() => process.exit(0),
			(error) => {
				console.error(
					formatDevEvent(
						'error',
						error instanceof Error ? error.message : String(error),
						useColor,
					),
				);
				process.exit(1);
			},
		);
	};
	const close = () => {
		if (closing) return closing;
		closing = (async () => {
			process.off('SIGINT', onSignal);
			process.off('SIGTERM', onSignal);
			/* Vite may begin one last config evaluation while close tears down its
			   module runner. Refuse that boot before it can reopen databases. */
			process.env.CL_INTERNAL_PLATFORM_TERMINATING = 'true';
			console.log(
				`\n${formatDevEvent('process', 'Development server stopped.', useColor)}`,
			);
			try {
				/* Stop accepting requests before retiring their route generation. */
				const httpClose = closeHttpServer();
				const retirements = [];
				process.emit('coreloom:platform-runtime-retire', (retirement) =>
					retirements.push(retirement),
				);
				const channel = new BroadcastChannel(
					'coreloom.platform.runtime-lifecycle',
				);
				channel.postMessage({ type: 'retire-all' });
				try {
					await withShutdownDeadline(Promise.all([httpClose, ...retirements]));
					await new Promise((resolveRetirement) =>
						setTimeout(resolveRetirement, 100),
					);
				} finally {
					channel.close();
				}
				await withShutdownDeadline(Promise.resolve(closeVite()));
			} finally {
				restoreConsole();
			}
		})();
		return closing;
	};
	/* Do not replace server.close: Vite uses it internally during an in-process
	   restart and will continue serving afterwards. Signals use this terminal
	   path, which also retires the current platform generation. */
	process.once('SIGINT', onSignal);
	process.once('SIGTERM', onSignal);
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
