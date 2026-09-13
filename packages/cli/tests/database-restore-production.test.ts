import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
	databaseProviderConfigFromEnvironment,
	type DatabaseHandle,
} from '@flowdular/database';
import {
	createApprovalGrantKeyring,
	issueApprovalGrant,
} from '@flowdular/kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArguments } from '../src/arguments.ts';
import { createCliDatabaseProvider } from '../src/database.ts';
import { invocationDigest, runCommand } from '../src/runner.ts';

const AGENT_KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_AGENT_KEY = Buffer.alloc(32, 9).toString('base64');
const GRANT_KEY = Buffer.alloc(32, 0x51);
const TENANT = 'tenant-a';

let workspace: string;
let dataDirectory: string;
const environment = { ...process.env };
const servers: Server[] = [];

beforeEach(async () => {
	workspace = await mkdtemp(join(tmpdir(), 'flowdular-restore-production-'));
	dataDirectory = join(workspace, 'pglite');
	await writeFile(
		join(workspace, 'flowdular.json'),
		'{"architectureVersion":"0.2.0","modules":{"enabled":["profile.core"]}}\n',
	);
	delete process.env.FD_DATABASE_URL;
	delete process.env.FD_DATABASE_MIGRATOR_URL;
	delete process.env.FD_ENV;
	delete process.env.FD_PORT;
	process.env.NODE_ENV = 'development';
	process.env.FD_DATABASE_ADAPTER = 'pglite';
	process.env.FD_DATABASE_PGLITE_DIRECTORY = dataDirectory;
	process.env.FD_AGENT_CREDENTIAL_KEY = AGENT_KEY;
	process.env.FD_APPROVAL_GRANT_KEY = GRANT_KEY.toString('base64');
	delete process.env.FD_APPROVAL_GRANT_KEY_PREVIOUS;
});

afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve) => server.close(() => resolve())),
			),
	);
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

async function backup(directory: string): Promise<void> {
	const result = await runCommand(
		parseArguments([
			'--root',
			workspace,
			'database',
			'backup',
			'--output',
			directory,
			'--apply',
		]),
	);
	expect(result.ok).toBe(true);
}

/* The grant binds the exact invocation, so it is issued for the parsed flags
   of the command it is then passed to. */
function grant(
	flags: readonly string[],
	overrides: { readonly capabilityId?: string } = {},
): string {
	const parsed = parseArguments([
		'--root',
		workspace,
		'database',
		'restore-production',
		...flags,
	]);
	const now = Date.now();
	return issueApprovalGrant(
		createApprovalGrantKeyring({ current: GRANT_KEY }),
		{
			tenantId: TENANT,
			capabilityId: overrides.capabilityId ?? 'database.restore.production',
			inputDigest: invocationDigest(parsed, []),
			requestId: 'request-1',
			issuedAt: now - 1_000,
			expiresAt: now + 60_000,
			nonce: 'request-1',
		},
	).token;
}

async function restore(flags: readonly string[], token?: string) {
	return runCommand(
		parseArguments([
			'--root',
			workspace,
			'database',
			'restore-production',
			...flags,
			...(token === undefined ? [] : ['--grant', token, '--tenant', TENANT]),
		]),
	);
}

function applyFlags(
	directory: string,
	target: string,
	...extra: string[]
): readonly string[] {
	return [
		'--input',
		directory,
		'--target',
		target,
		'--apply',
		'--confirm',
		'restore-database',
		...extra,
	];
}

async function listen(): Promise<string> {
	const server = createServer((_request, response) => {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end('{"status":"ok"}');
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address() as { port: number };
	return `http://127.0.0.1:${address.port}`;
}

async function stubClientTools(): Promise<string> {
	const directory = join(workspace, 'bin');
	const log = join(workspace, 'tool.log');
	await mkdir(directory, { recursive: true });
	for (const tool of ['pg_dump', 'pg_restore']) {
		const path = join(directory, tool);
		await writeFile(
			path,
			[
				'#!/bin/sh',
				`printf '%s %s\\n' "${tool}" "$*" >> "${log}"`,
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
	return log;
}

function configurePostgres(): void {
	process.env.FD_DATABASE_ADAPTER = 'postgresql';
	process.env.FD_DATABASE_URL =
		'postgres://runtime:runtime-pw@db.local:6543/app';
	process.env.FD_DATABASE_MIGRATOR_URL =
		'postgres://migrator:migrator-pw@db.local:6543/app';
	process.env.FD_DATABASE_TLS = 'require';
}

describe('database restore-production', () => {
	it('refuses without a grant, even where the local restore would run', async () => {
		const directory = join(workspace, 'backups', 'ungranted');
		const result = await restore(applyFlags(directory, dataDirectory));

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'APPROVAL_VERIFIER_REQUIRED' },
		});
	});

	it('refuses a grant issued for the local restore capability', async () => {
		const directory = join(workspace, 'backups', 'foreign-grant');
		const flags = applyFlags(directory, dataDirectory);
		const result = await restore(
			flags,
			grant(flags, { capabilityId: 'database.restore' }),
		);

		expect(result.error?.code).toBe('APPROVAL_GRANT_MISMATCH');
	});

	it('is not gated to local environments', async () => {
		await seedProfile('one');
		const directory = join(workspace, 'backups', 'production-env');
		await backup(directory);
		process.env.FD_ENV = 'production';
		const flags = ['--input', directory, '--target', dataDirectory];

		const result = await restore(flags, grant(flags));

		expect(result.ok).toBe(true);
		expect(result.warnings).toContain(
			'Dry run only. Pass --apply to restore the database.',
		);
	}, 30_000);

	it('requires the target and refuses one the migrator connection does not name', async () => {
		await seedProfile('one');
		const directory = join(workspace, 'backups', 'target');
		await backup(directory);

		const missing = ['--input', directory];
		await expect(restore(missing, grant(missing))).resolves.toMatchObject({
			ok: false,
			error: { code: 'INPUT_REQUIRED' },
		});
		const wrong = ['--input', directory, '--target', join(workspace, 'other')];
		await expect(restore(wrong, grant(wrong))).resolves.toMatchObject({
			ok: false,
			error: { code: 'RESTORE_TARGET_MISMATCH' },
		});
		await expect(profileRows()).resolves.toEqual(['one']);
	}, 30_000);

	it('refuses a key mismatch unless the override is part of the approved invocation', async () => {
		await seedProfile('one');
		const directory = join(workspace, 'backups', 'keys');
		await backup(directory);
		await seedProfile('two');
		process.env.FD_AGENT_CREDENTIAL_KEY = OTHER_AGENT_KEY;

		const refused = applyFlags(directory, dataDirectory, '--platform-stopped');
		const result = await restore(refused, grant(refused));
		expect(result).toMatchObject({
			ok: false,
			error: { code: 'BACKUP_KEY_MISMATCH' },
		});
		expect(result.error?.message).toContain(
			'FD_AGENT_CREDENTIAL_KEY (different)',
		);
		await expect(profileRows()).resolves.toEqual(['one', 'two']);

		const overridden = [...refused, '--allow-key-mismatch'];
		const allowed = await restore(overridden, grant(overridden));
		expect(allowed.ok).toBe(true);
		expect(
			allowed.warnings.some((entry) => entry.startsWith('BACKUP_KEY_MISMATCH')),
		).toBe(true);
		await expect(profileRows()).resolves.toEqual(['one']);
	}, 60_000);

	it('restores under a valid grant with a matching target and matching keys', async () => {
		await seedProfile('one');
		const directory = join(workspace, 'backups', 'granted');
		await backup(directory);
		await seedProfile('two');
		await expect(profileRows()).resolves.toEqual(['one', 'two']);

		/* The target resolves from the workspace root, so its relative form names
		   the same directory. */
		const flags = applyFlags(directory, 'pglite', '--platform-stopped');
		const result = await restore(flags, grant(flags));

		expect(result.ok).toBe(true);
		expect(result.data).toMatchObject({ applied: true, target: dataDirectory });
		expect(
			result.warnings.some((entry) => entry.startsWith('BACKUP_KEY_MISMATCH')),
		).toBe(false);
		await expect(profileRows()).resolves.toEqual(['one']);
	}, 60_000);

	it('refuses a flag the approval did not name', async () => {
		await seedProfile('one');
		const directory = join(workspace, 'backups', 'unapproved-flag');
		await backup(directory);
		process.env.FD_AGENT_CREDENTIAL_KEY = OTHER_AGENT_KEY;
		const approved = applyFlags(directory, dataDirectory);
		const token = grant(approved);

		for (const added of [
			['--allow-key-mismatch'],
			['--platform-stopped'],
			['--platform-url', 'http://127.0.0.1:1'],
		]) {
			await expect(
				restore([...approved, ...added], token),
			).resolves.toMatchObject({
				ok: false,
				error: { code: 'APPROVAL_GRANT_MISMATCH' },
			});
		}
		/* A dry run and the applied run are different invocations. */
		const planned = ['--input', directory, '--target', dataDirectory];
		await expect(
			restore(
				applyFlags(directory, dataDirectory, '--platform-stopped'),
				grant(planned),
			),
		).resolves.toMatchObject({
			ok: false,
			error: { code: 'APPROVAL_GRANT_MISMATCH' },
		});
		await expect(profileRows()).resolves.toEqual(['one']);
	}, 30_000);

	it('refuses while the platform answers on its health endpoint', async () => {
		await seedProfile('one');
		const directory = join(workspace, 'backups', 'running');
		await backup(directory);
		await seedProfile('two');
		const origin = await listen();

		const byUrl = applyFlags(
			directory,
			dataDirectory,
			'--platform-url',
			origin,
		);
		await expect(restore(byUrl, grant(byUrl))).resolves.toMatchObject({
			ok: false,
			error: { code: 'PLATFORM_RUNNING' },
		});

		/* The attestation does not override a probe that finds the platform up. */
		process.env.FD_PORT = new URL(origin).port;
		const byPort = applyFlags(directory, dataDirectory, '--platform-stopped');
		await expect(restore(byPort, grant(byPort))).resolves.toMatchObject({
			ok: false,
			error: { code: 'PLATFORM_RUNNING' },
		});
		await expect(profileRows()).resolves.toEqual(['one', 'two']);
	}, 60_000);

	it('proceeds once the named endpoint stops answering', async () => {
		await seedProfile('one');
		const directory = join(workspace, 'backups', 'stopped');
		await backup(directory);
		await seedProfile('two');
		const origin = await listen();
		await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));

		const flags = applyFlags(
			directory,
			dataDirectory,
			'--platform-url',
			origin,
		);
		const result = await restore(flags, grant(flags));

		expect(result.ok).toBe(true);
		await expect(profileRows()).resolves.toEqual(['one']);
	}, 60_000);

	it('treats an unreachable host as unknown, not as stopped', async () => {
		await seedProfile('one');
		const directory = join(workspace, 'backups', 'unresolvable');
		await backup(directory);
		await seedProfile('two');
		const origin = 'http://flowdular-restore-probe.invalid';

		const unattested = applyFlags(
			directory,
			dataDirectory,
			'--platform-url',
			origin,
		);
		await expect(restore(unattested, grant(unattested))).resolves.toMatchObject(
			{
				ok: false,
				error: { code: 'PLATFORM_STATE_UNKNOWN' },
			},
		);
		await expect(profileRows()).resolves.toEqual(['one', 'two']);

		const attested = [...unattested, '--platform-stopped'];
		const result = await restore(attested, grant(attested));
		expect(result.ok).toBe(true);
		await expect(profileRows()).resolves.toEqual(['one']);
	}, 60_000);

	it('requires the attestation when nothing names the platform', async () => {
		await seedProfile('one');
		const directory = join(workspace, 'backups', 'unnamed');
		await backup(directory);

		const flags = applyFlags(directory, dataDirectory);
		const result = await restore(flags, grant(flags));

		expect(result).toMatchObject({
			ok: false,
			error: { code: 'PLATFORM_STATE_UNKNOWN' },
		});
	}, 30_000);

	it('runs pg_restore against the migrator database and refuses a shared role', async () => {
		const log = await stubClientTools();
		configurePostgres();
		const directory = join(workspace, 'backups', 'postgres');
		await backup(directory);

		const flags = applyFlags(directory, 'app', '--platform-stopped');
		const result = await restore(flags, grant(flags));
		expect(result.ok).toBe(true);
		const invocations = await readFile(log, 'utf8');
		expect(invocations).toContain(
			'pg_restore --clean --if-exists --no-password --dbname app',
		);
		expect(invocations).not.toContain('migrator-pw');

		const wrong = applyFlags(directory, 'flowdular', '--platform-stopped');
		await expect(restore(wrong, grant(wrong))).resolves.toMatchObject({
			ok: false,
			error: { code: 'RESTORE_TARGET_MISMATCH' },
		});

		/* The same runtime user behind a different spelling of the DSN is still
		   the runtime role. */
		for (const migrator of [
			undefined,
			'postgres://runtime:runtime-pw@db.local:6543/app?application_name=restore',
		]) {
			if (migrator === undefined) delete process.env.FD_DATABASE_MIGRATOR_URL;
			else process.env.FD_DATABASE_MIGRATOR_URL = migrator;
			await expect(restore(flags, grant(flags))).resolves.toMatchObject({
				ok: false,
				error: { code: 'MIGRATOR_ROLE_REQUIRED' },
			});
		}
	});
});
