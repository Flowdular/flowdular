import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import {
	access,
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { success, type CommandEnvelope } from '@flowdular/cli-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArguments } from '../src/arguments.ts';
import {
	applyApplicationRoles,
	inspectApplicationRoles,
	type SqlSession,
} from '../src/database-roles.ts';
import { deploymentPlan, runDeployment } from '../src/deployment.ts';
import { renderOutput } from '../src/output.ts';
import type { VercelLaunchHost } from '../src/vercel-launch.ts';

const OWNER_PASSWORD = 'npg_ownerSecret42xyz';
const NEON_HOST = 'ep-quiet-owl-a1b2c3.eu-central-1.aws.neon.tech';
const OWNER_URL = `postgresql://app_owner:${OWNER_PASSWORD}@${NEON_HOST}/neondb?sslmode=require&channel_binding=require`;
const POOLED_URL = `postgresql://app_owner:${OWNER_PASSWORD}@ep-quiet-owl-a1b2c3-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require`;

/* Behaves like the Vercel CLI 62.2.0 commands the launcher drives, keeping
   Production variables in a JSON state file and logging every call with the
   stdin it received and the setup token file it saw. */
const FAKE_VERCEL = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const statePath = process.env.FAKE_VERCEL_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
const scope = args.indexOf('--scope');
if (scope >= 0) args.splice(scope, 2);
const stdin =
	args[0] === 'env' && (args[1] === 'add' || args[1] === 'update')
		? fs.readFileSync(0, 'utf8')
		: null;
let tokenFile = null;
try {
	const tokenPath = path.join(
		process.cwd(),
		'.flowdular/deploy/vercel-' + state.projectId + '.setup-token',
	);
	tokenFile = {
		mode: fs.lstatSync(tokenPath).mode & 0o777,
		text: fs.readFileSync(tokenPath, 'utf8'),
	};
} catch {}
fs.appendFileSync(
	process.env.FAKE_VERCEL_LOG,
	JSON.stringify({
		argv: process.argv.slice(2),
		stdin,
		cwd: process.cwd(),
		linked: fs.existsSync(path.join(process.cwd(), '.vercel/project.json')),
		tokenFile,
	}) + '\\n',
);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const done = (output) => {
	if (output !== undefined) process.stdout.write(output + '\\n');
	process.exit(0);
};
const fail = (message) => {
	process.stderr.write('Error: ' + message + '\\n');
	process.exit(1);
};
const [group, action, name] = args;
if (group === '--version') {
	process.stderr.write('Vercel CLI ' + state.version + '\\n');
	done(state.version);
}
if (group === 'whoami') {
	const json = args.includes('--json');
	if (state.loggedOut) {
		if (json) process.stdout.write(JSON.stringify({ loggedIn: false }, null, 2) + '\\n');
		process.exit(1);
	}
	if (!json) done('tester');
	done(
		JSON.stringify({
			team: { id: 'team_fake', slug: 'acme', name: 'Acme', plan: state.plan },
			plan: state.plan,
			username: 'tester',
			email: 'tester@example.com',
			name: 'Tester',
		}),
	);
}
if (group === 'link') {
	const project = args.indexOf('--project');
	fs.mkdirSync('.vercel', { recursive: true });
	fs.writeFileSync(
		'.vercel/project.json',
		JSON.stringify({
			projectId: state.projectId,
			orgId: 'team_fake',
			projectName: project >= 0 ? args[project + 1] : state.projectName,
		}),
	);
	done();
}
if (group === 'env' && action === 'ls') {
	done(
		JSON.stringify({
			envs: Object.entries(state.env).map(([key, entry]) => ({
				key,
				type: entry.type,
				target: ['production'],
			})),
		}),
	);
}
if (group === 'env' && (action === 'add' || action === 'update')) {
	if (action === 'add' && state.env[name])
		fail('The variable "' + name + '" has already been added to all Environments.');
	if (action === 'update' && !state.env[name])
		fail('The variable "' + name + '" was not found.');
	state.env[name] = {
		value: stdin.replace(/\\n$/, ''),
		type: args.includes('--sensitive') ? 'sensitive' : 'encrypted',
	};
	save();
	done();
}
if (group === 'env' && action === 'rm') {
	if (state.envRmFails) fail('fetch failed');
	if (!state.env[name]) fail('Environment Variable ' + name + ' was not found.');
	delete state.env[name];
	save();
	done();
}
if (group === 'env' && action === 'pull') {
	const lines = Object.entries(state.env).map(
		([key, entry]) =>
			key + '="' + (entry.type === 'sensitive' ? '[SENSITIVE]' : entry.value) + '"',
	);
	fs.writeFileSync(name, ['# Created by Vercel CLI', ...lines, ''].join('\\n'));
	state.pulled.push(name);
	save();
	done();
}
if (group === 'integration' && action === 'add' && name === 'neon') {
	if (state.neonFails) fail('The Neon installation was cancelled.');
	state.env.DATABASE_URL = { value: state.neonPooledUrl, type: 'encrypted' };
	state.env.DATABASE_URL_UNPOOLED = { value: state.neonUrl, type: 'encrypted' };
	save();
	done();
}
if (group === 'storage' && action === 'list') done(JSON.stringify({ stores: state.stores }));
if (group === 'storage' && action === 'create') {
	const store = { id: 'store_' + (state.stores.length + 1), name, type: 'blob' };
	state.stores.push(store);
	save();
	done(JSON.stringify({ status: 'ok', store }));
}
if (group === 'storage' && action === 'connect') {
	state.env.BLOB_STORE_ID = { value: name, type: 'encrypted' };
	save();
	done();
}
if (group === 'deploy') {
	state.deploys += 1;
	save();
	const schedule =
		state.env.FD_VERCEL_CRON_SCHEDULE?.value ??
		(state.env.FD_VERCEL_PLAN?.value === 'hobby' ? '0 3 * * *' : '* * * * *');
	if (state.hobby && !/^\\d+ \\d+ /.test(schedule))
		fail('Hobby accounts are limited to daily cron jobs. This cron expression would run more than once per day.');
	if (state.deployOutcome === 'lost-before-url') fail('fetch failed');
	for (const name of ['CRON_SECRET', 'FD_SETUP_TOKEN_SHA256'])
		if (state.env[name])
			process.stdout.write('build: ' + name + '=' + state.env[name].value + '\\n');
	if (tokenFile)
		process.stdout.write('build: setup token ' + tokenFile.text.trim() + '\\n');
	process.stdout.write('https://acme-app-abc123-team.vercel.app');
	if (state.deployOutcome === 'lost-after-url') fail('fetch failed');
	process.exit(0);
}
if (group === 'inspect' && args.includes('--json')) {
	const readyState =
		state.inspectStates.length > 1
			? state.inspectStates.shift()
			: state.inspectStates[0];
	save();
	process.stdout.write(
		JSON.stringify(
			{ id: 'dpl_fake', url: action.replace('https://', ''), target: 'production', readyState },
			null,
			2,
		) + '\\n',
	);
	process.exit(readyState === 'ERROR' || readyState === 'CANCELED' ? 1 : 0);
}
process.stderr.write('unknown command ' + args.join(' ') + '\\n');
process.exit(2);
`;

interface FakeState {
	version: string;
	projectId: string;
	projectName: string;
	env: Record<string, { value: string; type: string }>;
	stores: { id: string; name: string }[];
	deploys: number;
	pulled: string[];
	hobby: boolean;
	plan: string | null;
	loggedOut: boolean;
	neonFails: boolean;
	neonUrl: string;
	neonPooledUrl: string;
	deployOutcome: 'ok' | 'lost-before-url' | 'lost-after-url';
	inspectStates: string[];
	envRmFails: boolean;
}

interface Invocation {
	readonly argv: string[];
	readonly stdin: string | null;
	readonly cwd: string;
	readonly linked: boolean;
	readonly tokenFile: { mode: number; text: string } | null;
}

interface Harness {
	readonly root: string;
	readonly db: PGlite;
	readonly output: string[];
	readonly platformCalls: {
		args: readonly string[];
		environment: Readonly<Record<string, string>>;
	}[];
	readonly fetches: { url: string; authorization: string | null }[];
	readonly databaseUrls: URL[];
	readonly waits: number[];
	/* How many workspaces the deployment database holds. */
	workspaces: number;
	/* How many /api/ready probes answer 503 before one answers 200. */
	unreadyProbes: number;
	waitError: Error | null;
	state(): Promise<FakeState>;
	update(change: (state: FakeState) => void): Promise<void>;
	log(): Promise<Invocation[]>;
	clearLog(): Promise<void>;
	backup(): Promise<Map<string, string>>;
	start(args?: readonly string[]): Promise<CommandEnvelope>;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function ownerDatabase(): Promise<PGlite> {
	const db = new PGlite();
	/* Neon's <database>_owner role: no superuser, CREATEROLE, owns the database. */
	await db.exec(
		'CREATE ROLE app_owner LOGIN CREATEROLE; ALTER DATABASE postgres OWNER TO app_owner;',
	);
	return db;
}

function ownerSession(db: PGlite): SqlSession & { close(): Promise<void> } {
	return {
		query: (text) => db.query<Record<string, unknown>>(text),
		close: async () => {
			await db.exec('RESET ROLE');
		},
	};
}

async function harness(initial: Partial<FakeState> = {}): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-vercel-start-'));
	const bin = await mkdtemp(join(tmpdir(), 'flowdular-vercel-bin-'));
	const db = await ownerDatabase();
	const originalPath = process.env.PATH;
	const statePath = join(bin, 'state.json');
	const logPath = join(bin, 'log.jsonl');
	cleanups.push(async () => {
		process.env.PATH = originalPath;
		delete process.env.FAKE_VERCEL_STATE;
		delete process.env.FAKE_VERCEL_LOG;
		await db.close();
		await rm(root, { recursive: true, force: true });
		await rm(bin, { recursive: true, force: true });
	});
	await mkdir(join(root, 'infra/vercel'), { recursive: true });
	await mkdir(join(root, 'platform'), { recursive: true });
	await writeFile(
		join(root, 'vercel.json'),
		'{"framework":null,"buildCommand":"node infra/vercel/build.mjs"}',
	);
	for (const path of [
		'infra/vercel/build.mjs',
		'infra/vercel/handler.mjs',
		'platform/package.json',
		'platform/octane.config.ts',
	])
		await writeFile(join(root, path), 'fixture');
	await copyFile(
		new URL('../../../.vercelignore', import.meta.url),
		join(root, '.vercelignore'),
	);
	await writeFile(join(bin, 'vercel'), FAKE_VERCEL);
	await chmod(join(bin, 'vercel'), 0o755);
	await writeFile(
		statePath,
		JSON.stringify({
			version: '62.2.0',
			projectId: 'prj_fake123',
			projectName: 'acme-app',
			env: {},
			stores: [],
			deploys: 0,
			pulled: [],
			hobby: false,
			plan: null,
			loggedOut: false,
			neonFails: false,
			neonUrl: OWNER_URL,
			neonPooledUrl: POOLED_URL,
			deployOutcome: 'ok',
			inspectStates: ['READY'],
			envRmFails: false,
			...initial,
		} satisfies FakeState),
	);
	await writeFile(logPath, '');
	process.env.PATH = `${bin}:${originalPath ?? ''}`;
	process.env.FAKE_VERCEL_STATE = statePath;
	process.env.FAKE_VERCEL_LOG = logPath;

	const output: string[] = [];
	const capture = (chunk: unknown) => {
		output.push(String(chunk));
		return true;
	};
	vi.spyOn(process.stdout, 'write').mockImplementation(capture);
	vi.spyOn(process.stderr, 'write').mockImplementation(capture);

	const state = async () =>
		JSON.parse(await readFile(statePath, 'utf8')) as FakeState;
	let readyProbes = 0;
	const result: Harness = {
		root,
		db,
		output,
		platformCalls: [],
		fetches: [],
		databaseUrls: [],
		waits: [],
		workspaces: 0,
		unreadyProbes: 1,
		waitError: null,
		state,
		async update(change) {
			const current = await state();
			change(current);
			await writeFile(statePath, JSON.stringify(current));
		},
		async log() {
			return (await readFile(logPath, 'utf8'))
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Invocation);
		},
		async clearLog() {
			await writeFile(logPath, '');
		},
		async backup() {
			const contents = await readFile(
				join(root, '.flowdular/deploy/vercel-prj_fake123.env'),
				'utf8',
			);
			return new Map(
				contents
					.split('\n')
					.filter((line) => /^[A-Z]/.test(line))
					.map((line) => {
						const separator = line.indexOf('=');
						return [line.slice(0, separator), line.slice(separator + 1)];
					}),
			);
		},
		start(args = []) {
			return runDeployment(
				{ root, configPath: join(root, 'flowdular.json'), config: {} },
				'start',
				'vercel',
				parseArguments(['deploy', 'start', 'vercel', '--apply', ...args]),
				{ input: true, output: true, errors: true },
				host,
			);
		},
	};
	const host: VercelLaunchHost = {
		async openDatabase(url) {
			result.databaseUrls.push(url);
			await db.exec('SET ROLE app_owner');
			return ownerSession(db);
		},
		async runPlatformCommand(args, environment) {
			result.platformCalls.push({ args, environment });
			return success({
				total: result.workspaces,
				limit: 1,
				workspaces: [],
			});
		},
		async fetch(url, init) {
			result.fetches.push({
				url,
				authorization: new Headers(init.headers).get('authorization'),
			});
			if (url.endsWith('/api/ready')) {
				readyProbes += 1;
				return new Response('', {
					status: readyProbes > result.unreadyProbes ? 200 : 503,
				});
			}
			const secret = (await state()).env.CRON_SECRET?.value;
			return new Response('', {
				status:
					secret &&
					new Headers(init.headers).get('authorization') === `Bearer ${secret}`
						? 200
						: 401,
			});
		},
		async wait(ms) {
			if (result.waitError) throw result.waitError;
			result.waits.push(ms);
		},
	};
	return result;
}

function commandOf(invocation: Invocation): string {
	const argv = [...invocation.argv];
	const scope = argv.indexOf('--scope');
	if (scope >= 0) argv.splice(scope, 2);
	return argv.join(' ');
}

function writes(log: readonly Invocation[]): Invocation[] {
	return log.filter(
		(entry) =>
			!['--version', 'whoami', 'env ls', 'env pull', 'storage list'].some(
				(read) => commandOf(entry).startsWith(read),
			),
	);
}

/* PostgreSQL stores SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>. */
function scramMatches(verifier: unknown, password: string): boolean {
	const match = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(
		String(verifier),
	);
	if (!match) return false;
	const salted = pbkdf2Sync(
		password,
		Buffer.from(match[2]!, 'base64'),
		Number(match[1]),
		32,
		'sha256',
	);
	const clientKey = createHmac('sha256', salted).update('Client Key').digest();
	return createHash('sha256')
		.update(clientKey)
		.digest()
		.equals(Buffer.from(match[3]!, 'base64'));
}

async function applicationRoles(db: PGlite) {
	return (
		await db.query<{
			rolname: string;
			rolpassword: string;
			rolsuper: boolean;
			rolbypassrls: boolean;
			rolcanlogin: boolean;
		}>(
			`SELECT rolname, rolpassword, rolsuper, rolbypassrls, rolcanlogin
			   FROM pg_authid WHERE rolname LIKE 'flowdular\\_%' ORDER BY rolname`,
		)
	).rows;
}

function expectNoSecret(text: string, secrets: Iterable<string>): void {
	for (const secret of secrets) expect(text).not.toContain(secret);
}

function sha256(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

const TOKEN_FILE = '.flowdular/deploy/vercel-prj_fake123.setup-token';
const DEPLOYMENT_URL = 'https://acme-app-abc123-team.vercel.app';

describe('deploy start vercel', () => {
	it('provisions the database, keys and storage, sends secrets only through stdin and deploys', async () => {
		const run = await harness();
		const result = await run.start();
		expect(result.error).toBeUndefined();
		const data = result.data as Record<string, unknown>;
		expect(data).toMatchObject({
			target: 'vercel',
			status: 'deployed',
			url: 'https://acme-app.vercel.app',
			plan: null,
			readiness: 200,
			workerTick: 200,
			cronSchedule: '* * * * *',
			setup: { url: 'https://acme-app.vercel.app/setup' },
			keyBackup: '.flowdular/deploy/vercel-prj_fake123.env',
		});
		const token = (data.setup as { token: string }).token;
		expect(Buffer.from(token, 'base64url')).toHaveLength(32);

		const backupPath = join(
			run.root,
			'.flowdular/deploy/vercel-prj_fake123.env',
		);
		expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
		expect((await stat(join(run.root, '.flowdular/deploy'))).mode & 0o777).toBe(
			0o700,
		);
		const backup = await run.backup();
		expect(backup.get('FD_DATABASE_MIGRATOR_URL')).toBe(
			`postgresql://app_owner:${OWNER_PASSWORD}@${NEON_HOST}/neondb`,
		);
		const runtimePassword = backup.get('FD_DATABASE_RUNTIME_PASSWORD')!;
		const backgroundPassword = backup.get('FD_DATABASE_BACKGROUND_PASSWORD')!;
		expect(backup.get('FD_DATABASE_URL')).toBe(
			`postgresql://flowdular_runtime:${runtimePassword}@${NEON_HOST}/neondb`,
		);
		expect(backup.get('FD_DATABASE_BACKGROUND_URL')).toBe(
			`postgresql://flowdular_background:${backgroundPassword}@${NEON_HOST}/neondb`,
		);
		expect(run.databaseUrls.map((url) => url.hostname)).toEqual([NEON_HOST]);

		const roles = await applicationRoles(run.db);
		expect(roles.map((role) => role.rolname)).toEqual([
			'flowdular_background',
			'flowdular_runtime',
		]);
		for (const role of roles) {
			expect(role).toMatchObject({
				rolsuper: false,
				rolbypassrls: false,
				rolcanlogin: true,
			});
		}
		expect(scramMatches(roles[0]!.rolpassword, backgroundPassword)).toBe(true);
		expect(scramMatches(roles[1]!.rolpassword, runtimePassword)).toBe(true);

		const state = await run.state();
		const uploaded = [
			'FD_AGENT_CREDENTIAL_KEY',
			'FD_AGENT_RUN_GRANT_KEY',
			'FD_AUTH_MFA_KEY',
			'FD_APPROVAL_GRANT_KEY',
			'FD_AUTOMATIONS_CREDENTIAL_KEY',
			'FD_NOTIFICATIONS_SECRET_KEY',
			'FD_WORKFLOWS_PAYLOAD_KEY',
			'FD_WORKFLOWS_CURSOR_KEY',
			'FD_STORAGE_ENCRYPTION_KEY',
			'FD_CONNECTORS_SECRET_KEY',
			'FD_AUDIT_ANCHOR_KEY',
			'CRON_SECRET',
			'FD_DATABASE_URL',
			'FD_DATABASE_BACKGROUND_URL',
			'FD_DATABASE_MIGRATOR_URL',
		];
		const log = await run.log();
		for (const name of uploaded) {
			expect(state.env[name], name).toEqual({
				value: backup.get(name),
				type: 'sensitive',
			});
			expect(
				log.filter((entry) =>
					commandOf(entry).startsWith(`env add ${name} production`),
				),
				name,
			).toEqual([expect.objectContaining({ stdin: backup.get(name) })]);
		}
		expect(
			Buffer.from(backup.get('FD_AUTH_MFA_KEY')!, 'base64url'),
		).toHaveLength(32);
		expect(
			Buffer.from(backup.get('FD_AUDIT_ANCHOR_KEY')!, 'base64'),
		).toHaveLength(32);
		expect(data.generatedKeys).toHaveLength(12);
		expect(
			Object.fromEntries(
				[
					'FD_DATABASE_ADAPTER',
					'FD_DATABASE_TLS',
					'FD_STORAGE_ADAPTER',
					'FD_STORAGE_MAX_OBJECT_BYTES',
					'FD_AUTH_PUBLIC_ORIGIN',
				].map((name) => [name, state.env[name]?.value]),
			),
		).toEqual({
			FD_DATABASE_ADAPTER: 'postgresql',
			FD_DATABASE_TLS: 'verify-full',
			FD_STORAGE_ADAPTER: 'vercel-blob',
			FD_STORAGE_MAX_OBJECT_BYTES: '4194304',
			FD_AUTH_PUBLIC_ORIGIN: 'https://acme-app.vercel.app',
		});
		expect(state.env.BLOB_STORE_ID?.value).toBe('store_1');
		expect(state.stores).toEqual([
			expect.objectContaining({ name: 'acme-app-files' }),
		]);
		expect(state.deploys).toBe(1);
		expect(state.env.FD_VERCEL_PLAN).toBeUndefined();
		expect(state.env.FD_SETUP_TOKEN_SHA256).toEqual({
			value: sha256(token),
			type: 'sensitive',
		});
		expect(
			log.filter((entry) =>
				commandOf(entry).startsWith('env add FD_SETUP_TOKEN_SHA256 production'),
			),
		).toEqual([expect.objectContaining({ stdin: sha256(token) })]);

		const neon = log.find((entry) =>
			commandOf(entry).startsWith('integration add neon'),
		)!;
		expect(neon.cwd).not.toBe(run.root);
		expect(neon.linked).toBe(true);
		await expect(access(neon.cwd)).rejects.toThrow();
		expect(state.pulled).toHaveLength(1);
		expect(state.pulled[0]!.startsWith(run.root)).toBe(false);
		await expect(access(state.pulled[0]!)).rejects.toThrow();

		const secrets = [
			OWNER_PASSWORD,
			...uploaded.map((name) => backup.get(name)!),
		];
		secrets.push(runtimePassword, backgroundPassword, sha256(token));
		for (const entry of log)
			expectNoSecret(entry.argv.join(' '), [...secrets, token]);
		const printed = run.output.join('');
		expectNoSecret(printed, [...secrets, token]);
		expect(printed).toContain('build: CRON_SECRET=[redacted]');
		expect(printed).toContain('build: FD_SETUP_TOKEN_SHA256=[redacted]');
		expectNoSecret(JSON.stringify(result), secrets);
		const rendered = renderOutput(result, false);
		expectNoSecret(rendered, secrets);
		expect(rendered).toContain('https://acme-app.vercel.app/setup');
		expect(rendered).toContain(token);
		expect(rendered).toContain(TOKEN_FILE);
		expect(rendered).toContain('.flowdular/deploy/vercel-prj_fake123.env');

		expect(run.platformCalls.map((call) => call.args.slice(2, 4))).toEqual([
			['auth', 'workspaces'],
		]);
		for (const call of run.platformCalls) {
			expectNoSecret(call.args.join(' '), [...secrets, token]);
			expect(call.environment).toMatchObject({
				NODE_ENV: 'production',
				FD_DATABASE_ADAPTER: 'postgresql',
				FD_DATABASE_TLS: 'verify-full',
				FD_DATABASE_TLS_CA: '',
				FD_DATABASE_URL: backup.get('FD_DATABASE_URL'),
				FD_DATABASE_BACKGROUND_URL: backup.get('FD_DATABASE_BACKGROUND_URL'),
				FD_DATABASE_MIGRATOR_URL: backup.get('FD_DATABASE_MIGRATOR_URL'),
				FD_AUTH_MFA_KEY: backup.get('FD_AUTH_MFA_KEY'),
			});
		}
		expect(run.fetches.at(-1)).toEqual({
			url: 'https://acme-app.vercel.app/api/internal/worker/tick',
			authorization: `Bearer ${backup.get('CRON_SECRET')}`,
		});

		const journal = JSON.parse(
			await readFile(join(run.root, '.flowdular/deployments.json'), 'utf8'),
		) as { target: string; outcome: string; auditId: string }[];
		expect(journal).toEqual([
			expect.objectContaining({
				target: 'vercel',
				outcome: 'started',
				auditId: result.auditId,
			}),
		]);
		await expect(
			access(join(run.root, '.flowdular/deployment.lock')),
		).rejects.toThrow();
	});

	it('resumes on a rerun without regenerating or uploading anything', async () => {
		const run = await harness();
		expect((await run.start()).ok).toBe(true);
		run.workspaces = 1;
		const backupFile = join(
			run.root,
			'.flowdular/deploy/vercel-prj_fake123.env',
		);
		const backupBefore = await readFile(backupFile, 'utf8');
		const envBefore = (await run.state()).env;
		delete envBefore.FD_SETUP_TOKEN_SHA256;
		await run.clearLog();

		const rerun = await run.start();
		expect(rerun.error).toBeUndefined();
		expect(rerun.data).toMatchObject({ setup: null, generatedKeys: [] });
		expect(writes(await run.log()).map(commandOf)).toEqual([
			'env rm FD_SETUP_TOKEN_SHA256 production --yes',
			'deploy --prod --yes',
		]);
		expect(await readFile(backupFile, 'utf8')).toBe(backupBefore);
		const state = await run.state();
		expect(state.env).toEqual(envBefore);
		expect(state.deploys).toBe(2);
		const backup = await run.backup();
		const roles = await applicationRoles(run.db);
		expect(
			scramMatches(
				roles[1]!.rolpassword,
				backup.get('FD_DATABASE_RUNTIME_PASSWORD')!,
			),
		).toBe(true);
	});

	it('reuses the saved setup token on a rerun before the first workspace exists', async () => {
		const run = await harness();
		const first = await run.start();
		const before = (first.data as { setup: { token: string } }).setup.token;
		const saved = await readFile(join(run.root, TOKEN_FILE), 'utf8');
		await run.clearLog();

		const rerun = await run.start();
		expect(rerun.error).toBeUndefined();
		const after = (rerun.data as { setup: { token: string } }).setup.token;
		expect(after).toBe(before);
		expect(await readFile(join(run.root, TOKEN_FILE), 'utf8')).toBe(saved);
		expect((await run.state()).env.FD_SETUP_TOKEN_SHA256?.value).toBe(
			sha256(after),
		);
		expect(
			writes(await run.log()).filter((entry) =>
				commandOf(entry).startsWith('env '),
			),
		).toEqual([
			expect.objectContaining({
				argv: [
					'env',
					'update',
					'FD_SETUP_TOKEN_SHA256',
					'production',
					'--sensitive',
					'--yes',
				],
				stdin: sha256(after),
			}),
		]);
	});

	it('saves the setup token in a 0600 file before its digest leaves the machine and names the file before deploying', async () => {
		const run = await harness();
		const result = await run.start();
		expect(result.error).toBeUndefined();
		const setup = (
			result.data as { setup: { url: string; token: string; file: string } }
		).setup;
		expect(setup).toMatchObject({
			url: 'https://acme-app.vercel.app/setup',
			file: TOKEN_FILE,
		});
		expect((await stat(join(run.root, TOKEN_FILE))).mode & 0o777).toBe(0o600);
		expect(await readFile(join(run.root, TOKEN_FILE), 'utf8')).toBe(
			`${setup.token}\n`,
		);

		const log = await run.log();
		const upload = log.findIndex((entry) =>
			commandOf(entry).startsWith('env add FD_SETUP_TOKEN_SHA256 production'),
		);
		expect(log[upload]).toMatchObject({
			stdin: sha256(setup.token),
			tokenFile: { mode: 0o600, text: `${setup.token}\n` },
		});
		expect(
			log.findIndex((entry) => commandOf(entry) === 'deploy --prod --yes'),
		).toBeGreaterThan(upload);

		const lines = run.output.join('').split('\n');
		expect(lines.join('\n')).not.toContain(setup.token);
		expect(lines).toContain('build: setup token [redacted]');
		const notice = lines.findIndex(
			(line) => line.includes(setup.url) && line.includes(TOKEN_FILE),
		);
		expect(notice).toBeGreaterThanOrEqual(0);
		expect(notice).toBeLessThan(
			lines.findIndex((line) => line.startsWith('build: ')),
		);
	});

	it('replaces a saved setup token that is not a token and refuses a token path that is not a file', async () => {
		const run = await harness();
		const first = await run.start();
		const before = (first.data as { setup: { token: string } }).setup.token;
		await writeFile(join(run.root, TOKEN_FILE), 'not-a-token\n');

		const rerun = await run.start();
		expect(rerun.error).toBeUndefined();
		const after = (rerun.data as { setup: { token: string } }).setup.token;
		expect(after).not.toBe(before);
		expect(Buffer.from(after, 'base64url')).toHaveLength(32);
		expect(await readFile(join(run.root, TOKEN_FILE), 'utf8')).toBe(
			`${after}\n`,
		);
		expect((await run.state()).env.FD_SETUP_TOKEN_SHA256?.value).toBe(
			sha256(after),
		);

		await rm(join(run.root, TOKEN_FILE));
		await mkdir(join(run.root, TOKEN_FILE));
		await run.clearLog();
		const refused = await run.start();
		expect(refused.error?.code).toBe('SETUP_TOKEN_INVALID');
		expect(refused.error?.message).toContain(TOKEN_FILE);
		expect(
			writes(await run.log()).filter((entry) =>
				commandOf(entry).includes('FD_SETUP_TOKEN_SHA256'),
			),
		).toEqual([]);
	});

	it('deletes the setup token and its digest once a workspace exists, and only warns when Vercel keeps the digest', async () => {
		const run = await harness();
		expect((await run.start()).ok).toBe(true);
		run.workspaces = 1;
		await run.clearLog();

		const retired = await run.start();
		expect(retired.error).toBeUndefined();
		expect(retired.data).toMatchObject({ setup: null });
		await expect(access(join(run.root, TOKEN_FILE))).rejects.toThrow();
		expect((await run.state()).env.FD_SETUP_TOKEN_SHA256).toBeUndefined();
		expect(
			writes(await run.log())
				.map(commandOf)
				.filter((command) => command.startsWith('env ')),
		).toEqual(['env rm FD_SETUP_TOKEN_SHA256 production --yes']);
		expect(retired.warnings.join('\n')).not.toContain('FD_SETUP_TOKEN_SHA256');

		await run.update((state) => {
			state.env.FD_SETUP_TOKEN_SHA256 = {
				value: sha256('spent'),
				type: 'sensitive',
			};
			state.envRmFails = true;
		});
		const kept = await run.start();
		expect(kept.error).toBeUndefined();
		expect(kept.data).toMatchObject({ status: 'deployed', setup: null });
		expect(kept.warnings.join('\n')).toContain(
			'Removing FD_SETUP_TOKEN_SHA256 from Production failed',
		);
		expect((await run.state()).env.FD_SETUP_TOKEN_SHA256).toBeDefined();
	});

	it('finishes the launch when Vercel builds a deployment the local CLI lost track of', async () => {
		const run = await harness({
			deployOutcome: 'lost-after-url',
			inspectStates: ['QUEUED', 'BUILDING', 'READY'],
		});
		const result = await run.start();
		expect(result.error).toBeUndefined();
		const data = result.data as {
			setup: { token: string; file: string };
		};
		expect(data).toMatchObject({
			status: 'deployed',
			readiness: 200,
			workerTick: 200,
			setup: { url: 'https://acme-app.vercel.app/setup', file: TOKEN_FILE },
		});
		expect(renderOutput(result, false)).toContain(data.setup.token);
		expect((await run.state()).deploys).toBe(1);
		expect((await run.log()).map(commandOf)).toContain(
			`inspect ${DEPLOYMENT_URL} --json`,
		);
		expect(run.fetches.at(-1)?.url).toBe(
			'https://acme-app.vercel.app/api/internal/worker/tick',
		);
		expect(run.output.join('')).not.toContain(data.setup.token);
	});

	it.each(['ERROR', 'CANCELED'])(
		'fails with the setup token file named when Vercel reports the deployment %s',
		async (state) => {
			const run = await harness({
				deployOutcome: 'lost-after-url',
				inspectStates: ['BUILDING', state],
			});
			const result = await run.start();
			expect(result.error?.code).toBe('DEPLOY_FAILED');
			expect(result.error?.message).toContain(DEPLOYMENT_URL);
			expect(result.error?.message).toContain(state);
			expect(result.error?.message).toContain(TOKEN_FILE);
			const token = (await readFile(join(run.root, TOKEN_FILE), 'utf8')).trim();
			expect(result.error?.message).not.toContain(token);
			expect(run.output.join('')).not.toContain(token);
			expect(run.fetches).toEqual([]);
		},
	);

	it('gives up on a deployment still building after about 15 minutes', async () => {
		const run = await harness({
			deployOutcome: 'lost-after-url',
			inspectStates: ['BUILDING'],
		});
		const result = await run.start();
		expect(result.error?.code).toBe('DEPLOY_FAILED');
		expect(result.error?.message).toContain(DEPLOYMENT_URL);
		expect(result.error?.message).toContain(TOKEN_FILE);
		const token = (await readFile(join(run.root, TOKEN_FILE), 'utf8')).trim();
		expect(result.error?.message).not.toContain(token);
		expect(run.output.join('')).not.toContain(token);
		const waited = run.waits.reduce((total, ms) => total + ms, 0);
		expect(waited).toBeGreaterThanOrEqual(14 * 60_000);
		expect(waited).toBeLessThanOrEqual(16 * 60_000);
		for (const ms of run.waits) {
			expect(ms).toBeGreaterThanOrEqual(10_000);
			expect(ms).toBeLessThanOrEqual(15_000);
		}
		expect(run.fetches).toEqual([]);
	}, 120_000);

	it('fails as before when the local CLI stops before Vercel creates a deployment', async () => {
		const run = await harness({ deployOutcome: 'lost-before-url' });
		const result = await run.start();
		expect(result.error?.code).toBe('DEPLOY_FAILED');
		expect(result.error?.message).toContain('vercel deploy --prod failed');
		expect(result.error?.message).toContain(TOKEN_FILE);
		const token = (await readFile(join(run.root, TOKEN_FILE), 'utf8')).trim();
		expect(result.error?.message).not.toContain(token);
		expect(
			(await run.log()).some((entry) => commandOf(entry).startsWith('inspect')),
		).toBe(false);
	});

	it('names the setup token file when the launch stops on an unexpected error', async () => {
		const run = await harness({
			deployOutcome: 'lost-after-url',
			inspectStates: ['BUILDING'],
		});
		run.waitError = new Error('The terminal closed.');
		const result = await run.start();
		expect(result.error?.code).toBe('DEPLOY_START_FAILED');
		expect(result.error?.message).toContain('The terminal closed.');
		expect(result.error?.message).toContain(TOKEN_FILE);
		const token = (await readFile(join(run.root, TOKEN_FILE), 'utf8')).trim();
		expect(result.error?.message).not.toContain(token);
	});

	it('names the setup token file when the deployment never answers ready', async () => {
		const run = await harness();
		run.unreadyProbes = Number.POSITIVE_INFINITY;
		const result = await run.start();
		expect(result.error).toBeUndefined();
		expect(result.data).toMatchObject({ readiness: 503, workerTick: null });
		const warning = result.warnings.find((entry) =>
			entry.includes('/api/ready answered 503'),
		);
		expect(warning).toContain(TOKEN_FILE);
	});

	it('uploads a key that only the local backup still holds', async () => {
		const run = await harness();
		expect((await run.start()).ok).toBe(true);
		run.workspaces = 1;
		await run.update((state) => {
			delete state.env.FD_AUDIT_ANCHOR_KEY;
		});
		await run.clearLog();

		const rerun = await run.start();
		expect(rerun.error).toBeUndefined();
		const backup = await run.backup();
		expect(
			writes(await run.log()).filter((entry) =>
				/^env (add|update) /.test(commandOf(entry)),
			),
		).toEqual([
			expect.objectContaining({
				argv: [
					'env',
					'add',
					'FD_AUDIT_ANCHOR_KEY',
					'production',
					'--sensitive',
				],
				stdin: backup.get('FD_AUDIT_ANCHOR_KEY'),
			}),
		]);
		expect((await run.state()).env.FD_AUDIT_ANCHOR_KEY?.value).toBe(
			backup.get('FD_AUDIT_ANCHOR_KEY'),
		);
		expect(rerun.data).toMatchObject({ generatedKeys: [] });
	});

	it('keeps variables Vercel already has and names the keys it cannot back up', async () => {
		const remoteKey = 'remote-only-agent-credential-key-0123456789';
		const run = await harness({
			env: {
				FD_AGENT_CREDENTIAL_KEY: { value: remoteKey, type: 'sensitive' },
				FD_AUTH_PUBLIC_ORIGIN: {
					value: 'https://erp.example.com',
					type: 'sensitive',
				},
			},
		});
		const result = await run.start();
		expect(result.error).toBeUndefined();
		expect(result.warnings.join('\n')).toContain('FD_AGENT_CREDENTIAL_KEY');
		const backup = await run.backup();
		expect(backup.has('FD_AGENT_CREDENTIAL_KEY')).toBe(false);
		const state = await run.state();
		expect(state.env.FD_AGENT_CREDENTIAL_KEY?.value).toBe(remoteKey);
		expect(state.env.FD_AUTH_PUBLIC_ORIGIN?.value).toBe(
			'https://erp.example.com',
		);
		const touched = writes(await run.log()).map(commandOf);
		expect(
			touched.some((command) => command.includes('FD_AGENT_CREDENTIAL_KEY')),
		).toBe(false);
		expect(
			touched.some((command) => command.includes('FD_AUTH_PUBLIC_ORIGIN')),
		).toBe(false);
	});

	it('switches to the Hobby plan and deploys exactly once more when Vercel rejects the cron of an unknown plan', async () => {
		const run = await harness({ hobby: true });
		const result = await run.start();
		expect(result.error).toBeUndefined();
		expect(result.data).toMatchObject({
			plan: 'hobby',
			cronSchedule: '0 3 * * *',
		});
		expect(result.warnings.join('\n')).toContain('non-commercial');
		const state = await run.state();
		expect(state.deploys).toBe(2);
		expect(state.env.FD_VERCEL_PLAN?.value).toBe('hobby');
		expect(state.env.FD_VERCEL_CRON_SCHEDULE).toBeUndefined();
		const sequence = writes(await run.log())
			.map(commandOf)
			.filter(
				(command) =>
					command.startsWith('deploy') || command.includes('FD_VERCEL_'),
			);
		expect(sequence).toEqual([
			'deploy --prod --yes',
			'env add FD_VERCEL_PLAN production --sensitive',
			'deploy --prod --yes',
		]);
	});

	it('sizes the deployment to the plan whoami reports and follows a change of plan', async () => {
		const run = await harness({ hobby: true, plan: 'hobby' });
		const hobby = await run.start();
		expect(hobby.error).toBeUndefined();
		expect(hobby.data).toMatchObject({
			plan: 'hobby',
			cronSchedule: '0 3 * * *',
		});
		expect(hobby.warnings.join('\n')).toContain('non-commercial');
		expect((await run.state()).deploys).toBe(1);
		expect((await run.state()).env.FD_VERCEL_PLAN?.value).toBe('hobby');

		await run.update((state) => {
			state.hobby = false;
			state.plan = 'enterprise';
		});
		const upgraded = await run.start();
		expect(upgraded.error).toBeUndefined();
		expect(upgraded.data).toMatchObject({
			plan: 'pro',
			cronSchedule: '* * * * *',
		});
		expect(upgraded.warnings.join('\n')).not.toContain('Hobby');
		expect((await run.state()).env.FD_VERCEL_PLAN?.value).toBe('pro');
		expect((await run.state()).deploys).toBe(2);
	});

	it('refuses --plan pro on a team Vercel holds to Hobby instead of overriding it', async () => {
		const run = await harness({ hobby: true, plan: 'hobby' });
		const result = await run.start(['--plan', 'pro']);
		expect(result.error?.code).toBe('DEPLOY_CRON_REJECTED');
		expect(result.error?.message).toContain('--plan hobby');
		expect((await run.state()).deploys).toBe(1);
		expect((await run.state()).env.FD_VERCEL_PLAN?.value).toBe('pro');
	});

	it('refuses an explicit cron the Hobby plan rejects instead of replacing it', async () => {
		const run = await harness({ hobby: true });
		const result = await run.start(['--cron', '*/5 * * * *']);
		expect(result.error?.code).toBe('DEPLOY_CRON_REJECTED');
		expect((await run.state()).deploys).toBe(1);
		const journal = JSON.parse(
			await readFile(join(run.root, '.flowdular/deployments.json'), 'utf8'),
		) as { outcome: string }[];
		expect(journal.at(-1)?.outcome).toBe('unknown');
	});

	it('plans without running anything that writes', async () => {
		const run = await harness();
		const plan = await runDeployment(
			{ root: run.root, configPath: '', config: {} },
			'start',
			'vercel',
			parseArguments(['deploy', 'start', 'vercel', '--project', 'acme-app']),
			{ input: true, output: true, errors: true },
		);
		expect(plan.ok).toBe(true);
		const data = plan.data as { status: string; steps: string[] };
		expect(data.status).toBe('ready-to-start');
		expect(data.steps.join('\n')).toContain('--project acme-app');
		expect(renderOutput(plan, false)).toContain('STEP 1  ');
		expect((await run.log()).map(commandOf)).toEqual(['--version']);
		await expect(access(join(run.root, '.flowdular'))).rejects.toThrow();
		await expect(access(join(run.root, '.vercel'))).rejects.toThrow();
		expect(await applicationRoles(run.db)).toEqual([]);
	});

	it('takes the owner URL only from a named variable, never from argv', async () => {
		const run = await harness();
		const literal = await run.start(['--database-url-env', OWNER_URL]);
		expect(literal.error?.code).toBe('USAGE_ERROR');
		expect(await run.log()).toEqual([]);

		process.env.FLOWDULAR_TEST_OWNER_URL = OWNER_URL.replace(
			NEON_HOST,
			'db.internal.example',
		);
		cleanups.push(async () => {
			delete process.env.FLOWDULAR_TEST_OWNER_URL;
		});
		const result = await run.start([
			'--database-url-env',
			'FLOWDULAR_TEST_OWNER_URL',
		]);
		expect(result.error).toBeUndefined();
		expect(run.databaseUrls.map((url) => url.hostname)).toEqual([
			'db.internal.example',
		]);
		const commands = (await run.log()).map(commandOf);
		expect(commands.some((command) => command.startsWith('integration'))).toBe(
			false,
		);
		expect(commands.some((command) => command.startsWith('env pull'))).toBe(
			false,
		);
	});

	it('refuses a pooled owner URL before creating roles or keys', async () => {
		const run = await harness({ neonUrl: POOLED_URL });
		const result = await run.start();
		expect(result.error?.code).toBe('DATABASE_URL_POOLED');
		expect(result.error?.message).not.toContain(OWNER_PASSWORD);
		expect(await applicationRoles(run.db)).toEqual([]);
		await expect(access(join(run.root, '.flowdular/deploy'))).rejects.toThrow();
	});

	/* Provisioning a 0.5 database would record its URL in the key backup and
	   Vercel, and every later migration refuses that database. */
	it('refuses a database created before 0.6 before provisioning anything, then launches on a new one', async () => {
		const run = await harness();
		process.env.FLOWDULAR_TEST_OWNER_URL = OWNER_URL;
		cleanups.push(async () => {
			delete process.env.FLOWDULAR_TEST_OWNER_URL;
		});
		await run.db.exec(
			'CREATE TABLE _coreloom_migrations_v2 (namespace TEXT, id TEXT)',
		);

		const refused = await run.start([
			'--database-url-env',
			'FLOWDULAR_TEST_OWNER_URL',
		]);
		expect(refused.error?.code).toBe('LEGACY_DATABASE');
		expect(refused.error?.message).toContain('Flowdular 0.5 or earlier');
		expect(refused.error?.message).toContain(
			'$FLOWDULAR_TEST_OWNER_URL (--database-url-env FLOWDULAR_TEST_OWNER_URL)',
		);
		expect(refused.error?.message).not.toContain(OWNER_PASSWORD);
		expect(await applicationRoles(run.db)).toEqual([]);
		await expect(access(join(run.root, '.flowdular/deploy'))).rejects.toThrow();
		expect(
			writes(await run.log())
				.map(commandOf)
				.filter((command) => !command.startsWith('link')),
		).toEqual([]);
		expect(run.platformCalls).toEqual([]);

		await run.db.exec('DROP TABLE _coreloom_migrations_v2');
		const launched = await run.start([
			'--database-url-env',
			'FLOWDULAR_TEST_OWNER_URL',
		]);
		expect(launched.error).toBeUndefined();
		expect(
			(await applicationRoles(run.db)).map((role) => role.rolname),
		).toEqual(['flowdular_background', 'flowdular_runtime']);
	});

	it('stops at a signed-out Vercel CLI before changing anything', async () => {
		const run = await harness({ loggedOut: true });
		const result = await run.start();
		expect(result.error?.code).toBe('VERCEL_LOGIN_REQUIRED');
		expect(result.error?.message).toContain('vercel login');
		expect(writes(await run.log())).toEqual([]);
		await expect(access(join(run.root, '.vercel'))).rejects.toThrow();
		await expect(access(join(run.root, '.flowdular/deploy'))).rejects.toThrow();
	});

	it('requires a .vercelignore that keeps the key backup and .env files out of the upload', async () => {
		const run = await harness();
		const workspace = { root: run.root, configPath: '', config: {} };
		const check = async () =>
			(
				(await deploymentPlan(workspace, 'vercel')).data as {
					checks: { id: string; status: string; message: string }[];
				}
			).checks.find((entry) => entry.id === 'vercel-upload-ignore')!;
		expect((await check()).status).toBe('pass');
		await copyFile(
			new URL(
				'../../create-flowdular/template/default/.vercelignore',
				import.meta.url,
			),
			join(run.root, '.vercelignore'),
		);
		expect((await check()).status).toBe('pass');
		await writeFile(join(run.root, '.vercelignore'), '.env\n.env.*\n');
		expect(await check()).toMatchObject({
			status: 'action-required',
			message: expect.stringContaining('.flowdular'),
		});
		const start = await run.start();
		expect(start.error?.code).toBe('DEPLOY_PREFLIGHT_FAILED');
		expect(writes(await run.log())).toEqual([]);
	});

	it('ships .gitignore files that vercel link leaves untouched without ignoring .env.example', async () => {
		for (const file of [
			'../../../.gitignore',
			'../../create-flowdular/template/default/_gitignore',
		]) {
			const lines = (
				await readFile(new URL(file, import.meta.url), 'utf8')
			).split('\n');
			/* vercel link appends .vercel, and the .env.local pull it runs appends
			   .env*, unless a line equals the entry exactly. */
			expect(lines, file).toContain('.vercel');
			expect(lines, file).toContain('.env*');
			expect(lines.indexOf('!.env.example'), file).toBeGreaterThan(
				lines.indexOf('.env*'),
			);
		}
	});
});

describe('application roles', () => {
	it('creates login roles the owner can grant to and the runtime role reads new tables through', async () => {
		const db = await ownerDatabase();
		cleanups.push(() => db.close());
		await db.exec('SET ROLE app_owner');
		const session = ownerSession(db);
		expect(await inspectApplicationRoles(session)).toEqual({
			runtime: false,
			background: false,
		});
		await applyApplicationRoles(session, {
			runtime: 'runtime-password-1',
			background: 'background-password-1',
		});
		await applyApplicationRoles(session, {
			runtime: 'runtime-password-2',
			background: 'background-password-1',
		});
		expect(await inspectApplicationRoles(session)).toEqual({
			runtime: true,
			background: true,
		});
		await db.exec('CREATE TABLE ledger (id integer PRIMARY KEY)');
		await session.close();
		await db.exec('CREATE ROLE outsider LOGIN');
		const privileges = (
			await db.query<Record<string, boolean>>(
				`SELECT has_table_privilege('flowdular_runtime', 'ledger', 'SELECT, INSERT, UPDATE, DELETE') AS runtime_tables,
				        has_table_privilege('flowdular_background', 'ledger', 'SELECT') AS background_tables,
				        has_database_privilege('flowdular_runtime', current_database(), 'CONNECT') AS runtime_connect,
				        has_database_privilege('flowdular_background', current_database(), 'CONNECT') AS background_connect,
				        has_schema_privilege('flowdular_background', 'public', 'USAGE') AS background_schema,
				        has_database_privilege('outsider', current_database(), 'CONNECT') AS outsider_connect,
				        has_schema_privilege('outsider', 'public', 'USAGE') AS outsider_schema`,
			)
		).rows[0];
		expect(privileges).toEqual({
			runtime_tables: true,
			background_tables: false,
			runtime_connect: true,
			background_connect: true,
			background_schema: true,
			outsider_connect: false,
			outsider_schema: false,
		});
		const roles = await applicationRoles(db);
		expect(scramMatches(roles[0]!.rolpassword, 'background-password-1')).toBe(
			true,
		);
		expect(scramMatches(roles[1]!.rolpassword, 'runtime-password-2')).toBe(
			true,
		);
	});

	it('leaves no role behind when a grant fails', async () => {
		const db = await ownerDatabase();
		cleanups.push(() => db.close());
		await db.exec('SET ROLE app_owner');
		const session = ownerSession(db);
		const failing: SqlSession = {
			query: (text) =>
				text.startsWith('GRANT USAGE')
					? Promise.reject(new Error('grant failed'))
					: session.query(text),
		};
		await expect(
			applyApplicationRoles(failing, {
				runtime: 'runtime-password',
				background: 'background-password',
			}),
		).rejects.toThrow('grant failed');
		await session.close();
		expect(await applicationRoles(db)).toEqual([]);
	});

	it('refuses a non-owner session and an existing role that bypasses row security', async () => {
		const db = await ownerDatabase();
		cleanups.push(() => db.close());
		await db.exec('CREATE ROLE tenant_reader LOGIN; SET ROLE tenant_reader');
		await expect(inspectApplicationRoles(ownerSession(db))).rejects.toThrow(
			'database owner',
		);
		await db.exec('RESET ROLE; CREATE ROLE flowdular_runtime LOGIN BYPASSRLS');
		await db.exec('SET ROLE app_owner');
		await expect(inspectApplicationRoles(ownerSession(db))).rejects.toThrow(
			'BYPASSRLS',
		);
	});
});
