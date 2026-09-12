import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
	access,
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
	BACKUP_MANIFEST_FILE,
	compareBackupKeys,
	createBackupManifest,
	databaseProviderConfigFromEnvironment,
	parseBackupManifest,
	type BackupManifest,
	type DatabaseProviderConfig,
} from '@flowdular/database';
import {
	failure,
	success,
	type CommandEnvelope,
} from '@flowdular/cli-protocol';
import type { Workspace } from './workspace.ts';

const POSTGRES_DUMP_FILE = 'database.dump';
const PGLITE_PAYLOAD_DIRECTORY = 'pglite';
/* Enough for a client tool's diagnostics without buffering a runaway log. */
const TOOL_OUTPUT_LIMIT = 4_000;

const runFile = promisify(execFile);

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function enabledModules(workspace: Workspace): readonly string[] {
	const enabled =
		(workspace.config.modules as { enabled?: string[] } | undefined)?.enabled ??
		[];
	return [...enabled].sort((left, right) => left.localeCompare(right));
}

function platformVersion(workspace: Workspace): string {
	const declared = workspace.config.architectureVersion;
	return typeof declared === 'string' ? declared : 'unknown';
}

/* A backup belongs outside the working tree as often as inside it, so an
   absolute path is taken as given and a relative one resolves from the root. */
function backupDirectory(workspace: Workspace, value: string): string {
	return isAbsolute(value) ? resolve(value) : resolve(workspace.root, value);
}

async function resolveTool(
	name: string,
	environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
	for (const directory of (environment.PATH ?? '').split(delimiter)) {
		if (!directory) continue;
		const candidate = resolve(directory, name);
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {
			/* An unreadable PATH entry is not this command's problem; a later one
			   may still hold the tool. */
		}
	}
	return undefined;
}

interface ToolResult {
	readonly ok: boolean;
	readonly output: string;
}

async function runTool(
	tool: string,
	toolArguments: readonly string[],
	environment: NodeJS.ProcessEnv,
): Promise<ToolResult> {
	try {
		await runFile(tool, [...toolArguments], {
			env: environment,
			maxBuffer: TOOL_OUTPUT_LIMIT * 16,
			windowsHide: true,
		});
		return { ok: true, output: '' };
	} catch (error) {
		const failed = error as { stderr?: string; stdout?: string };
		const output = `${failed.stderr ?? ''}${failed.stdout ?? ''}`.trim();
		return {
			ok: false,
			output: (output || reason(error)).slice(0, TOOL_OUTPUT_LIMIT),
		};
	}
}

interface PostgresConnection {
	readonly environment: NodeJS.ProcessEnv;
	readonly database: string;
	readonly host: string;
	readonly user: string;
}

/**
 * Runs one client tool against the migrator connection of the configured
 * environment. The credentials travel as `PG*` variables rather than as
 * arguments, so no password reaches the host's process list, and the child
 * inherits none of the platform's encryption keys.
 */
async function withPostgresConnection<T>(
	config: DatabaseProviderConfig,
	run: (connection: PostgresConnection) => Promise<T>,
): Promise<T> {
	const url = new URL(config.postgresql!.migrator.connectionString!);
	const database = decodeURIComponent(url.pathname.slice(1));
	const host = decodeURIComponent(url.hostname).replace(/^\[|\]$/g, '');
	const user = decodeURIComponent(url.username);
	const mode = config.environment.FD_DATABASE_TLS?.trim() || 'verify-full';
	const authorityFile = config.environment.FD_DATABASE_TLS_CA_FILE?.trim();
	const inlineAuthority = config.environment.FD_DATABASE_TLS_CA?.replaceAll(
		'\\n',
		'\n',
	).trim();
	/* libpq defaults to "prefer" and reads no FD_ variable, so the deployment's
	   TLS policy has to be restated for the child or a verify-full deployment
	   would be dumped over an unverified connection. The directory is created
	   before the try so the finally owns it from the moment it exists: a write
	   that fails must not leave the certificate on disk. */
	const temporaryDirectory =
		!authorityFile && inlineAuthority
			? await mkdtemp(join(tmpdir(), 'flowdular-backup-'))
			: undefined;
	try {
		let certificate = authorityFile;
		if (temporaryDirectory) {
			certificate = join(temporaryDirectory, 'ca.pem');
			await writeFile(certificate, `${inlineAuthority}\n`, {
				encoding: 'utf8',
				mode: 0o600,
			});
		}
		return await run({
			database,
			host,
			user,
			environment: {
				PATH: process.env.PATH ?? '',
				/* A connection string without a password still reaches ~/.pgpass and
				   ~/.postgresql, so the operator's home stays reachable. */
				...(process.env.HOME ? { HOME: process.env.HOME } : {}),
				PGHOST: host,
				PGDATABASE: database,
				PGUSER: user,
				PGSSLMODE: mode,
				...(url.port ? { PGPORT: url.port } : {}),
				...(url.password
					? { PGPASSWORD: decodeURIComponent(url.password) }
					: {}),
				...(certificate ? { PGSSLROOTCERT: certificate } : {}),
			},
		});
	} finally {
		if (temporaryDirectory) {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	}
}

async function writeManifest(
	path: string,
	manifest: BackupManifest,
): Promise<void> {
	await writeFile(path, `${JSON.stringify(manifest, null, '\t')}\n`, {
		encoding: 'utf8',
		mode: 0o600,
	});
}

/* The directory in use is removed only once the restored copy is in place, so
   a copy that fails halfway leaves the existing database untouched. */
async function replaceDirectory(source: string, target: string): Promise<void> {
	const suffix = randomUUID().slice(0, 8);
	const incoming = `${target}.incoming-${suffix}`;
	const replaced = `${target}.replaced-${suffix}`;
	await mkdir(dirname(target), { recursive: true });
	await cp(source, incoming, { recursive: true });
	const occupied = await exists(target);
	if (occupied) await rename(target, replaced);
	try {
		await rename(incoming, target);
	} catch (error) {
		if (occupied) await rename(replaced, target);
		await rm(incoming, { recursive: true, force: true });
		throw error;
	}
	await rm(replaced, { recursive: true, force: true });
}

export async function databaseBackup(
	workspace: Workspace,
	output: string | undefined,
	apply: boolean,
): Promise<CommandEnvelope> {
	if (!output) {
		return failure(
			'INPUT_REQUIRED',
			'Use database backup --output <dir> [--apply].',
		);
	}
	let config: DatabaseProviderConfig;
	try {
		config = databaseProviderConfigFromEnvironment(process.env, workspace.root);
	} catch (error) {
		return failure('DATABASE_CONFIGURATION_INVALID', reason(error));
	}
	const directory = backupDirectory(workspace, output);
	const manifestPath = join(directory, BACKUP_MANIFEST_FILE);
	if (await exists(manifestPath)) {
		return failure(
			'BACKUP_TARGET_EXISTS',
			`${manifestPath} already holds a backup. Choose a directory without one.`,
		);
	}
	const manifest = createBackupManifest({
		adapter: config.adapter,
		platformVersion: platformVersion(workspace),
		modules: enabledModules(workspace),
		environment: config.environment,
	});
	const warnings = [
		'Encryption keys live outside the database. Store the keys listed in backup.json with the backup, or restored credentials and workflow payloads stay unreadable.',
		...(apply ? [] : ['Dry run only. Pass --apply to write the backup.']),
	];

	if (config.adapter === 'postgresql') {
		const tool = await resolveTool('pg_dump', process.env);
		if (!tool) {
			return failure(
				'BACKUP_TOOL_MISSING',
				'pg_dump was not found on PATH. Install the PostgreSQL client tools matching the server version.',
			);
		}
		const payload = join(directory, POSTGRES_DUMP_FILE);
		const plan = {
			adapter: config.adapter,
			applied: apply,
			directory,
			payload,
			tool,
			manifest,
		};
		if (!apply) return success(plan, { warnings });
		/* The mode reaches only the directories this call creates; one that
		   already exists keeps the mode it was made with. */
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const result = await withPostgresConnection(config, (connection) =>
			/* --no-password keeps a missing credential a failure instead of a
			   prompt this process would wait on forever. */
			runTool(
				tool,
				['--format=custom', '--no-password', '--file', payload],
				connection.environment,
			),
		);
		if (!result.ok) {
			await rm(payload, { force: true });
			return failure('BACKUP_FAILED', `pg_dump failed: ${result.output}`);
		}
		/* pg_dump writes the archive under the caller's umask, so it is narrowed
		   before the manifest declares the backup complete. */
		await chmod(payload, 0o600);
		await writeManifest(manifestPath, manifest);
		return success(plan, { evidence: [manifestPath, payload], warnings });
	}

	const source = config.pglite?.dataDirectory;
	if (!source || !(await exists(source))) {
		return failure(
			'BACKUP_SOURCE_MISSING',
			source
				? `The embedded database directory ${source} does not exist yet.`
				: 'The embedded database runs in memory under NODE_ENV=test, so there is nothing to copy.',
		);
	}
	const payload = join(directory, PGLITE_PAYLOAD_DIRECTORY);
	const plan = {
		adapter: config.adapter,
		applied: apply,
		directory,
		payload,
		source,
		manifest,
	};
	warnings.unshift(
		'The embedded database is copied file by file. Stop the application first, or the copy can hold a torn state.',
	);
	if (!apply) return success(plan, { warnings });
	await mkdir(directory, { recursive: true, mode: 0o700 });
	try {
		await cp(source, payload, { recursive: true });
		// The copy keeps the source modes; the payload holds every row of every
		// tenant, so it is narrowed to the operator like the PostgreSQL dump.
		await restrictTree(payload);
	} catch (error) {
		await rm(payload, { recursive: true, force: true });
		return failure('BACKUP_FAILED', reason(error));
	}
	await writeManifest(manifestPath, manifest);
	return success(plan, { evidence: [manifestPath, payload], warnings });
}

async function restrictTree(root: string): Promise<void> {
	await chmod(root, 0o700);
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) await restrictTree(path);
		else if (entry.isFile()) await chmod(path, 0o600);
	}
}

export async function databaseRestore(
	workspace: Workspace,
	input: string | undefined,
	apply: boolean,
): Promise<CommandEnvelope> {
	if (!input) {
		return failure(
			'INPUT_REQUIRED',
			'Use database restore --input <dir> --apply --confirm restore-database.',
		);
	}
	let config: DatabaseProviderConfig;
	try {
		config = databaseProviderConfigFromEnvironment(process.env, workspace.root);
	} catch (error) {
		return failure('DATABASE_CONFIGURATION_INVALID', reason(error));
	}
	const directory = backupDirectory(workspace, input);
	const manifestPath = join(directory, BACKUP_MANIFEST_FILE);
	let manifest: BackupManifest;
	try {
		manifest = parseBackupManifest(
			JSON.parse(await readFile(manifestPath, 'utf8')),
		);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ENOENT'
			? failure(
					'BACKUP_MANIFEST_MISSING',
					`${manifestPath} does not exist, so ${directory} is not a backup.`,
				)
			: failure('BACKUP_MANIFEST_INVALID', reason(error));
	}
	if (manifest.adapter !== config.adapter) {
		return failure(
			'BACKUP_ADAPTER_MISMATCH',
			`The backup was taken from the ${manifest.adapter} adapter, but this workspace is configured for ${config.adapter}.`,
		);
	}
	const keys = compareBackupKeys(manifest, config.environment);
	const divergent = keys.filter((key) => key.status !== 'match');
	const warnings = [
		...(divergent.length === 0
			? []
			: [
					`BACKUP_KEY_MISMATCH: ${divergent
						.map((key) => `${key.variable} (${key.status})`)
						.join(
							', ',
						)}. Restore the keys this backup was taken with, or the credentials, MFA secrets and workflow payloads it carries stay unreadable.`,
				]),
		...(apply ? [] : ['Dry run only. Pass --apply to restore the database.']),
	];

	if (config.adapter === 'postgresql') {
		const tool = await resolveTool('pg_restore', process.env);
		if (!tool) {
			return failure(
				'BACKUP_TOOL_MISSING',
				'pg_restore was not found on PATH. Install the PostgreSQL client tools matching the server version.',
			);
		}
		const payload = join(directory, POSTGRES_DUMP_FILE);
		if (!(await exists(payload))) {
			return failure(
				'BACKUP_PAYLOAD_MISSING',
				`${payload} does not exist, so this backup carries no dump.`,
			);
		}
		const plan = {
			adapter: config.adapter,
			applied: apply,
			directory,
			payload,
			tool,
			manifest,
			keys,
		};
		if (!apply) return success(plan, { warnings });
		const result = await withPostgresConnection(config, (connection) =>
			runTool(
				tool,
				[
					'--clean',
					'--if-exists',
					'--no-password',
					'--dbname',
					connection.database,
					payload,
				],
				connection.environment,
			),
		);
		if (!result.ok) {
			return failure('RESTORE_FAILED', `pg_restore failed: ${result.output}`);
		}
		return success(plan, { evidence: [manifestPath, payload], warnings });
	}

	const payload = join(directory, PGLITE_PAYLOAD_DIRECTORY);
	if (!(await exists(payload))) {
		return failure(
			'BACKUP_PAYLOAD_MISSING',
			`${payload} does not exist, so this backup carries no embedded database.`,
		);
	}
	const target = config.pglite?.dataDirectory;
	if (!target) {
		return failure(
			'RESTORE_TARGET_MISSING',
			'The embedded database runs in memory under NODE_ENV=test, so there is nothing to restore into.',
		);
	}
	const plan = {
		adapter: config.adapter,
		applied: apply,
		directory,
		payload,
		target,
		manifest,
		keys,
	};
	warnings.unshift(
		'The embedded database is replaced file by file. Stop the application first, or the restored copy can be reopened in a torn state.',
	);
	if (!apply) return success(plan, { warnings });
	try {
		await replaceDirectory(payload, target);
	} catch (error) {
		return failure('RESTORE_FAILED', reason(error));
	}
	return success(plan, { evidence: [manifestPath, target], warnings });
}
