#!/usr/bin/env node
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import {
	createOctaneLogger,
	createTheme,
	formatDevEvent,
	installOctaneConsoleBridge,
	printReady,
	shouldUseColor,
	watchReloads,
} from '@coreloom/dev-console';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function parseSandboxArguments(argv = []) {
	const options = {
		host: '127.0.0.1',
		port: 4320,
		mode: 'loopback',
		workspace: process.cwd(),
		verbose: process.env.CL_SANDBOX_VERBOSE === 'true',
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--help' || argument === '-h') {
			options.help = true;
			continue;
		}
		if (argument === '--verbose' || argument === '-v') {
			options.verbose = true;
			continue;
		}
		const take = (name) => {
			const inline = argument.startsWith(`--${name}=`)
				? argument.slice(name.length + 3)
				: undefined;
			if (inline !== undefined) return inline;
			if (argument !== `--${name}`) return undefined;
			const value = argv[index + 1];
			if (!value || value.startsWith('--')) {
				throw new Error(`--${name} requires a value.`);
			}
			index += 1;
			return value;
		};
		const host = take('host');
		if (host !== undefined) {
			options.host = host;
			continue;
		}
		const port = take('port');
		if (port !== undefined) {
			options.port = Number(port);
			continue;
		}
		const workspace = take('workspace');
		if (workspace !== undefined) {
			options.workspace = resolve(workspace);
			continue;
		}
		const mode = take('mode');
		if (mode !== undefined) {
			if (mode !== 'loopback' && mode !== 'self-hosted') {
				throw new Error('--mode must be loopback or self-hosted.');
			}
			options.mode = mode;
			continue;
		}
		throw new Error(`Unknown sandbox option: ${argument}`);
	}
	if (
		!Number.isInteger(options.port) ||
		options.port < 1 ||
		options.port > 65535
	) {
		throw new Error('--port must be an integer between 1 and 65535.');
	}
	/* A sandbox that is not bound to a loopback interface cannot claim loopback
	   trust, so it runs with the self-hosted rules. */
	if (options.mode === 'loopback' && !isLoopbackHost(options.host)) {
		options.mode = 'self-hosted';
	}
	return options;
}

export function isLoopbackHost(host) {
	return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function printHelp() {
	console.log(`Coreloom sandbox

Usage: npx @coreloom/sandbox [options]

Options:
  --workspace <path>  Coreloom workspace to use (default: current directory)
  --host <host>       Bind address (default: 127.0.0.1)
  --port <port>       HTTP port (default: 4320)
  --mode <mode>       loopback or self-hosted (default: loopback)
  -v, --verbose       Show Vite and tool warnings
  -h, --help          Show this help`);
}

/* The ready block names what an operator needs before the first prompt: the
   application this sandbox is connected to and the coding agents this machine
   can actually offer. It reads the server that just started, so nothing is
   opened or probed twice. */
async function sandboxStatus(server, workspace) {
	const local = server.resolvedUrls?.local?.[0] ?? 'http://127.0.0.1:4320/';
	try {
		const state = await fetch(new URL('/sandbox/api/state', local), {
			headers: { accept: 'application/json' },
		}).then((response) => response.json());
		/* A self-hosted sandbox answers 401 until a browser signs in; the little
		   it says is still worth printing. */
		if (state.error) {
			return {
				platform: `${state.configuration?.platformUrl ?? 'not configured'} · sign in required`,
				connected: false,
				agents: 'after sign-in',
				hasAgents: false,
				sessions: 0,
			};
		}
		const offered = (state.drivers ?? [])
			.filter((driver) => driver.offered)
			.map((driver) => driver.label);
		const tenant =
			state.connection?.authority?.principal?.tenantName ?? 'connected';
		return {
			platform: state.connection?.connected
				? `${state.configuration.platformUrl} · ${tenant}`
				: `${state.configuration?.platformUrl ?? 'not configured'} · not connected`,
			connected: Boolean(state.connection?.connected),
			agents: offered.length > 0 ? offered.join(' · ') : 'none available',
			hasAgents: offered.length > 0,
			sessions: (state.sessions ?? []).length,
		};
	} catch {
		return {
			platform: 'unavailable',
			connected: false,
			agents: 'unknown',
			hasAgents: false,
			sessions: 0,
		};
	}
}

export async function startSandbox(argv = process.argv.slice(2)) {
	const options = parseSandboxArguments(argv);
	const useColor = shouldUseColor();
	const theme = createTheme(useColor);
	if (options.help) {
		printHelp(theme);
		return null;
	}
	process.env.CL_SANDBOX_WORKSPACE = options.workspace;
	process.env.CL_SANDBOX_MODE = options.mode;
	process.env.CL_SANDBOX_PORT = String(options.port);

	const startedAt = performance.now();
	const restoreConsole = installOctaneConsoleBridge(options.verbose, useColor);
	const logger = createOctaneLogger(options.verbose, useColor);
	let server;
	try {
		server = await createServer({
			root: appRoot,
			configFile: resolve(appRoot, 'vite.config.ts'),
			customLogger: logger,
			clearScreen: false,
			server: { host: options.host, port: options.port, strictPort: true },
		});
		await server.listen();
	} catch (error) {
		restoreConsole();
		throw error;
	}

	const status = await sandboxStatus(server, options.workspace);
	printReady({
		title: 'CORELOOM SANDBOX',
		subtitle: 'agentic workspace',
		theme,
		lines: [
			['ready', `${Math.round(performance.now() - startedAt)} ms`, 'success'],
			[
				'local',
				server.resolvedUrls?.local?.[0] ??
					`http://${options.host}:${options.port}/`,
				'info',
			],
			...(server.resolvedUrls?.network ?? []).map((url) => [
				'network',
				url,
				'info',
			]),
			[
				'mode',
				options.mode,
				options.mode === 'loopback' ? 'success' : 'warning',
			],
			['workspace', options.workspace, 'muted'],
			[
				'sessions',
				status.sessions === 1 ? '1 open' : `${status.sessions} open`,
				'text',
			],
			['platform', status.platform, status.connected ? 'success' : 'warning'],
			['agents', status.agents, status.hasAgents ? 'success' : 'warning'],
			['reload', 'TSRX · TypeScript · CSS', 'info'],
			[
				'diagnostics',
				options.verbose ? 'verbose' : 'quiet · use --verbose',
				options.verbose ? 'warning' : 'muted',
			],
		],
	});

	watchReloads(server, appRoot, useColor);

	const close = async () => {
		console.log(`\n${formatDevEvent('process', 'Sandbox stopped.', useColor)}`);
		await server.close();
		restoreConsole();
		process.exit(0);
	};
	process.once('SIGINT', () => void close());
	process.once('SIGTERM', () => void close());
	return server;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	startSandbox().catch((error) => {
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
