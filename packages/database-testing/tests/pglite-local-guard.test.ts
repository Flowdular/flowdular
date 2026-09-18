import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createPgliteCluster,
	LocalDatabaseLockedError,
	LocalDatabaseUnreadableError,
} from '@flowdular/database-pglite';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];

async function workspace(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'pglite-guard-'));
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe('local database directory', () => {
	it('refuses a directory a live process holds and replaces a stale lock', async () => {
		const directory = await workspace();
		const holder = spawn(process.execPath, [
			'-e',
			'setTimeout(() => {}, 60000)',
		]);
		await new Promise((resolve) => holder.once('spawn', resolve));
		await writeFile(join(directory, 'flowdular.lock'), `${holder.pid}\n`);

		const blocked = createPgliteCluster({ dataDirectory: directory });
		await expect(blocked.pool().connect()).rejects.toBeInstanceOf(
			LocalDatabaseLockedError,
		);
		await blocked.close();

		/* The holder is gone, so its lock is stale and the next boot takes over
		   instead of asking the reader to delete a file. */
		holder.kill('SIGKILL');
		await new Promise((resolve) => holder.once('exit', resolve));
		const cluster = createPgliteCluster({ dataDirectory: directory });
		const client = await cluster.pool().connect();
		expect(await readFile(join(directory, 'flowdular.lock'), 'utf8')).toContain(
			String(process.pid),
		);
		client.release();
		await cluster.close();
	}, 60_000);

	it('names the directory and the way out when it cannot be opened', async () => {
		const directory = await workspace();
		/* What a process killed mid write leaves behind: the marker file without
		   the cluster around it. */
		await mkdir(join(directory, 'global'), { recursive: true });
		await writeFile(join(directory, 'PG_VERSION'), '18\n');

		const cluster = createPgliteCluster({ dataDirectory: directory });
		const failure = await cluster
			.pool()
			.connect()
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(LocalDatabaseUnreadableError);
		expect((failure as Error).message).toContain(directory);
		expect((failure as Error).message).toContain('setup quick');
		expect((failure as Error).cause).toBeDefined();
		/* A failed open leaves no lock behind for the next attempt to trip on. */
		await expect(
			readFile(join(directory, 'flowdular.lock'), 'utf8'),
		).rejects.toMatchObject({ code: 'ENOENT' });
		await cluster.close();
	}, 60_000);
});
