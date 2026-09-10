import {
	appendRecordHistory,
	queryRecordHistory,
	type DatabaseHandle,
} from '@flowdular/database';
import { describe, expect, it } from 'vitest';
import { createPostgresTestProvider } from '../src/postgres.ts';

const migratorUrl = process.env.FD_TEST_POSTGRES_URL?.trim();

const DDL = `CREATE TABLE IF NOT EXISTS demo_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  action TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  run_id TEXT,
  changes_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  configured_by_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS demo_history_tenant_record_version_idx
  ON demo_history (tenant_id, record_id, version DESC);
`;

const user = { kind: 'user', id: 'account-a', label: 'Ada' } as const;

describe.skipIf(!migratorUrl)('record history on PostgreSQL', () => {
	/* PostgreSQL hands BIGINT back as a string. A version or timestamp that
	   skipped normalization would concatenate instead of increment. */
	it('numbers versions and reads BIGINT columns back as integers', async () => {
		const provider = await createPostgresTestProvider({
			migratorUrl: migratorUrl!,
		});
		try {
			const lease = await provider.acquire({
				namespace: 'history.core',
				purpose: 'migration',
			});
			const database: DatabaseHandle = lease.database;
			await database.executeScript(DDL);

			for (const action of ['created', 'updated', 'approved']) {
				await appendRecordHistory(database, 'demo_history', {
					tenantId: 'tenant-a',
					recordId: 'claim-1',
					action,
					actor: user,
					changes: { status: { from: null, to: action } },
					occurredAt: 1_700_000_000_000,
				});
			}

			const page = await queryRecordHistory(database, 'demo_history', {
				tenantId: 'tenant-a',
				recordId: 'claim-1',
				limit: 2,
			});
			expect(page.entries.map((entry) => entry.version)).toEqual([3, 2]);
			expect(page.entries[0]!.occurredAt).toBe(1_700_000_000_000);
			expect(page.nextCursor).toBe('2');

			const rest = await queryRecordHistory(database, 'demo_history', {
				tenantId: 'tenant-a',
				recordId: 'claim-1',
				limit: 2,
				cursor: page.nextCursor,
			});
			expect(rest.entries.map((entry) => entry.version)).toEqual([1]);
			await lease.release();
		} finally {
			await provider.dispose();
		}
	});
});
