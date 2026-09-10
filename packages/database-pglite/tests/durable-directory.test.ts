import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
