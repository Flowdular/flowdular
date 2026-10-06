import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { flowdularStateDirectory } from '@flowdular/kernel/runtime-config';
import {
	holdsLauncherCredential,
	loadSandboxConfiguration,
	sealSecret,
	secretFingerprint,
	updateSandboxConfiguration,
} from './config.ts';

export class ProvisionError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'ProvisionError';
	}
}

export interface ProvisionedCredential {
	readonly platformTenantId: string;
	readonly email: string;
	readonly token: string;
	readonly capabilities: readonly string[];
}

export interface ProvisionOptions {
	readonly workspaceRoot: string;
	/* Where the CLI writes the credential. Kept inside the sandbox state
	   directory so the launcher owns its lifetime and its permissions. */
	readonly credentialsPath: string;
	readonly log?: (line: string) => void;
	readonly signal?: AbortSignal;
}

const OUTPUT_LIMIT = 8_000;
/* Matches the delivery runner: the CLI needs the deployment environment to
   reach the database, and it must not inherit an agent's environment. */
function commandEnvironment(source: NodeJS.ProcessEnv = process.env) {
	const env: NodeJS.ProcessEnv = {};
	for (const name of [
		'HOME',
		'LANG',
		'LC_ALL',
		'PATH',
		'SHELL',
		'TMPDIR',
		'USER',
	])
		env[name] = source[name];
	for (const name of Object.keys(source)) {
		if (/^(?:DATABASE_URL|FD_|PG[A-Z]*|NODE_|POSTGRES)/.test(name))
			env[name] = source[name];
	}
	env.FORCE_COLOR = '0';
	return env;
}

function run(
	command: string,
	args: readonly string[],
	cwd: string,
	options: {
		readonly env: NodeJS.ProcessEnv;
		readonly signal: AbortSignal | undefined;
	},
): Promise<{ readonly code: number | null; readonly output: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn(command, [...args], {
			cwd,
			env: options.env,
			stdio: ['ignore', 'pipe', 'pipe'],
			signal: options.signal,
		});
		let output = '';
		const append = (chunk: string) => {
			output = (output + chunk).slice(-OUTPUT_LIMIT);
		};
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', append);
		child.stderr.on('data', append);
		child.on('error', (error) =>
			resolvePromise({ code: null, output: error.message }),
		);
		child.on('close', (code) => resolvePromise({ code, output }));
	});
}

/* A business user arriving at an empty workspace used to have to open the
   application, sign in, create an API token with three scopes, paste it into
   the sandbox and grant itself sandbox access. That is five steps of setup
   before describing a first idea, and none of them is a business decision.

   The platform's own CLI already performs each of them from the host, so the
   launcher does the same and stores the result where it stores every other
   secret. The token is written to a 0600 file inside the sandbox state
   directory, read once, sealed, and the file is removed: it never reaches a
   terminal, a log or a transcript. */

export async function provisionLocalAccess(
	options: ProvisionOptions,
): Promise<ProvisionedCredential> {
	const log = options.log ?? (() => undefined);
	const password = randomBytes(24).toString('base64url');
	const result = await run(
		'pnpm',
		[
			'--dir',
			options.workspaceRoot,
			'--silent',
			'flowdular',
			'sandbox',
			'provision',
			'--credentials-file',
			options.credentialsPath,
			'--password-env',
			'FLOWDULAR_SANDBOX_OWNER_PASSWORD',
			'--apply',
			'--json',
		],
		options.workspaceRoot,
		{
			env: {
				...commandEnvironment(),
				FLOWDULAR_SANDBOX_OWNER_PASSWORD: password,
			},
			signal: options.signal,
		},
	);

	let credential: ProvisionedCredential | null = null;
	try {
		credential = await readCredential(options.credentialsPath);
	} catch {
		credential = null;
	}
	/* The file is removed whatever happened: a failed provision must not leave a
	   live credential lying in the state directory. */
	await rm(options.credentialsPath, { force: true });

	if (credential) {
		log(
			`connected to ${credential.email} with ${credential.capabilities.length} scope(s)`,
		);
		return credential;
	}
	if (result.code === 1 && /already exists/i.test(result.output)) {
		throw new ProvisionError(
			'PROVISION_TOKEN_EXISTS',
			'A sandbox token already exists for this workspace. Reuse it, or revoke it with `pnpm flowdular sandbox access` before provisioning again.',
		);
	}
	throw new ProvisionError(
		'PROVISION_FAILED',
		[
			'The sandbox could not prepare its own access to the platform.',
			result.output.trim().slice(-2_000) ||
				'`pnpm flowdular sandbox provision --apply` produced no output.',
		].join('\n'),
	);
}

async function readCredential(path: string): Promise<ProvisionedCredential> {
	const raw = await readFile(path, 'utf8');
	const value = JSON.parse(raw) as Partial<ProvisionedCredential>;
	if (typeof value.token !== 'string' || value.token.length < 8)
		throw new Error('The credential file carried no token.');
	return {
		platformTenantId: String(value.platformTenantId ?? ''),
		email: String(value.email ?? ''),
		token: value.token,
		capabilities: Array.isArray(value.capabilities) ? value.capabilities : [],
	};
}

/* A credential relaunched on more ports than this without ever connecting
   leaves the sessions of its oldest addresses where they are. */
const PENDING_SESSION_MOVE_LIMIT = 8;

/* The dashboard banner, the connection state and the preview bridge all read
   the platform address from the configuration, so the launcher records the
   address it resolved before any of them starts instead of after the platform
   answers, which on a first run is long after the banner.

   A credential the launcher collected belongs to this workspace's platform,
   so it follows the platform the launcher starts to its port, and the address
   it leaves is kept until its sessions follow (completeSessionMove). A
   credential the operator connected, or a platform the launcher only connects
   to, keeps the connection as configured. */
export async function recordPlatformAddress(options: {
	readonly workspaceRoot: string;
	readonly platformUrl: string;
	readonly startedByLauncher: boolean;
}): Promise<void> {
	await updateSandboxConfiguration(options.workspaceRoot, (configuration) => {
		if (configuration.platformUrl === options.platformUrl) return configuration;
		if (
			configuration.platformToken !== null &&
			!(options.startedByLauncher && holdsLauncherCredential(configuration))
		)
			return configuration;
		return {
			...configuration,
			platformUrl: options.platformUrl,
			pendingSessionMoveFrom:
				configuration.platformToken === null
					? configuration.pendingSessionMoveFrom
					: [
							...configuration.pendingSessionMoveFrom.filter(
								(url) =>
									url !== configuration.platformUrl &&
									url !== options.platformUrl,
							),
							configuration.platformUrl,
						].slice(-PENDING_SESSION_MOVE_LIMIT),
			version: 1,
		};
	});
}

/* The embedded database is single-process, so a second process cannot open it
   while the platform is serving. Provisioning therefore happens inside the
   platform's own boot, where it already holds the database and its leases, and
   leaves a sealed-nothing 0600 file for this launcher to pick up.

   The launcher therefore runs after the platform, reads the file once, seals the
   token into its own configuration and deletes the file. Nothing is printed and
   no HTTP surface for a machine is added. */
export async function collectProvisionedCredential(options: {
	readonly workspaceRoot: string;
	readonly platformUrl: string;
	readonly log?: (line: string) => void;
}): Promise<boolean> {
	const path = join(
		flowdularStateDirectory(options.workspaceRoot),
		'sandbox',
		'sandbox-credential.json',
	);
	const configuration = await loadSandboxConfiguration(options.workspaceRoot);
	if (configuration.platformToken !== null) {
		/* A prior collection may have saved the sealed token but failed to
		   remove the plaintext inbox. Finish that cleanup on the next start. */
		await rm(path, { force: true });
		return false;
	}
	/* Both writes check the token again: one connected since the check above
	   keeps its address and stays, as it would have there. */
	if (configuration.platformUrl !== options.platformUrl) {
		await updateSandboxConfiguration(options.workspaceRoot, (current) =>
			current.platformToken !== null
				? current
				: { ...current, platformUrl: options.platformUrl, version: 1 },
		);
	}
	let credential: ProvisionedCredential;
	try {
		credential = await readCredential(path);
	} catch {
		return false;
	}
	/* Keep the only copy until the local configuration has the sealed token.
	   A failed seal or write can then be retried after the next start. */
	const platformToken = await sealSecret(
		options.workspaceRoot,
		credential.token,
	);
	const stored = await updateSandboxConfiguration(
		options.workspaceRoot,
		(current) =>
			current.platformToken !== null
				? current
				: {
						...current,
						platformUrl: options.platformUrl,
						platformToken,
						launcherTokenFingerprint: secretFingerprint(platformToken),
						version: 1,
					},
	);
	await rm(path, { force: true });
	if (stored.platformToken !== platformToken) return false;
	options.log?.(
		`connected to the application as ${credential.email} with ${credential.capabilities.length} scope(s)`,
	);
	return true;
}

/* Exposed for the test that proves the file is removed on a failed run. */
export async function writeCredentialForTest(
	path: string,
	credential: ProvisionedCredential,
): Promise<void> {
	await writeFile(path, JSON.stringify(credential), { mode: 0o600 });
}
