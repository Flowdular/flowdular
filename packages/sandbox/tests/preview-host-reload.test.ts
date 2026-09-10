import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { expect, it } from 'vitest';

it('opens a retained preview database after its Vite module runner closes', async () => {
	const root = await mkdtemp(join(tmpdir(), 'preview-host-reload-'));
	const vite = await createServer({
		configFile: false,
		server: { middlewareMode: true },
		appType: 'custom',
	});
	let provider;
	try {
		const loaded = await vite.ssrLoadModule(
			resolve('src/server/preview-database.ts'),
		);
		await vite.close();
		provider = loaded.createPreviewDatabaseProvider(root);
		const lease = await provider.acquire({
			namespace: 'test.core',
			purpose: 'migration',
		});
		try {
			const result = await lease.database.query({ text: 'SELECT 42 AS value' });
			expect(result.rows).toEqual([{ value: 42 }]);
		} finally {
			await lease.release();
		}
	} finally {
		await provider?.dispose();
		await vite.close();
		await rm(root, { recursive: true, force: true });
	}
});
