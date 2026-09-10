import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPreviewDatabaseProvider } from '../src/server/preview-database.ts';

let dataPath: string;

beforeEach(async () => {
	dataPath = await mkdtemp(join(tmpdir(), 'flowdular-preview-'));
});

afterEach(async () => {
	await rm(dataPath, { recursive: true, force: true });
});

const TABLE = `CREATE TABLE IF NOT EXISTS draft_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL
);
ALTER TABLE draft_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_records FORCE ROW LEVEL SECURITY;
CREATE POLICY draft_records_tenant_policy ON draft_records
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

describe('preview database provider', () => {
	/* A draft previews against the isolation a deployment enforces, so a tenant
	   mistake surfaces in the sandbox instead of after the eject. */
	it('gives a draft a migration lease and a tenant-scoped runtime lease', async () => {
		const provider = createPreviewDatabaseProvider(dataPath);
		try {
			const migration = await provider.acquire({
				namespace: 'draft.core',
				purpose: 'migration',
			});
			await migration.database.executeScript(TABLE);
			await migration.release();

			const runtime = await provider.acquire({
				namespace: 'draft.core',
				purpose: 'preview',
			});
			await runtime.database.transaction(
				(transaction) =>
					transaction.execute({
						text: 'INSERT INTO draft_records (id, tenant_id) VALUES ($1, $2)',
						parameters: ['one', 'tenant-a'],
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			);

			const own = await runtime.database.transaction(
				(transaction) =>
					transaction.query<{ id: string }>({
						text: 'SELECT id FROM draft_records',
					}),
				{ access: 'read', tenantId: 'tenant-a' },
			);
			expect(own.rows).toEqual([{ id: 'one' }]);

			const other = await runtime.database.transaction(
				(transaction) =>
					transaction.query<{ id: string }>({
						text: 'SELECT id FROM draft_records',
					}),
				{ access: 'read', tenantId: 'tenant-b' },
			);
			expect(other.rows).toEqual([]);
			await runtime.release();
		} finally {
			await provider.dispose();
		}
	}, 30_000);

	it('refuses a new lease after disposal', async () => {
		const provider = createPreviewDatabaseProvider(dataPath);
		await provider.dispose();

		await expect(
			provider.acquire({ namespace: 'draft.core', purpose: 'preview' }),
		).rejects.toMatchObject({ code: 'ADAPTER_DISPOSED' });
	});

	it('rejects a namespace that is not a module namespace', async () => {
		const provider = createPreviewDatabaseProvider(dataPath);
		try {
			await expect(
				provider.acquire({ namespace: '../escape', purpose: 'preview' }),
			).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
		} finally {
			await provider.dispose();
		}
	}, 30_000);
});
