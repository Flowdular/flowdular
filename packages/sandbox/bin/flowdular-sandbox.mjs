#!/usr/bin/env node
import './register-types.mjs';
import { watchSandboxReloads } from '../src/server/reload-log.ts';
import {
	DEFAULT_REPOSITORY,
	BootstrapError,
	assertBootstrapPrerequisites,
	assertRefIsPinned,
	assertTargetIsSafe,
	bootstrapWorkspace,
	directoryEntries,
	workspaceTarget,
} from '../src/server/bootstrap.ts';
import { probeCommand } from '@flowdular/coding-agent';
import {
	platformReachable,
	startPlatformProcess,
} from '../src/server/platform-process.ts';
import { collectProvisionedCredential } from '../src/server/provision-local.ts';
import process from 'node:process';
import { realpathSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import {
	createOctaneLogger,
	createTheme,
	formatDevEvent,
	installOctaneConsoleBridge,
	printReady,
	shouldUseColor,
} from '@flowdular/dev-console';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* Bootstrap defaults to the tag this package was published from, so the
   repository a business user clones is the one this build was tested against. */
const { version: sandboxVersion } = await readJson(
	new URL('../package.json', import.meta.url),
);

/* The console bridge is installed later; before that a failure just prints. */
function restoreEarly() {}

async function readJson(url) {
	return JSON.parse(await readFile(url, 'utf8'));
}

export function parseSandboxArguments(argv = []) {
	const options = {
		host: '127.0.0.1',
		port: 4320,
		mode: 'loopback',
		workspace: process.cwd(),
		workspaceArgument: undefined,
		ref: undefined,
		repository: DEFAULT_REPOSITORY,
		bootstrap: 'auto',
		platform: 'auto',
		platformPort: 4310,
		verbose: process.env.FD_SANDBOX_VERBOSE === 'true',
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
		if (argument === '--no-platform') {
			options.platform = 'never';
			continue;
		}
		if (argument === '--platform') {
			options.platform = 'always';
			continue;
		}
		const platformPort = take('platform-port');
		if (platformPort !== undefined) {
			options.platformPort = Number(platformPort);
			continue;
		}
		if (argument === '--no-bootstrap') {
			options.bootstrap = 'never';
			continue;
		}
		if (argument === '--bootstrap') {
			options.bootstrap = 'always';
			continue;
		}
		const ref = take('ref');
		if (ref !== undefined) {
			options.ref = ref;
			continue;
		}
		const repository = take('repository');
		if (repository !== undefined) {
			options.repository = repository;
			continue;
		}
		const workspace = take('workspace');
		if (workspace !== undefined) {
			options.workspaceArgument = workspace;
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
	console.log(`Flowdular sandbox

Usage: npx @flowdular/sandbox [options]

Options:
  --workspace <path>  Flowdular workspace to use, or a new one to create here
                      (default: the nearest workspace, else ./flowdular)
  --bootstrap         Create a workspace even when one was found
  --no-bootstrap      Fail instead of creating a workspace when none is found
  --ref <tag>         Version tag or commit to bootstrap (default: this package version)
  --repository <url>  Repository to bootstrap from (default: Flowdular/flowdular)
  --platform          Start the application as well (default when none is serving)
  --no-platform       Never start the application; connect to a running one
  --platform-port <n> Port for the application this launcher starts (default: 4310)
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

/* A business user arrives with an empty directory, so the sandbox either runs
   against the workspace it finds or creates one first. Refusing silently is not
   an option: the whole promise is that describing an idea needs no checkout. */
async function resolveWorkspace(options, theme) {
	const exists = async (path) => {
		try {
			await access(path);
			return true;
		} catch {
			return false;
		}
	};
	if (options.bootstrap !== 'never' && !(await exists(options.workspace))) {
		const ref = options.ref ?? `v${sandboxVersion}`;
		assertRefIsPinned(ref);
		const target = workspaceTarget(options.workspaceArgument, 'flowdular');
		await assertBootstrapPrerequisites(
			async (command) => (await probeCommand(command)).available,
		);
		await assertTargetIsSafe(target, exists, directoryEntries);
		console.log(`\nNo Flowdular workspace found. Creating one in ${target}`);
		const result = await bootstrapWorkspace({
			target,
			ref,
			repository: options.repository,
			log: (line) => console.log(`  ${line}`),
		});
		for (const step of result.steps) console.log(`  ok ${step}`);
		options.workspace = result.root;
	}
	if (options.bootstrap === 'always' && (await exists(options.workspace)))
		throw new Error(
			`--bootstrap was given but ${options.workspace} is already a workspace.`,
		);
}

/* Order matters and the embedded database decides it. PGlite is single-process,
   so nothing else can open the database while the application serves. The
   application therefore provisions the credential during its own boot, and this
   launcher collects it afterwards. That is what removes the pasted token from
   the business flow without adding a machine-callable endpoint. */
/* Whether this launcher is about to own the application decides if the
   application should prepare a credential. Asking separately keeps the decision
   in one place instead of inferring it from a result. */
async function willStartPlatform(options) {
	if (options.platform === 'never') return false;
	if (options.platform === 'always') return true;
	return !(await platformReachable(`http://127.0.0.1:${options.platformPort}`));
}

async function collectAccess(options, platformUrl) {
	try {
		await collectProvisionedCredential({
			workspaceRoot: options.workspace,
			platformUrl,
			log: (line) => console.log(`  ${line}`),
		});
	} catch (error) {
		console.log(
			`  could not read the prepared credential: ${
				error instanceof Error ? error.message.split('\n')[0] : error
			}`,
		);
	}
}

/* One command is the whole setup. The sandbox is a client of a running
   application, so a business user used to need a second terminal before they
   could describe anything. An application already serving is left alone. */
async function startPlatform(options) {
	if (options.platform === 'never') return null;
	const url = `http://127.0.0.1:${options.platformPort}`;
	if (options.platform !== 'always' && (await platformReachable(url)))
		return null;
	return await startPlatformProcess({
		workspaceRoot: options.workspace,
		port: options.platformPort,
		quiet: true,
		log: (line) => console.log(`  ${line}`),
	});
}

export async function startSandbox(argv = process.argv.slice(2)) {
	const options = parseSandboxArguments(argv);
	const useColor = shouldUseColor();
	const theme = createTheme(useColor);
	if (options.help) {
		printHelp(theme);
		return null;
	}
	/* Deferred until the server is listening. Waiting for the application first
	   left the dashboard unavailable for as long as the application takes to boot,
	   and blocked every caller of the state endpoint behind it. The connection is
	   a background concern; the workspace is not. */
	let bringUpPlatform = async () => {};
	try {
		await resolveWorkspace(options, theme);
		const ownsPlatform = await willStartPlatform(options);
		/* Set before the child is spawned: the application reads it to decide
		   whether to prepare a credential at boot, and a child inherits the
		   environment as it exists at spawn, not as it ends up. */
		process.env.FD_SANDBOX_PROVISION = ownsPlatform ? 'true' : 'false';
		bringUpPlatform = async () => {
			platform = await startPlatform(options);
			await collectAccess(options, `http://127.0.0.1:${options.platformPort}`);
		};
	} catch (error) {
		restoreEarly();
		if (error instanceof BootstrapError) console.error(`\n${error.message}\n`);
		else console.error(`\n${error instanceof Error ? error.message : error}\n`);
		process.exitCode = 1;
		return null;
	}
	process.env.FD_SANDBOX_WORKSPACE = options.workspace;
	process.env.FD_SANDBOX_MODE = options.mode;
	process.env.FD_SANDBOX_PORT = String(options.port);

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
		/* The dashboard is answering now; the application is brought up behind it
		   and the connection settles on its own. */
		void bringUpPlatform().catch((error) => {
			console.log(
				`  the application did not start: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			if (platform) void platform.stop();
			platform = null;
		});
	} catch (error) {
		restoreConsole();
		if (platform) await platform.stop();
		throw error;
	}

	const status = await sandboxStatus(server, options.workspace);
	printReady({
		title: 'FLOWDULAR SANDBOX',
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

	watchSandboxReloads(
		server,
		appRoot,
		(message) => console.log(formatDevEvent('reload', message, useColor)),
		options.verbose,
	);

	const close = async () => {
		console.log(`\n${formatDevEvent('process', 'Sandbox stopped.', useColor)}`);
		await server.close();
		/* The application this launcher started belongs to this process. Leaving
		   it running would hold a port and a database handle after the operator
		   believed everything had stopped. */
		if (platform) await platform.stop();
		restoreConsole();
		process.exit(0);
	};
	process.once('SIGINT', () => void close());
	process.once('SIGTERM', () => void close());
	return server;
}

if (
	process.argv[1] &&
	realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)
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
