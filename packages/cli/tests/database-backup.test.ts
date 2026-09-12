import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import {
	databaseProviderConfigFromEnvironment,
	type BackupManifest,
	type DatabaseHandle,
} from '@flowdular/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArguments } from '../src/arguments.ts';
import { createCliDatabaseProvider } from '../src/database.ts';
import { runCommand } from '../src/runner.ts';

const AGENT_KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_AGENT_KEY = Buffer.alloc(32, 9).toString('base64');

let workspace: string;
const environment = { ...process.env };

beforeEach(async () => {
	workspace = await mkdtemp(join(tmpdir(), 'flowdular-database-backup-'));
	await writeFile(
		join(workspace, 'flowdular.json'),
		'{"architectureVersion":"0.2.0","modules":{"enabled":["profile.core","system.core"]}}\n',
	);
	delete process.env.FD_DATABASE_URL;
	delete process.env.FD_DATABASE_MIGRATOR_URL;
	process.env.NODE_ENV = 'development';
	process.env.FD_DATABASE_ADAPTER = 'pglite';
	process.env.FD_DATABASE_PGLITE_DIRECTORY = join(workspace, 'pglite');
	process.env.FD_AGENT_CREDENTIAL_KEY = AGENT_KEY;
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
	for (const key of Object.keys(process.env)) {
		if (!(key in environment)) delete process.env[key];
	}
	Object.assign(process.env, environment);
});

async function withDatabase<T>(
	run: (database: DatabaseHandle) => Promise<T>,
): Promise<T> {
	const databases = createCliDatabaseProvider(
		databaseProviderConfigFromEnvironment(process.env, workspace),
	);
	const lease = await databases.acquire({
		namespace: 'profile.core',
		purpose: 'migration',
	});
	try {
		return await run(lease.database);
	} finally {
		await lease.release();
		await databases.dispose();
	}
}

async function seedProfile(value: string): Promise<void> {
	await withDatabase(async (database) => {
		await database.executeScript(
			'CREATE TABLE IF NOT EXISTS profile_records (id TEXT PRIMARY KEY);',
		);
		await database.execute({
			text: 'INSERT INTO profile_records (id) VALUES ($1)',
			parameters: [value],
		});
	});
}

async function profileRows(): Promise<readonly string[]> {
	return withDatabase(async (database) => {
		const result = await database.query<{ id: string }>({
			text: 'SELECT id FROM profile_records ORDER BY id',
		});
		return result.rows.map((row) => row.id);
	});
}

async function run(...arguments_: string[]) {
	return runCommand(
		parseArguments(['--root', workspace, 'database', ...arguments_]),
	);
}

function data(
	result: Awaited<ReturnType<typeof run>>,
): Record<string, unknown> {
	expect(result.ok).toBe(true);
	return (result as { data: Record<string, unknown> }).data;
}

async function readManifest(directory: string): Promise<BackupManifest> {
	return JSON.parse(
		await readFile(join(directory, 'backup.json'), 'utf8'),
	) as BackupManifest;
}

/* A pg_dump or pg_restore on PATH that records how it was called, so the
   PostgreSQL path is exercised without a server. The certificate copy keeps
   its mode (`cp -p`), which is the only way to observe a file the command
   removes before it returns. */
async function stubClientTools(): Promise<{
	readonly log: string;
	readonly environmentDump: string;
	readonly authorityCopy: string;
}> {
	const directory = join(workspace, 'bin');
	const log = join(workspace, 'tool.log');
	const environmentDump = join(workspace, 'tool.env');
	const authorityCopy = join(workspace, 'tool.ca');
	await mkdir(directory, { recursive: true });
	for (const tool of ['pg_dump', 'pg_restore']) {
		const path = join(directory, tool);
		await writeFile(
			path,
			[
				'#!/bin/sh',
				`printf '%s %s\\n' "${tool}" "$*" >> "${log}"`,
				`env | sort > "${environmentDump}"`,
				'if [ -n "$PGSSLROOTCERT" ]; then',
				`  cp -p "$PGSSLROOTCERT" "${authorityCopy}"`,
				'fi',
				'while [ $# -gt 0 ]; do',
				'  if [ "$1" = "--file" ]; then printf "dump" > "$2"; fi',
				'  shift',
				'done',
				'exit 0',
				'',
			].join('\n'),
			'utf8',
		);
		await chmod(path, 0o755);
	}
	process.env.PATH = `${directory}${delimiter}${process.env.PATH ?? ''}`;
	return { log, environmentDump, authorityCopy };
}

function configurePostgres(): void {
	process.env.FD_DATABASE_ADAPTER = 'postgresql';
	process.env.FD_DATABASE_URL =
		'postgres://runtime:runtime-pw@db.local:6543/app';
	process.env.FD_DATABASE_MIGRATOR_URL =
		'postgres://migrator:migrator-pw@db.local:6543/app';
	process.env.FD_DATABASE_TLS = 'require';
}

describe('database backup', () => {
	it('copies the embedded database and restores it', async () => {
		await seedProfile('one');
		const directory = join(workspace, 'backups', 'first');

		const backup = data(await run('backup', '--output', directory, '--apply'));
		expect(backup.adapter).toBe('pglite');
		expect(backup.applied).toBe(true);

		await seedProfile('two');
		await expect(profileRows()).resolves.toEqual(['one', 'two']);

		const restored = await run(
			'restore',
			'--input',
			directory,
			'--apply',
			'--confirm',
			'restore-database',
		);

		expect(restored.ok).toBe(true);
		await expect(profileRows()).resolves.toEqual(['one']);
	}, 60_000);

	it('records the backup context and key fingerprints without the key material', async () => {
		await seedProfile('one');
		const directory = join(workspace, 'backups', 'manifest');

		await run('backup', '--output', directory, '--apply');
		const manifest = await readManifest(directory);

		expect(manifest).toMatchObject({
			schemaVersion: 1,
			adapter: 'pglite',
			platformVersion: '0.2.0',
			modules: ['profile.core', 'system.core'],
		});
		expect(Date.parse(manifest.createdAt)).not.toBeNaN();
		expect(
			manifest.keys.find((key) => key.variable === 'FD_AGENT_CREDENTIAL_KEY'),
		).toEqual({
			variable: 'FD_AGENT_CREDENTIAL_KEY',
			fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
		});
		expect(
			manifest.keys.find((key) => key.variable === 'FD_AUTH_MFA_KEY'),
		).toEqual({ variable: 'FD_AUTH_MFA_KEY', fingerprint: null });
		expect(JSON.stringify(manifest)).not.toContain(AGENT_KEY);
	}, 30_000);

	it('plans without writing anything', async () => {
		await seedProfile('one');
		const directory = join(workspace, 'backups', 'planned');

		const result = await run('backup', '--output', directory);

		const planned = data(result);
		expect(planned.applied).toBe(false);
		expect(planned.payload).toBe(join(directory, 'pglite'));
		expect(result.warnings).toContain(
			'Dry run only. Pass --apply to write the backup.',
		);
		expect(existsSync(directory)).toBe(false);
	}, 30_000);

	it('refuses to overwrite an existing backup', async () => {
		await seedProfile('one');
		const directory = join(workspace, 'backups', 'twice');

		await run('backup', '--output', directory, '--apply');
		const second = await run('backup', '--output', directory, '--apply');

		expect(second).toMatchObject({
			ok: false,
			error: { code: 'BACKUP_TARGET_EXISTS' },
		});
	}, 30_000);

	it('reports a plan through pg_dump without putting the password in the arguments', async () => {
		const tools = await stubClientTools();
		configurePostgres();
		const directory = join(workspace, 'backups', 'postgres');

		const result = await run('backup', '--output', directory, '--apply');

		expect(result.ok).toBe(true);
		expect(data(result).adapter).toBe('postgresql');
		const invocation = await readFile(tools.log, 'utf8');
		expect(invocation).toContain(
			'pg_dump --format=custom --no-password --file',
		);
		expect(invocation).not.toContain('migrator-pw');
		const childEnvironment = await readFile(tools.environmentDump, 'utf8');
		expect(childEnvironment).toContain('PGUSER=migrator');
		expect(childEnvironment).toContain('PGDATABASE=app');
		expect(childEnvironment).toContain('PGHOST=db.local');
		expect(childEnvironment).toContain('PGPORT=6543');
		expect(childEnvironment).toContain('PGSSLMODE=require');
		/* Without the password on the connection the dump would prompt, and
		   --no-password turns that prompt into a failure. */
		expect(childEnvironment).toContain('PGPASSWORD=migrator-pw');
		/* The child runs a dump, so it has no business holding the platform's
		   encryption keys. */
		expect(childEnvironment).not.toContain('FD_AGENT_CREDENTIAL_KEY');
		expect(await readFile(join(directory, 'database.dump'), 'utf8')).toBe(
			'dump',
		);
		expect((await stat(join(directory, 'database.dump'))).mode & 0o777).toBe(
			0o600,
		);
		expect((await readManifest(directory)).adapter).toBe('postgresql');
	});

	it('hands pg_dump a certificate only it can read and removes it afterwards', async () => {
		const tools = await stubClientTools();
		configurePostgres();
		process.env.FD_DATABASE_TLS_CA =
			'-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----';
		const directory = join(workspace, 'backups', 'authority');

		const result = await run('backup', '--output', directory, '--apply');

		expect(result.ok).toBe(true);
		const childEnvironment = await readFile(tools.environmentDump, 'utf8');
		const authority = /^PGSSLROOTCERT=(.+)$/m.exec(childEnvironment)?.[1];
		expect(authority).toBeDefined();
		expect(await readFile(tools.authorityCopy, 'utf8')).toContain(
			'BEGIN CERTIFICATE',
		);
		expect((await stat(tools.authorityCopy)).mode & 0o777).toBe(0o600);
		expect(existsSync(authority!)).toBe(false);
		expect(existsSync(dirname(authority!))).toBe(false);
	});

	it('keeps the backup directory and the manifest readable by the operator alone', async () => {
		await seedProfile('one');
		const directory = join(workspace, 'backups', 'modes');

		await run('backup', '--output', directory, '--apply');

		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		expect((await stat(join(directory, 'backup.json'))).mode & 0o777).toBe(
			0o600,
		);
		const payload = join(directory, 'pglite');
		expect((await stat(payload)).mode & 0o777).toBe(0o700);
		const [file] = (await readdir(payload, { withFileTypes: true })).filter(
			(entry) => entry.isFile(),
		);
		expect(file).toBeDefined();
		expect((await stat(join(payload, file!.name))).mode & 0o777).toBe(0o600);
	}, 30_000);

	it('runs through the capability catalog as well as the command path', async () => {
		await seedProfile('one');
		const directory = join(workspace, 'backups', 'capability');

		const result = await runCommand(
			parseArguments([
				'--root',
				workspace,
				'capability',
				'run',
				'database.backup',
				'--output',
				directory,
			]),
		);

		expect(data(result).payload).toBe(join(directory, 'pglite'));
	}, 30_000);

	it('reports a missing client tool', async () => {
		configurePostgres();
		process.env.PATH = join(workspace, 'empty-bin');

		const result = await run(
			'backup',
			'--output',
			join(workspace, 'backups', 'missing'),
			'--apply',
		);

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'BACKUP_TOOL_MISSING' },
		});
	});

	it('reports the usage of the database group for an unknown action', async () => {
		const result = await run('archive');

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'USAGE_ERROR' },
		});
		expect((result as { error: { message: string } }).error.message).toContain(
			'database backup --output <dir>',
		);
	});
});

describe('database restore', () => {
	it('asks for the backup directory', async () => {
		await expect(run('restore')).resolves.toMatchObject({
			ok: false,
			error: { code: 'INPUT_REQUIRED' },
		});
	});

	/* Destructive and local only, exactly like database reset. */
	it('refuses to run outside a development or test environment', async () => {
		process.env.FD_ENV = 'production';

		const result = await run('restore', '--input', join(workspace, 'any'));

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'LOCAL_ONLY_CAPABILITY' },
		});
	});

	it('refuses to apply without the confirmation token', async () => {
		await seedProfile('one');
		const directory = join(workspace, 'backups', 'unconfirmed');
		await run('backup', '--output', directory, '--apply');

		const result = await run('restore', '--input', directory, '--apply');

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'CONFIRMATION_REQUIRED' },
		});
	}, 30_000);

	it('warns when the running environment holds different keys', async () => {
		await seedProfile('one');
		const directory = join(workspace, 'backups', 'keys');
		await run('backup', '--output', directory, '--apply');

		process.env.FD_AGENT_CREDENTIAL_KEY = OTHER_AGENT_KEY;
		process.env.FD_AUTH_MFA_KEY = Buffer.alloc(32, 3).toString('base64url');
		const result = await run('restore', '--input', directory);

		expect(result.ok).toBe(true);
		const warning = result.warnings.find((entry) =>
			entry.startsWith('BACKUP_KEY_MISMATCH'),
		);
		expect(warning).toContain('FD_AGENT_CREDENTIAL_KEY (different)');
		expect(warning).toContain('FD_AUTH_MFA_KEY (missing-in-backup)');
		expect(warning).not.toContain('FD_WORKFLOWS_PAYLOAD_KEY');
	}, 30_000);

	it('accepts a backup taken with the same keys without a mismatch warning', async () => {
		await seedProfile('one');
		const directory = join(workspace, 'backups', 'same-keys');
		await run('backup', '--output', directory, '--apply');

		const result = await run('restore', '--input', directory);

		expect(result.ok).toBe(true);
		expect(
			result.warnings.some((entry) => entry.startsWith('BACKUP_KEY_MISMATCH')),
		).toBe(false);
	}, 30_000);

	it('rejects a directory that holds no backup', async () => {
		const result = await run('restore', '--input', join(workspace, 'nothing'));

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'BACKUP_MANIFEST_MISSING' },
		});
	});

	it('rejects a manifest it cannot trust', async () => {
		await seedProfile('one');
		const directory = join(workspace, 'backups', 'corrupt');
		await run('backup', '--output', directory, '--apply');
		await writeFile(
			join(directory, 'backup.json'),
			'{"schemaVersion":1,"adapter":"pglite","createdAt":"now"}',
		);

		const result = await run('restore', '--input', directory);

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'BACKUP_MANIFEST_INVALID' },
		});
	}, 30_000);

	it('rejects a backup taken from another adapter', async () => {
		await seedProfile('one');
		const directory = join(workspace, 'backups', 'foreign');
		await run('backup', '--output', directory, '--apply');
		await stubClientTools();
		configurePostgres();

		const result = await run('restore', '--input', directory);

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'BACKUP_ADAPTER_MISMATCH' },
		});
	}, 30_000);
});
