#!/usr/bin/env node
import './register-types.mjs';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* The TypeScript loader must be installed before Node loads source modules.
   Static imports are loaded first, regardless of their order above. */
const [
	{ watchSandboxReloads },
	{ DEFAULT_REPOSITORY, BootstrapError, prepareWorkspace, workspaceTarget },
	{ cloneGitWorkspace },
	{ probeCommand },
	{ findRunningPlatformUrl, startPlatformProcess },
	{ collectProvisionedCredential, recordPlatformAddress },
	{ acquireWorkspaceLock },
	{ removeCrashLeftovers },
	{ flowdularStateDirectory },
	{ createServer },
	{
		createOctaneLogger,
		createTheme,
		formatDevEvent,
		installOctaneConsoleBridge,
		printReady,
		shouldUseColor,
	},
] = await Promise.all([
	import('../src/server/reload-log.ts'),
	import('../src/server/bootstrap.ts'),
	import('../src/server/git-workspace.ts'),
	import('@flowdular/coding-agent'),
	import('../src/server/platform-process.ts'),
	import('../src/server/provision-local.ts'),
	import('../src/server/workspace-lock.ts'),
	import('../src/server/sessions.ts'),
	import('@flowdular/kernel/runtime-config'),
	import('vite'),
	import('@flowdular/dev-console'),
]);

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
		connect: undefined,
		branch: undefined,
		ref: undefined,
		refArgument: false,
		repository: DEFAULT_REPOSITORY,
		repositoryArgument: false,
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
			if (inline !== undefined) {
				if (!inline) throw new Error(`--${name} requires a value.`);
				return inline;
			}
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
			options.refArgument = true;
			continue;
		}
		const repository = take('repository');
		if (repository !== undefined) {
			options.repository = repository;
			options.repositoryArgument = true;
			continue;
		}
		const connect = take('connect');
		if (connect !== undefined) {
			options.connect = connect;
			continue;
		}
		const branch = take('branch');
		if (branch !== undefined) {
			options.branch = branch;
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
	if (options.branch && !options.connect) {
		throw new Error('--branch requires --connect.');
	}
	if (
		options.connect &&
		(options.repositoryArgument ||
			options.refArgument ||
			options.bootstrap !== 'auto')
	) {
		throw new Error(
			'--connect cannot be combined with --repository, --ref, --bootstrap or --no-bootstrap.',
		);
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
  --connect <git-url>  Clone an existing Flowdular repository into a new workspace
  --branch <name>      Branch to clone with --connect (default: remote default)
  --ref <tag>         Clone a pinned Flowdular repository ref (legacy)
  --repository <url>  Clone this Flowdular repository (legacy)
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
async function resolveWorkspace(options) {
	if (options.connect) {
		const target = workspaceTarget(
			options.workspaceArgument,
			'flowdular',
			process.cwd(),
		);
		console.log(`  Connecting a Git workspace in ${target}`);
		const result = await cloneGitWorkspace({
			repository: options.connect,
			target,
			...(options.branch ? { branch: options.branch } : {}),
		});
		for (const step of result.steps) console.log(`  ok ${step}`);
		options.workspace = result.root;
		return;
	}
	const result = await prepareWorkspace(
		{
			cwd: process.cwd(),
			workspaceArgument: options.workspaceArgument,
			bootstrap: options.bootstrap,
			ref: options.ref ?? `v${sandboxVersion}`,
			repository: options.repository,
			version: sandboxVersion,
			cloneRepository: options.refArgument || options.repositoryArgument,
		},
		{
			probe: async (command) => (await probeCommand(command)).available,
			log: (line) => console.log(`  ${line}`),
		},
	);
	options.workspace = result.root;
}

/* Order matters and the embedded database decides it. PGlite is single-process,
   so nothing else can open the database while the application serves. The
   application therefore provisions the credential during its own boot, and this
   launcher collects it afterwards. That is what removes the pasted token from
   the business flow without adding a machine-callable endpoint. */
/* Whether this launcher is about to own the application decides if the
   application should prepare a credential, and where it serves is the address
   the whole sandbox reads. Asking separately keeps both decisions in one place
   instead of inferring them from a result. */
async function resolvePlatform(options) {
	const started = `http://127.0.0.1:${options.platformPort}`;
	if (options.platform === 'never') return { owned: false, url: started };
	/* --platform still uses an application already serving on the port, so
	   only an empty port means this launcher starts the one it records. */
	const running = await findRunningPlatformUrl(options.platformPort);
	return running
		? { owned: false, url: running }
		: { owned: true, url: started };
}

async function recordAddress(options, platform) {
	try {
		await recordPlatformAddress({
			workspaceRoot: options.workspace,
			platformUrl: platform.url,
			startedByLauncher: platform.owned,
		});
	} catch (error) {
		console.log(
			`  could not record the platform address: ${
				error instanceof Error ? error.message.split('\n')[0] : error
			}`,
		);
	}
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
async function startPlatform(options, signal, onReady) {
	if (options.platform === 'never') return null;
	return await startPlatformProcess({
		workspaceRoot: options.workspace,
		port: options.platformPort,
		signal,
		quiet: true,
		log: (line) => console.log(`  ${line}`),
		onReady,
	});
}

async function announceSetupAccess(workspaceRoot, url, announcedTokenDigests) {
	const path = join(flowdularStateDirectory(workspaceRoot), 'setup-token');
	const setupUrl = new URL('/setup', url).toString();
	try {
		const info = await lstat(path);
		if (
			!info.isFile() ||
			info.isSymbolicLink() ||
			(info.mode & 0o077) !== 0 ||
			info.size > 256
		)
			throw new Error('Setup token file is not private.');
		const token = (await readFile(path, 'utf8')).trim();
		if (!/^[A-Za-z0-9_-]{32,128}$/.test(token))
			throw new Error('Setup token file is invalid.');
		const digest = createHash('sha256').update(token).digest('hex');
		if (announcedTokenDigests.has(digest)) return;
		announcedTokenDigests.add(digest);
		/* This is a one-time operator instruction in the terminal. The token is
		   never put in the sandbox HTTP state, logs or browser response. */
		process.stdout.write(
			`  Open setup: ${setupUrl}\n  Setup token: ${token}\n`,
		);
	} catch {
		process.stdout.write(
			`  Open setup: ${setupUrl}\n  Setup token is unavailable here. Stop the sandbox and run \`pnpm dev\` in ${workspaceRoot} to read it in that terminal.\n`,
		);
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
	/* Deferred until the server is listening. Waiting for the application first
	   left the dashboard unavailable for as long as the application takes to boot,
	   and blocked every caller of the state endpoint behind it. The connection is
	   a background concern; the workspace is not. */
	let platform = null;
	let bringUpPlatform = async () => {};
	const platformStartController = new AbortController();
	let startup = Promise.resolve();
	let closing = false;
	let workspaceLock = null;
	const announcedTokenDigests = new Set();
	try {
		await resolveWorkspace(options);
		/* Taken before anything writes the workspace's sandbox state, and held
		   until this process exits, however it exits. */
		workspaceLock = await acquireWorkspaceLock(options.workspace);
		await removeCrashLeftovers(options.workspace);
		const resolvedPlatform = await resolvePlatform(options);
		/* Set before the child is spawned: the application reads it to decide
		   whether to prepare a credential at boot, and a child inherits the
		   environment as it exists at spawn, not as it ends up. */
		process.env.FD_SANDBOX_PROVISION = resolvedPlatform.owned
			? 'true'
			: 'false';
		await recordAddress(options, resolvedPlatform);
		bringUpPlatform = async () => {
			platform = await startPlatform(
				options,
				platformStartController.signal,
				async ({ url, setup }) => {
					if (platformStartController.signal.aborted) return;
					await collectAccess(options, url);
					if (setup)
						await announceSetupAccess(
							options.workspace,
							url,
							announcedTokenDigests,
						);
				},
			);
			if (!platform && !platformStartController.signal.aborted)
				await collectAccess(
					options,
					`http://127.0.0.1:${options.platformPort}`,
				);
		};
	} catch (error) {
		restoreEarly();
		await workspaceLock?.release().catch(() => undefined);
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
		/* Install shutdown before starting the child. Vite's status query below can
		   take time, and a signal in that window must still stop the application. */
		const close = async () => {
			if (closing) return;
			closing = true;
			platformStartController.abort();
			console.log(
				`\n${formatDevEvent('process', 'Sandbox stopped.', useColor)}`,
			);
			await startup;
			await server.close();
			if (platform) await platform.stop();
			restoreConsole();
			process.exit(0);
		};
		process.once('SIGINT', () => void close());
		process.once('SIGTERM', () => void close());
		/* The dashboard is answering now; the application is brought up behind it
		   and the connection settles on its own. */
		startup = bringUpPlatform().catch(async (error) => {
			if (!closing)
				console.log(
					`  the application did not start: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			if (platform) await platform.stop();
			platform = null;
		});
	} catch (error) {
		restoreConsole();
		if (platform) await platform.stop();
		await workspaceLock.release().catch(() => undefined);
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
