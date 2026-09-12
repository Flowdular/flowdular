import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArguments } from '../src/arguments.ts';
import { runCommand } from '../src/runner.ts';

/* Writing the certificate is the only step between creating the temporary
   directory and the block that removes it, so refusing that write is what
   proves the directory is never orphaned. */
vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		writeFile: (path: unknown, ...rest: unknown[]) => {
			if (typeof path === 'string' && path.endsWith('ca.pem')) {
				throw new Error('CERTIFICATE_WRITE_REFUSED');
			}
			return (actual.writeFile as (...values: unknown[]) => Promise<void>)(
				path,
				...rest,
			);
		},
	};
});

let workspace: string;
let temporaryRoot: string;
const environment = { ...process.env };

beforeEach(async () => {
	workspace = await mkdtemp(join(tmpdir(), 'flowdular-backup-authority-'));
	temporaryRoot = join(workspace, 'tmp');
	await mkdir(temporaryRoot, { recursive: true });
	await writeFile(
		join(workspace, 'flowdular.json'),
		'{"architectureVersion":"0.2.0","modules":{"enabled":["profile.core"]}}\n',
	);
	const binaries = join(workspace, 'bin');
	await mkdir(binaries, { recursive: true });
	const stub = join(binaries, 'pg_dump');
	await writeFile(stub, '#!/bin/sh\nexit 0\n', 'utf8');
	await chmod(stub, 0o755);

	process.env.TMPDIR = temporaryRoot;
	process.env.PATH = `${binaries}${delimiter}${process.env.PATH ?? ''}`;
	process.env.NODE_ENV = 'development';
	process.env.FD_DATABASE_ADAPTER = 'postgresql';
	process.env.FD_DATABASE_URL =
		'postgres://runtime:runtime-pw@db.local:6543/app';
	process.env.FD_DATABASE_MIGRATOR_URL =
		'postgres://migrator:migrator-pw@db.local:6543/app';
	process.env.FD_DATABASE_TLS = 'require';
	process.env.FD_DATABASE_TLS_CA =
		'-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----';
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
	for (const key of Object.keys(process.env)) {
		if (!(key in environment)) delete process.env[key];
	}
	Object.assign(process.env, environment);
});

describe('the temporary certificate of a PostgreSQL backup', () => {
	it('leaves no directory behind when the certificate cannot be written', async () => {
		const backup = runCommand(
			parseArguments([
				'--root',
				workspace,
				'database',
				'backup',
				'--output',
				join(workspace, 'backups', 'refused'),
				'--apply',
			]),
		);

		await expect(backup).resolves.toMatchObject({
			ok: false,
			error: {
				code: 'COMMAND_FAILED',
				message: expect.stringContaining('CERTIFICATE_WRITE_REFUSED'),
			},
		});
		await expect(readdir(temporaryRoot)).resolves.toEqual([]);
	});
});
