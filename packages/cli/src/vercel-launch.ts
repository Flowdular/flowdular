import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { Client } from 'pg';
import {
	failure,
	success,
	type CommandEnvelope,
} from '@flowdular/cli-protocol';
import { BACKUP_KEY_VARIABLES } from '@flowdular/database';
import type { ParsedArguments } from './arguments.ts';
import {
	APPLICATION_ROLES,
	applyApplicationRoles,
	inspectApplicationRoles,
	type ApplicationRole,
	type SqlSession,
} from './database-roles.ts';
import type { Workspace } from './workspace.ts';

/* Every flag, subcommand and output shape below was read from this release.
   An older major is refused; a newer one runs with a warning. */
export const VERIFIED_VERCEL_CLI = '62.2.0';
const MINIMUM_VERCEL_MAJOR = 62;

/* A changed key makes the rows it sealed unreadable, so each is generated
   exactly once per project. */
const PRODUCTION_KEYS: readonly string[] = BACKUP_KEY_VARIABLES;
const CRON_SECRET = 'CRON_SECRET';
const ROLE_PASSWORDS: Readonly<Record<ApplicationRole, string>> = {
	runtime: 'FD_DATABASE_RUNTIME_PASSWORD',
	background: 'FD_DATABASE_BACKGROUND_PASSWORD',
};
const ROLE_URLS: Readonly<Record<ApplicationRole, string>> = {
	runtime: 'FD_DATABASE_URL',
	background: 'FD_DATABASE_BACKGROUND_URL',
};
const MIGRATOR_URL = 'FD_DATABASE_MIGRATOR_URL';
const CRON_SCHEDULE = 'FD_VERCEL_CRON_SCHEDULE';
const PLAN = 'FD_VERCEL_PLAN';
const SETUP_TOKEN_DIGEST = 'FD_SETUP_TOKEN_SHA256';
const DAILY_CRON = '0 3 * * *';
/* The message Vercel fails a Hobby deployment with, per its cron usage docs. */
const HOBBY_CRON_REJECTION = /Hobby accounts are limited to daily cron jobs/i;
/* Neon's Marketplace integration names its direct (unpooled) owner URL so. */
const NEON_DIRECT_URL = 'DATABASE_URL_UNPOOLED';
const BLOB_CREDENTIALS = ['BLOB_STORE_ID', 'BLOB_READ_WRITE_TOKEN'];
const CAPTURE_LIMIT = 4 * 1024 * 1024;
const OUTPUT_TAIL_LIMIT = 64 * 1024;
const READY_ATTEMPTS = 24;
const READY_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
/* A GET tick holds the worker window open (50 seconds by default) and drains
   it before answering. */
const TICK_TIMEOUT_MS = 120_000;

export type VercelPlan = 'hobby' | 'pro';

export interface VercelLaunchOptions {
	readonly project?: string | undefined;
	readonly scope?: string | undefined;
	readonly databaseUrlEnv?: string | undefined;
	readonly origin?: string | undefined;
	readonly cron?: string | undefined;
	readonly plan?: VercelPlan | undefined;
}

/** What the launcher needs from the outside world besides the Vercel CLI. */
export interface VercelLaunchHost {
	/** An owner session on the database, over TLS verified against public CAs. */
	openDatabase(url: URL): Promise<SqlSession & { close(): Promise<void> }>;
	/** Runs this CLI against the deployment database. The URLs and keys travel
	 *  in the child's environment, never on its argv. */
	runPlatformCommand(
		args: readonly string[],
		environment: Readonly<Record<string, string>>,
	): Promise<CommandEnvelope>;
	fetch(url: string, init: RequestInit): Promise<Response>;
	wait(ms: number): Promise<void>;
}

interface VercelProject {
	readonly id: string;
	readonly name: string | undefined;
}

interface KeyBackup {
	readonly path: string;
	readonly values: Map<string, string>;
}

interface LaunchContext {
	readonly root: string;
	readonly options: VercelLaunchOptions;
	readonly host: VercelLaunchHost;
	/* Every value this run must never print, matched against forwarded output. */
	readonly secrets: Set<string>;
	readonly warnings: string[];
}

interface VercelRun {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
}

class LaunchError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

function option(
	arguments_: ParsedArguments,
	name: string,
	pattern: RegExp,
	expected: string,
): string | undefined {
	if (!arguments_.flags.has(name)) return undefined;
	const value = arguments_.flags.get(name);
	if (typeof value !== 'string' || !pattern.test(value)) {
		throw new LaunchError('USAGE_ERROR', `--${name} takes ${expected}.`);
	}
	return value;
}

export function vercelLaunchOptions(
	arguments_: ParsedArguments,
):
	| { readonly options: VercelLaunchOptions }
	| { readonly error: CommandEnvelope } {
	try {
		const originFlag = option(
			arguments_,
			'origin',
			/^https:\/\/\S+$/,
			'an https:// origin',
		);
		let origin: string | undefined;
		if (originFlag) {
			const url = new URL(originFlag);
			if (
				url.username ||
				url.password ||
				url.search ||
				url.hash ||
				url.pathname !== '/'
			) {
				throw new LaunchError(
					'USAGE_ERROR',
					'--origin takes an https:// origin without a path, query or credentials.',
				);
			}
			origin = url.origin;
		}
		return {
			options: {
				project: option(
					arguments_,
					'project',
					/^[a-z0-9][a-z0-9._-]{0,99}$/,
					'a Vercel project name',
				),
				scope: option(
					arguments_,
					'scope',
					/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/,
					'a Vercel team slug or id',
				),
				databaseUrlEnv: option(
					arguments_,
					'database-url-env',
					/^[A-Z][A-Z0-9_]{0,63}$/,
					'the NAME of an environment variable holding the owner URL, never the URL',
				),
				origin,
				cron: option(
					arguments_,
					'cron',
					/^\S+( \S+){4}$/,
					'a five-field cron expression',
				),
				plan: option(arguments_, 'plan', /^(hobby|pro)$/, 'hobby or pro') as
					| VercelPlan
					| undefined,
			},
		};
	} catch (error) {
		if (error instanceof LaunchError)
			return { error: failure(error.code, error.message) };
		return {
			error: failure('USAGE_ERROR', '--origin takes an https:// origin.'),
		};
	}
}

/** The dry run of `deploy start vercel`: what an applied run would do. */
export function vercelLaunchSteps(options: VercelLaunchOptions): string[] {
	const roles = Object.values(APPLICATION_ROLES).join(' and ');
	return [
		options.plan
			? `Check the Vercel CLI (verified against ${VERIFIED_VERCEL_CLI}) and its signed-in account; use the ${options.plan} plan as given.`
			: `Check the Vercel CLI (verified against ${VERIFIED_VERCEL_CLI}) and its signed-in account, and read the team's plan from vercel whoami --json.`,
		`Link this directory to a Vercel project with vercel link --yes${options.project ? ` --project ${options.project}` : ''}, unless .vercel/project.json exists.`,
		options.databaseUrlEnv
			? `Read the database owner URL from $${options.databaseUrlEnv}.`
			: `Provision Neon PostgreSQL for Production through the Vercel Marketplace unless ${NEON_DIRECT_URL} exists, then read its owner URL through a private temporary file.`,
		`Create the ${roles} roles without SUPERUSER or BYPASSRLS and grant them what infra/docker/postgres/10-roles.sh grants; the owner role migrates.`,
		'Generate the missing stable keys, CRON_SECRET and role passwords into .flowdular/deploy/vercel-<project id>.env (mode 0600) first, then add each missing Production variable through stdin.',
		`Set ${PLAN} to the plan when it is known, which sizes the worker cron and Function duration.`,
		'Create and connect a private Vercel Blob store unless the project has Blob credentials.',
		`If the database has no workspace yet, generate a one-time setup token and set only its SHA-256 as ${SETUP_TOKEN_DIGEST}.`,
		`Deploy to Production with vercel deploy --prod. If the plan is unknown and Vercel rejects the per-minute cron as Hobby, set ${PLAN}=hobby and deploy once more.`,
		`Wait for ${options.origin ?? 'https://<project>.vercel.app'}/api/ready, send one authenticated worker tick, then print the setup address and token when the first workspace is still to be created.`,
	];
}

function semver(text: string): [number, number, number] | null {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** The installed Vercel CLI version, or null when none runs from PATH. */
export function vercelCliVersion(): string | null {
	const result = spawnSync('vercel', ['--version'], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
		timeout: 30_000,
		maxBuffer: 4096,
	});
	if (result.error || result.status !== 0) return null;
	return semver(result.stdout)?.join('.') ?? null;
}

export function supportedVercelCli(version: string | null): boolean {
	const parsed = version ? semver(version) : null;
	return parsed !== null && parsed[0] >= MINIMUM_VERCEL_MAJOR;
}

function redact(context: LaunchContext, text: string): string {
	let result = text;
	for (const secret of context.secrets) {
		if (secret.length >= 8) result = result.replaceAll(secret, '[redacted]');
	}
	return result;
}

function remember(context: LaunchContext, value: string): string {
	context.secrets.add(value);
	return value;
}

function progress(message: string): void {
	process.stderr.write(`\n> ${message}\n`);
}

function lastLines(context: LaunchContext, run: VercelRun): string {
	const lines = `${run.stderr}\n${run.stdout}`
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	return redact(context, lines.slice(-3).join(' ')).slice(0, 600);
}

/* Secrets reach the Vercel CLI only on stdin: argv is visible to every user of
   the host through the process list. */
function runVercel(
	context: LaunchContext,
	args: readonly string[],
	mode: {
		readonly input?: string;
		readonly interactive?: boolean;
		readonly forward?: boolean;
		readonly cwd?: string;
	} = {},
): Promise<VercelRun> {
	const fullArgs = context.options.scope
		? [...args, '--scope', context.options.scope]
		: [...args];
	return new Promise((resolve, reject) => {
		const child = spawn('vercel', fullArgs, {
			cwd: mode.cwd ?? context.root,
			stdio: mode.interactive
				? 'inherit'
				: [mode.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
		});
		const captured = { stdout: '', stderr: '' };
		const pending = { stdout: '', stderr: '' };
		const limit = mode.forward ? OUTPUT_TAIL_LIMIT : CAPTURE_LIMIT;
		for (const name of ['stdout', 'stderr'] as const) {
			child[name]?.setEncoding('utf8').on('data', (chunk: string) => {
				captured[name] = (captured[name] + chunk).slice(-limit);
				if (!mode.forward) return;
				const lines = (pending[name] + chunk).split('\n');
				pending[name] = lines.pop() ?? '';
				for (const line of lines)
					process.stderr.write(`${redact(context, line)}\n`);
			});
		}
		child.stdin?.end(mode.input);
		child.once('error', reject);
		child.once('close', (code) => {
			if (mode.forward) {
				for (const rest of [pending.stdout, pending.stderr])
					if (rest) process.stderr.write(`${redact(context, rest)}\n`);
			}
			resolve({ status: code ?? 1, ...captured });
		});
	});
}

function unexpected(command: string): LaunchError {
	return new LaunchError(
		'VERCEL_CLI_UNEXPECTED',
		`${command} returned output this launcher does not recognize. It was verified against Vercel CLI ${VERIFIED_VERCEL_CLI}; install that version with npm i -g vercel@${VERIFIED_VERCEL_CLI}.`,
	);
}

async function readProjectLink(root: string): Promise<VercelProject | null> {
	const path = join(root, '.vercel/project.json');
	let link: unknown;
	try {
		const entry = await lstat(path);
		if (!entry.isFile() || entry.size > 16 * 1024) {
			throw new LaunchError(
				'VERCEL_LINK_INVALID',
				'.vercel/project.json must be a regular file. Remove .vercel and rerun to link again.',
			);
		}
		link = JSON.parse(await readFile(path, 'utf8'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		if (error instanceof LaunchError) throw error;
		throw new LaunchError(
			'VERCEL_LINK_INVALID',
			'.vercel/project.json is not valid JSON. Remove .vercel and rerun to link again.',
		);
	}
	const { projectId, projectName } = (link ?? {}) as Record<string, unknown>;
	/* The id names the local key backup file, so it must stay a plain name. */
	if (
		typeof projectId !== 'string' ||
		!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)
	) {
		throw unexpected('vercel link');
	}
	return {
		id: projectId,
		name: typeof projectName === 'string' ? projectName : undefined,
	};
}

async function linkProject(context: LaunchContext): Promise<VercelProject> {
	const linked = await readProjectLink(context.root);
	const wanted = context.options.project;
	if (linked) {
		if (wanted && wanted !== linked.name && wanted !== linked.id) {
			throw new LaunchError(
				'VERCEL_PROJECT_MISMATCH',
				`This directory is linked to Vercel project ${linked.name ?? linked.id}. Drop --project, or remove .vercel to link ${wanted}.`,
			);
		}
		return linked;
	}
	progress('Linking this directory to a Vercel project');
	const run = await runVercel(
		context,
		['link', '--yes', ...(wanted ? ['--project', wanted] : [])],
		{ interactive: true },
	);
	if (run.status !== 0) {
		throw new LaunchError(
			'VERCEL_LINK_FAILED',
			'vercel link failed. Check its output above, then rerun.',
		);
	}
	const project = await readProjectLink(context.root);
	if (!project) throw unexpected('vercel link');
	return project;
}

async function productionEnvironmentNames(
	context: LaunchContext,
): Promise<Set<string>> {
	const run = await runVercel(context, ['env', 'ls', 'production', '--json']);
	if (run.status !== 0) {
		throw new LaunchError(
			'VERCEL_ENV_FAILED',
			`vercel env ls failed: ${lastLines(context, run)}`,
		);
	}
	let listed: unknown;
	try {
		listed = JSON.parse(run.stdout);
	} catch {
		throw unexpected('vercel env ls --json');
	}
	const envs = (listed as { envs?: unknown } | null)?.envs;
	if (!Array.isArray(envs)) throw unexpected('vercel env ls --json');
	const names = new Set<string>();
	for (const entry of envs as { key?: unknown; target?: unknown }[]) {
		if (typeof entry?.key !== 'string')
			throw unexpected('vercel env ls --json');
		const targets = Array.isArray(entry.target) ? entry.target : [entry.target];
		if (entry.target === undefined || targets.includes('production'))
			names.add(entry.key);
	}
	return names;
}

async function setProductionVariable(
	context: LaunchContext,
	name: string,
	value: string,
	exists: boolean,
): Promise<void> {
	const run = await runVercel(
		context,
		exists
			? ['env', 'update', name, 'production', '--sensitive', '--yes']
			: ['env', 'add', name, 'production', '--sensitive'],
		{ input: value },
	);
	if (run.status !== 0) {
		throw new LaunchError(
			'VERCEL_ENV_FAILED',
			`Setting ${name} for Production failed: ${lastLines(context, run)}`,
		);
	}
}

async function readKeyBackup(
	root: string,
	project: VercelProject,
): Promise<KeyBackup> {
	const path = join(root, '.flowdular/deploy', `vercel-${project.id}.env`);
	const values = new Map<string, string>();
	try {
		const entry = await lstat(path);
		if (!entry.isFile() || entry.size > 64 * 1024) {
			throw new LaunchError(
				'KEY_BACKUP_INVALID',
				`${relative(root, path)} must be a regular file of at most 64 KiB.`,
			);
		}
		for (const line of (await readFile(path, 'utf8')).split('\n')) {
			const match = /^([A-Z][A-Z0-9_]*)=(\S+)$/.exec(line.replace(/\r$/, ''));
			if (match) values.set(match[1]!, match[2]!);
		}
		await chmod(path, 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	return { path, values };
}

/* Written before any value it holds is used anywhere else, so a run that fails
   halfway never leaves a key or password only in Vercel or only in PostgreSQL. */
async function writeKeyBackup(
	root: string,
	project: VercelProject,
	backup: KeyBackup,
): Promise<void> {
	const directory = dirname(backup.path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	for (const path of [join(root, '.flowdular'), directory]) {
		if (!(await lstat(path)).isDirectory()) {
			throw new LaunchError(
				'KEY_BACKUP_INVALID',
				`${relative(root, path)} must be a directory inside the workspace.`,
			);
		}
	}
	await chmod(directory, 0o700);
	const contents = [
		`# Flowdular production keys for Vercel project ${project.name ?? project.id} (${project.id}).`,
		'# Keep a copy off this machine. A lost or changed key makes existing data unreadable.',
		...[...backup.values].map(([name, value]) => `${name}=${value}`),
		'',
	].join('\n');
	const temporary = `${backup.path}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temporary, 'wx', 0o600);
		try {
			await handle.writeFile(contents);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, backup.path);
	} finally {
		await rm(temporary, { force: true });
	}
}

function generatedValue(name: string): string {
	if (name === 'FD_AUTH_MFA_KEY') return randomBytes(32).toString('base64url');
	if (PRODUCTION_KEYS.includes(name)) return randomBytes(32).toString('base64');
	return randomBytes(32).toString('hex');
}

function ownerUrl(context: LaunchContext, value: string, source: string): URL {
	remember(context, value);
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new LaunchError(
			'DATABASE_URL_INVALID',
			`${source} is not a valid PostgreSQL URL.`,
		);
	}
	if (
		(url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
		!url.hostname ||
		!url.username ||
		!url.password ||
		!/^\/[^/]+$/.test(url.pathname)
	) {
		throw new LaunchError(
			'DATABASE_URL_INVALID',
			`${source} must have the form postgresql://owner:password@host/database.`,
		);
	}
	remember(context, decodeURIComponent(url.password));
	/* The platform sends statement_timeout and lock_timeout as startup
	   parameters, which a PgBouncer transaction pooler refuses. */
	if (url.hostname.split('.')[0]!.endsWith('-pooler')) {
		throw new LaunchError(
			'DATABASE_URL_POOLED',
			`${source} names a connection pooler. Use the direct (unpooled) owner URL.`,
		);
	}
	return url;
}

function roleUrl(owner: URL, role: ApplicationRole, password: string): string {
	return `postgresql://${encodeURIComponent(APPLICATION_ROLES[role])}:${encodeURIComponent(password)}@${owner.host}${owner.pathname}`;
}

async function pullProductionValue(
	context: LaunchContext,
	name: string,
): Promise<string | undefined> {
	const directory = await mkdtemp(join(tmpdir(), 'flowdular-vercel-env-'));
	try {
		const file = join(directory, 'production.env');
		await writeFile(file, '', { mode: 0o600, flag: 'wx' });
		const run = await runVercel(context, [
			'env',
			'pull',
			file,
			'--environment',
			'production',
			'--yes',
		]);
		if (run.status !== 0) {
			throw new LaunchError(
				'VERCEL_ENV_FAILED',
				`vercel env pull failed: ${lastLines(context, run)}`,
			);
		}
		const prefix = `${name}="`;
		const line = (await readFile(file, 'utf8'))
			.split('\n')
			.find((entry) => entry.startsWith(prefix) && entry.endsWith('"'));
		const value = line?.slice(prefix.length, -1);
		return value && value !== '[SENSITIVE]'
			? remember(context, value)
			: undefined;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/* integration add installs the product's agent skills into its working
   directory and may pull env files there, so it runs in a throwaway copy of the
   project link instead of the workspace. */
async function provisionNeon(context: LaunchContext): Promise<void> {
	progress('Provisioning Neon PostgreSQL through the Vercel Marketplace');
	const directory = await mkdtemp(join(tmpdir(), 'flowdular-vercel-neon-'));
	try {
		await mkdir(join(directory, '.vercel'), { mode: 0o700 });
		await copyFile(
			join(context.root, '.vercel/project.json'),
			join(directory, '.vercel/project.json'),
		);
		const run = await runVercel(
			context,
			[
				'integration',
				'add',
				'neon',
				'--environment',
				'production',
				'--no-env-pull',
			],
			{ interactive: true, cwd: directory },
		);
		if (run.status !== 0) {
			throw new LaunchError(
				'NEON_PROVISION_FAILED',
				'vercel integration add neon failed. Check its output above, or pass --database-url-env with an existing database.',
			);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function resolveOwnerUrl(
	context: LaunchContext,
	backup: KeyBackup,
	names: Set<string>,
): Promise<URL> {
	const variable = context.options.databaseUrlEnv;
	if (variable) {
		const value = process.env[variable];
		if (!value) {
			throw new LaunchError(
				'DATABASE_URL_MISSING',
				`$${variable} is empty. Export the database owner URL there.`,
			);
		}
		return ownerUrl(context, value, `$${variable}`);
	}
	const known = backup.values.get(MIGRATOR_URL);
	if (known) return ownerUrl(context, known, 'The key backup');
	if (!names.has(NEON_DIRECT_URL)) {
		await provisionNeon(context);
		const refreshed = await productionEnvironmentNames(context);
		if (!refreshed.has(NEON_DIRECT_URL)) {
			throw new LaunchError(
				'NEON_NOT_CONNECTED',
				`The project has no Production ${NEON_DIRECT_URL} after the Neon install. Connect the Neon database to Production in the Vercel dashboard, or pass --database-url-env.`,
			);
		}
	}
	const value = await pullProductionValue(context, NEON_DIRECT_URL);
	if (!value) {
		throw new LaunchError(
			'NEON_URL_UNREADABLE',
			`${NEON_DIRECT_URL} cannot be read back, which happens when the Neon resource allows Production only. Export the owner URL from the Neon console into a variable and pass --database-url-env NAME.`,
		);
	}
	return ownerUrl(context, value, NEON_DIRECT_URL);
}

async function provisionRoles(
	context: LaunchContext,
	project: VercelProject,
	backup: KeyBackup,
	owner: URL,
): Promise<Set<string>> {
	progress(
		`Creating the ${Object.values(APPLICATION_ROLES).join(' and ')} database roles`,
	);
	const session = await context.host.openDatabase(owner);
	const changed = new Set<string>();
	try {
		const existing = await inspectApplicationRoles(session);
		const passwords = {} as Record<ApplicationRole, string>;
		const reset: string[] = [];
		for (const role of Object.keys(APPLICATION_ROLES) as ApplicationRole[]) {
			const known = backup.values.get(ROLE_PASSWORDS[role]);
			if (!known && existing[role]) reset.push(APPLICATION_ROLES[role]);
			const password = remember(
				context,
				known ?? generatedValue(ROLE_PASSWORDS[role]),
			);
			passwords[role] = password;
			backup.values.set(ROLE_PASSWORDS[role], password);
			const url = remember(context, roleUrl(owner, role, password));
			if (backup.values.get(ROLE_URLS[role]) !== url) {
				backup.values.set(ROLE_URLS[role], url);
				changed.add(ROLE_URLS[role]);
			}
		}
		const migrator = remember(
			context,
			`postgresql://${owner.username}:${owner.password}@${owner.host}${owner.pathname}`,
		);
		if (backup.values.get(MIGRATOR_URL) !== migrator) {
			backup.values.set(MIGRATOR_URL, migrator);
			changed.add(MIGRATOR_URL);
		}
		await writeKeyBackup(context.root, project, backup);
		await applyApplicationRoles(session, passwords);
		if (reset.length > 0) {
			context.warnings.push(
				`${reset.join(' and ')} existed without a password in the local backup and got a new one. Anything else that connects as them needs the new URL.`,
			);
		}
	} finally {
		await session.close();
	}
	return changed;
}

async function connectBlobStore(
	context: LaunchContext,
	project: VercelProject,
): Promise<void> {
	progress('Creating a private Vercel Blob store');
	const name = `${(project.name ?? project.id).slice(0, 26)}-files`;
	const listed = await runVercel(context, [
		'storage',
		'list',
		'--type',
		'blob',
		'--json',
	]);
	let stores: unknown;
	try {
		stores = (JSON.parse(listed.stdout) as { stores?: unknown }).stores;
	} catch {
		stores = undefined;
	}
	if (listed.status !== 0 || !Array.isArray(stores))
		throw unexpected('vercel storage list --json');
	let id = (stores as { id?: unknown; name?: unknown }[]).find(
		(store) => store?.name === name,
	)?.id;
	if (typeof id !== 'string') {
		const created = await runVercel(context, [
			'storage',
			'create',
			name,
			'--type',
			'blob',
			'--access',
			'private',
			'--json',
		]);
		try {
			id = (JSON.parse(created.stdout) as { store?: { id?: unknown } }).store
				?.id;
		} catch {
			id = undefined;
		}
		if (created.status !== 0 || typeof id !== 'string') {
			throw new LaunchError(
				'BLOB_STORE_FAILED',
				`vercel storage create failed: ${lastLines(context, created)}`,
			);
		}
	}
	const connected = await runVercel(context, [
		'storage',
		'connect',
		id,
		'--environment',
		'production',
		'--yes',
	]);
	if (connected.status !== 0) {
		throw new LaunchError(
			'BLOB_STORE_FAILED',
			`vercel storage connect failed: ${lastLines(context, connected)}`,
		);
	}
}

async function platformCommand(
	context: LaunchContext,
	args: readonly string[],
	environment: Readonly<Record<string, string>>,
): Promise<Record<string, unknown>> {
	const result = await context.host.runPlatformCommand(
		['--root', context.root, ...args],
		environment,
	);
	if (!result.ok) {
		throw new LaunchError(
			'WORKSPACE_CHECK_FAILED',
			redact(
				context,
				`flowdular ${args.slice(0, 2).join(' ')} failed against the deployment database: ${result.error?.message ?? 'no detail'}`,
			),
		);
	}
	return (result.data ?? {}) as Record<string, unknown>;
}

async function workspaceExists(
	context: LaunchContext,
	environment: Readonly<Record<string, string>>,
): Promise<boolean> {
	const listed = await platformCommand(
		context,
		['auth', 'workspaces', '--limit', '1'],
		environment,
	);
	if (typeof listed.total !== 'number')
		throw unexpected('flowdular auth workspaces');
	return listed.total > 0;
}

/* whoami resolves --scope or the linked project's team, so this is the plan of
   the team that deploys. Anything it does not answer leaves the plan unknown. */
function accountPlan(run: VercelRun): VercelPlan | null {
	let plan: unknown;
	try {
		plan = (JSON.parse(run.stdout) as { plan?: unknown } | null)?.plan;
	} catch {
		return null;
	}
	if (plan === 'hobby') return 'hobby';
	return plan === 'pro' || plan === 'enterprise' ? 'pro' : null;
}

async function deployProduction(context: LaunchContext): Promise<VercelRun> {
	progress('Deploying to Vercel Production');
	return runVercel(context, ['deploy', '--prod', '--yes'], { forward: true });
}

async function waitForReady(
	context: LaunchContext,
	origin: string,
): Promise<number | null> {
	let status: number | null = null;
	for (let attempt = 1; attempt <= READY_ATTEMPTS; attempt += 1) {
		try {
			const response = await context.host.fetch(`${origin}/api/ready`, {
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			status = response.status;
			await response.body?.cancel();
		} catch {
			status = null;
		}
		if (status === 200 || attempt === READY_ATTEMPTS) return status;
		await context.host.wait(READY_INTERVAL_MS);
	}
	return status;
}

async function tickWorker(
	context: LaunchContext,
	origin: string,
	secret: string,
): Promise<number | null> {
	try {
		const response = await context.host.fetch(
			`${origin}/api/internal/worker/tick`,
			{
				headers: { authorization: `Bearer ${secret}` },
				signal: AbortSignal.timeout(TICK_TIMEOUT_MS),
			},
		);
		await response.body?.cancel();
		return response.status;
	} catch {
		return null;
	}
}

async function launch(context: LaunchContext): Promise<CommandEnvelope> {
	const { options } = context;
	const version = vercelCliVersion();
	if ((semver(version ?? '')?.[0] ?? 0) > MINIMUM_VERCEL_MAJOR) {
		context.warnings.push(
			`Vercel CLI ${version} is newer than the verified ${VERIFIED_VERCEL_CLI}. If a step fails on unexpected output, install vercel@${VERIFIED_VERCEL_CLI}.`,
		);
	}
	const whoami = await runVercel(context, ['whoami', '--json']);
	if (whoami.status !== 0) {
		throw new LaunchError(
			'VERCEL_LOGIN_REQUIRED',
			'The Vercel CLI has no signed-in account. Run vercel login, then rerun this command.',
		);
	}
	let plan = options.plan ?? accountPlan(whoami);
	const project = await linkProject(context);
	const origin =
		options.origin ??
		(project.name ? `https://${project.name}.vercel.app` : undefined);
	if (!origin) {
		throw new LaunchError(
			'ORIGIN_REQUIRED',
			'.vercel/project.json names no project, so the production URL is unknown. Pass --origin https://<domain>.',
		);
	}
	let names = await productionEnvironmentNames(context);
	const backup = await readKeyBackup(context.root, project);
	for (const value of backup.values.values()) remember(context, value);

	const owner = await resolveOwnerUrl(context, backup, names);
	const changedUrls = await provisionRoles(context, project, backup, owner);

	const generated: string[] = [];
	const unbacked: string[] = [];
	for (const name of [...PRODUCTION_KEYS, CRON_SECRET]) {
		if (backup.values.has(name)) continue;
		if (names.has(name)) {
			unbacked.push(name);
			continue;
		}
		backup.values.set(name, remember(context, generatedValue(name)));
		generated.push(name);
	}
	if (generated.length > 0) await writeKeyBackup(context.root, project, backup);

	progress('Setting the Production environment variables');
	for (const name of [...PRODUCTION_KEYS, CRON_SECRET]) {
		const value = backup.values.get(name);
		if (value && !names.has(name))
			await setProductionVariable(context, name, value, false);
	}
	for (const name of [...Object.values(ROLE_URLS), MIGRATOR_URL]) {
		if (!names.has(name) || changedUrls.has(name))
			await setProductionVariable(
				context,
				name,
				backup.values.get(name)!,
				names.has(name),
			);
	}
	const settings = new Map<string, string>([
		['FD_DATABASE_ADAPTER', 'postgresql'],
		['FD_DATABASE_TLS', 'verify-full'],
		['FD_STORAGE_ADAPTER', 'vercel-blob'],
		['FD_STORAGE_MAX_OBJECT_BYTES', '4194304'],
		['FD_AUTH_PUBLIC_ORIGIN', origin],
		...(options.cron ? [[CRON_SCHEDULE, options.cron] as const] : []),
		...(plan ? [[PLAN, plan] as const] : []),
	]);
	/* A known plan is set on every run, so a team that moved to Pro gets the
	   per-minute worker from its next deploy. */
	const explicit = new Set([
		...(options.origin ? ['FD_AUTH_PUBLIC_ORIGIN'] : []),
		...(options.cron ? [CRON_SCHEDULE] : []),
		...(plan ? [PLAN] : []),
	]);
	for (const [name, value] of settings) {
		if (!names.has(name) || explicit.has(name))
			await setProductionVariable(context, name, value, names.has(name));
	}

	if (!BLOB_CREDENTIALS.some((name) => names.has(name))) {
		await connectBlobStore(context, project);
		names = await productionEnvironmentNames(context);
		if (!BLOB_CREDENTIALS.some((name) => names.has(name))) {
			throw new LaunchError(
				'BLOB_STORE_NOT_CONNECTED',
				'The project has no Production BLOB_STORE_ID. In the Vercel dashboard open Storage, connect a private Blob store to this project for Production, then rerun.',
			);
		}
	}

	/* The child loads the workspace .env, which never overrides a variable that
	   is set, so a local certificate authority must be cleared explicitly. */
	const environment: Record<string, string> = {
		NODE_ENV: 'production',
		FD_DATABASE_TLS_CA: '',
		FD_DATABASE_TLS_CA_FILE: '',
		...Object.fromEntries(settings),
	};
	for (const name of [
		...PRODUCTION_KEYS,
		...Object.values(ROLE_URLS),
		MIGRATOR_URL,
	]) {
		const value = backup.values.get(name);
		if (value) environment[name] = value;
	}
	let setupToken: string | null = null;
	if (!(await workspaceExists(context, environment))) {
		progress('Setting a one-time setup token for the first workspace');
		setupToken = remember(context, randomBytes(32).toString('base64url'));
		await setProductionVariable(
			context,
			SETUP_TOKEN_DIGEST,
			remember(
				context,
				createHash('sha256').update(setupToken, 'utf8').digest('hex'),
			),
			names.has(SETUP_TOKEN_DIGEST),
		);
	}

	let deployed = await deployProduction(context);
	if (
		deployed.status !== 0 &&
		HOBBY_CRON_REJECTION.test(`${deployed.stderr}\n${deployed.stdout}`)
	) {
		if (options.cron || plan) {
			throw new LaunchError(
				'DEPLOY_CRON_REJECTED',
				options.cron
					? `Vercel Hobby runs cron jobs at most once a day and rejected --cron "${options.cron}". Pass a daily schedule such as --cron "${DAILY_CRON}".`
					: plan === 'pro'
						? 'Vercel rejected the per-minute worker cron, so this team is on the Hobby plan. Rerun with --plan hobby, or upgrade the team to Pro.'
						: `Vercel Hobby runs cron jobs at most once a day and rejected the project's ${CRON_SCHEDULE}. Remove it, or pass --cron "${DAILY_CRON}".`,
			);
		}
		progress(
			`Vercel rejected the per-minute worker cron, so this team is on the Hobby plan. Setting ${PLAN}=hobby and deploying once more.`,
		);
		await setProductionVariable(context, PLAN, 'hobby', names.has(PLAN));
		plan = 'hobby';
		deployed = await deployProduction(context);
	}
	if (deployed.status !== 0) {
		throw new LaunchError(
			'DEPLOY_FAILED',
			'vercel deploy --prod failed. Check its output above; rerunning this command resumes without regenerating anything.',
		);
	}

	progress(`Waiting for ${origin}/api/ready`);
	const ready = await waitForReady(context, origin);
	const cronSecret = backup.values.get(CRON_SECRET);
	const tick =
		ready === 200 && cronSecret
			? await tickWorker(context, origin, cronSecret)
			: null;
	if (ready !== 200) {
		context.warnings.push(
			`${origin}/api/ready answered ${ready ?? 'nothing'} within two minutes. Check the deployment logs in the Vercel dashboard, or pass --origin if the production domain differs.`,
		);
	} else if (tick !== 200) {
		context.warnings.push(
			`The authenticated worker tick answered ${tick ?? (cronSecret ? 'nothing' : 'nothing: CRON_SECRET is not in the local backup')}. Check the worker Function logs.`,
		);
	}
	if (unbacked.length > 0) {
		context.warnings.push(
			`${unbacked.join(', ')} already existed in Vercel and are not in the local backup. Vercel keeps them, but this machine cannot back them up.`,
		);
	}
	if (plan === 'hobby') {
		context.warnings.push(
			'Vercel Hobby: work a request queues (agent runs, renders, notifications, imports, exports) still starts within seconds. Time-driven work (scheduled automations, retries after a lost lease, approval expiries, retention sweeps, digests) waits for the next request or the daily 03:00 UTC run, and an agent run gets about 4 minutes. Hobby is for personal, non-commercial use; on Pro the worker runs every minute.',
		);
	}
	context.warnings.push(
		`Copy ${relative(context.root, backup.path)} to a safe place off this machine. It holds the only copy of the keys this deployment needs to read its data.`,
	);
	return success(
		{
			target: 'vercel',
			status: 'deployed',
			url: origin,
			project: { id: project.id, name: project.name ?? null },
			readiness: ready,
			workerTick: tick,
			plan,
			cronSchedule:
				options.cron ??
				(names.has(CRON_SCHEDULE)
					? 'project setting'
					: plan === 'hobby'
						? DAILY_CRON
						: plan === 'pro' || !names.has(PLAN)
							? '* * * * *'
							: 'project setting'),
			setup: setupToken ? { url: `${origin}/setup`, token: setupToken } : null,
			keyBackup: relative(context.root, backup.path),
			generatedKeys: generated,
		},
		{ warnings: context.warnings },
	);
}

export async function launchVercel(
	workspace: Workspace,
	options: VercelLaunchOptions,
	host: VercelLaunchHost = defaultVercelHost(),
): Promise<CommandEnvelope> {
	const context: LaunchContext = {
		root: workspace.root,
		options,
		host,
		secrets: new Set(),
		warnings: [],
	};
	try {
		return await launch(context);
	} catch (error) {
		if (error instanceof LaunchError)
			return failure(error.code, redact(context, error.message));
		return failure(
			'DEPLOY_START_FAILED',
			`${redact(context, error instanceof Error ? error.message : String(error))} Rerunning this command resumes without regenerating anything.`,
		);
	}
}

export function defaultVercelHost(): VercelLaunchHost {
	return {
		async openDatabase(url) {
			const client = new Client({
				host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
				port: Number(url.port || 5432),
				user: decodeURIComponent(url.username),
				password: decodeURIComponent(url.password),
				database: decodeURIComponent(url.pathname.slice(1)),
				ssl: { rejectUnauthorized: true },
				application_name: 'flowdular-deploy',
				connectionTimeoutMillis: 15_000,
			});
			await client.connect();
			return {
				query: (text) => client.query(text),
				close: () => client.end(),
			};
		},
		runPlatformCommand(args, environment) {
			const entry = process.argv[1];
			if (!entry || !/[\\/]index\.[jt]s$/.test(entry)) {
				return Promise.reject(
					new Error(
						'deploy start vercel reads the workspace list through the flowdular executable; run it as a command, not through the SDK.',
					),
				);
			}
			return new Promise((resolve, reject) => {
				const child = spawn(
					process.execPath,
					[...process.execArgv, entry, ...args, '--json'],
					{
						env: { ...process.env, ...environment },
						stdio: ['ignore', 'pipe', 'inherit'],
					},
				);
				let stdout = '';
				child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
					stdout = (stdout + chunk).slice(0, CAPTURE_LIMIT);
				});
				child.once('error', reject);
				child.once('close', () => {
					try {
						resolve(JSON.parse(stdout) as CommandEnvelope);
					} catch {
						reject(
							new Error('The flowdular child command printed no envelope.'),
						);
					}
				});
			});
		},
		fetch: (url, init) => fetch(url, init),
		wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	};
}
