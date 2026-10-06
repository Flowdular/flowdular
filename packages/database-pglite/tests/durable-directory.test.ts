import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteCluster } from '../src/driver.ts';

it('creates a fresh nested data directory and retains data after reopening', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-pglite-directory-'));
	const dataDirectory = join(root, 'missing', 'data', 'pglite');
	try {
		const first = createPgliteCluster({ dataDirectory });
		try {
			const client = await first.pool().connect();
			try {
				await client.query({
					text: 'CREATE TABLE setup_probe (value INTEGER); INSERT INTO setup_probe VALUES (42)',
				});
			} finally {
				client.release();
			}
		} finally {
			await first.close();
		}
		const second = createPgliteCluster({ dataDirectory });
		try {
			const client = await second.pool().connect();
			try {
				expect(
					(await client.query({ text: 'SELECT value FROM setup_probe' })).rows,
				).toEqual([{ value: 42 }]);
			} finally {
				client.release();
			}
		} finally {
			await second.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

async function rowsOf(
	cluster: ReturnType<typeof createPgliteCluster>,
	text: string,
): Promise<readonly Record<string, unknown>[]> {
	const client = await cluster.pool().connect();
	try {
		return (await client.query({ text })).rows ?? [];
	} finally {
		client.release();
	}
}

/* A development server composes its runtime more than once per process, so
   two clusters open the same directory at once. */
it('keeps every write when two clusters in one process hold the same directory', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-pglite-shared-'));
	const dataDirectory = join(root, 'pglite');
	const lock = join(dataDirectory, 'flowdular.lock');
	try {
		const first = createPgliteCluster({ dataDirectory });
		await rowsOf(
			first,
			'CREATE TABLE shared (value INTEGER); INSERT INTO shared VALUES (1)',
		);
		const second = createPgliteCluster({ dataDirectory });
		await rowsOf(second, 'SELECT count(*) FROM shared');
		await rowsOf(first, 'INSERT INTO shared VALUES (2)');
		expect(
			await rowsOf(second, 'SELECT value FROM shared ORDER BY value'),
		).toEqual([{ value: 1 }, { value: 2 }]);
		await rowsOf(second, 'INSERT INTO shared VALUES (3)');
		await second.close();
		expect(await readFile(lock, 'utf8')).toMatch(
			new RegExp(`^${process.pid}\\n`),
		);
		await first.close();
		await expect(readFile(lock, 'utf8')).rejects.toMatchObject({
			code: 'ENOENT',
		});

		const reopened = createPgliteCluster({ dataDirectory });
		try {
			expect(
				await rowsOf(reopened, 'SELECT value FROM shared ORDER BY value'),
			).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
		} finally {
			await reopened.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('keeps a transaction on a shared directory whole while another cluster waits', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-pglite-session-'));
	const dataDirectory = join(root, 'pglite');
	const first = createPgliteCluster({ dataDirectory });
	const second = createPgliteCluster({ dataDirectory });
	try {
		await rowsOf(first, 'CREATE TABLE ledger (value INTEGER)');
		const writer = await first.pool().connect();
		await writer.query({ text: 'BEGIN; INSERT INTO ledger VALUES (1)' });
		const reader = second.pool().connect();
		expect(
			await Promise.race([
				reader.then(() => 'connected'),
				new Promise((resolve) => setTimeout(() => resolve('waiting'), 100)),
			]),
		).toBe('waiting');
		await writer.query({ text: 'ROLLBACK' });
		writer.release();
		const client = await reader;
		try {
			expect(
				(
					await client.query({
						text: 'SELECT count(*)::int AS rows FROM ledger',
					})
				).rows,
			).toEqual([{ rows: 0 }]);
		} finally {
			client.release();
		}
	} finally {
		await second.close();
		await first.close();
		await rm(root, { recursive: true, force: true });
	}
});

it('preserves an initialization failure without failing disposal a second time', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-pglite-invalid-'));
	try {
		const blocker = join(root, 'file');
		await writeFile(blocker, 'occupied');
		const cluster = createPgliteCluster({
			dataDirectory: join(blocker, 'pglite'),
		});
		await expect(cluster.pool().connect()).rejects.toThrow();
		await expect(cluster.close()).resolves.toBeUndefined();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('closes the created database when bootstrap fails', async () => {
	const instance = await PGlite.create();
	const create = vi.spyOn(PGlite, 'create').mockResolvedValue(instance);
	const cluster = createPgliteCluster({ bootstrap: 'INVALID BOOTSTRAP SQL' });
	try {
		await expect(cluster.pool().connect()).rejects.toThrow();
		expect(instance.closed).toBe(true);
		await expect(cluster.close()).resolves.toBeUndefined();
	} finally {
		create.mockRestore();
		if (!instance.closed) await instance.close();
	}
});
