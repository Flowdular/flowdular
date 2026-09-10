import { createPgliteCluster } from '@flowdular/database-pglite';
import { afterAll, describe, expect, it } from 'vitest';
import {
	appendRecordHistory,
	PostgresDatabaseAdapter,
	queryRecordHistory,
} from '../src/index.ts';

const HISTORY_DDL = `CREATE TABLE IF NOT EXISTS demo_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  action TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  run_id TEXT,
  changes_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS demo_history_tenant_record_version_idx
  ON demo_history (tenant_id, record_id, version DESC);
`;

const SERVICE_DDL = HISTORY_DDL.replace(
	'  occurred_at BIGINT NOT NULL\n);',
	'  occurred_at BIGINT NOT NULL,\n  configured_by_json TEXT\n);',
);

/* One embedded PostgreSQL for the file. Booting it costs a second or two, so
   each case drops and recreates the fixture table rather than paying again. */
const cluster = createPgliteCluster();
const adapter = new PostgresDatabaseAdapter({ pool: cluster.pool() });

afterAll(async () => {
	await adapter.dispose();
});

async function database(ddl = HISTORY_DDL) {
	await adapter.executeScript(`DROP TABLE IF EXISTS demo_history;\n${ddl}`);
	return adapter;
}

const user = { kind: 'user', id: 'account-a', label: 'Ada' } as const;

describe('record history', () => {
	it('numbers versions per record and pages newest first', async () => {
		await database();
		for (const action of ['created', 'updated', 'submitted']) {
			await appendRecordHistory(adapter, 'demo_history', {
				tenantId: 'tenant-a',
				recordId: 'claim-1',
				action,
				actor: user,
				changes: { status: { from: null, to: action } },
				occurredAt: 1_700_000_000_000,
			});
		}
		await appendRecordHistory(adapter, 'demo_history', {
			tenantId: 'tenant-a',
			recordId: 'claim-2',
			action: 'created',
			actor: user,
			changes: {},
			occurredAt: 1_700_000_000_001,
		});

		const first = await queryRecordHistory(adapter, 'demo_history', {
			tenantId: 'tenant-a',
			recordId: 'claim-1',
			limit: 2,
		});
		expect(first.entries.map((entry) => entry.version)).toEqual([3, 2]);
		expect(first.nextCursor).toBe('2');

		const second = await queryRecordHistory(adapter, 'demo_history', {
			tenantId: 'tenant-a',
			recordId: 'claim-1',
			limit: 2,
			cursor: first.nextCursor,
		});
		expect(second.entries.map((entry) => entry.version)).toEqual([1]);
		expect(second.nextCursor).toBeNull();

		/* A second record restarts at version 1 under the same tenant. */
		const other = await queryRecordHistory(adapter, 'demo_history', {
			tenantId: 'tenant-a',
			recordId: 'claim-2',
			limit: 10,
		});
		expect(other.entries.map((entry) => entry.version)).toEqual([1]);
	});

	it('never returns another tenant trail', async () => {
		await database();
		await appendRecordHistory(adapter, 'demo_history', {
			tenantId: 'tenant-a',
			recordId: 'shared',
			action: 'created',
			actor: user,
			changes: {},
			occurredAt: 1,
		});

		await expect(
			queryRecordHistory(adapter, 'demo_history', {
				tenantId: 'tenant-b',
				recordId: 'shared',
				limit: 10,
			}),
		).resolves.toEqual({ entries: [], nextCursor: null });
	});

	it('keeps an agent run id and refuses a service actor without the column', async () => {
		await database();
		await appendRecordHistory(adapter, 'demo_history', {
			tenantId: 'tenant-a',
			recordId: 'claim-1',
			action: 'approved',
			actor: {
				kind: 'agent',
				id: 'agent-1',
				label: 'Reviewer',
				runId: 'run-9',
			},
			changes: {},
			occurredAt: 5,
		});
		const page = await queryRecordHistory(adapter, 'demo_history', {
			tenantId: 'tenant-a',
			recordId: 'claim-1',
			limit: 10,
		});
		expect(page.entries[0]!.actor).toEqual({
			kind: 'agent',
			id: 'agent-1',
			label: 'Reviewer',
			runId: 'run-9',
		});

		await expect(
			appendRecordHistory(adapter, 'demo_history', {
				tenantId: 'tenant-a',
				recordId: 'claim-1',
				action: 'configured',
				actor: {
					kind: 'service',
					id: 'service-1',
					label: 'Importer',
					configuredBy: user,
				},
				changes: {},
				occurredAt: 6,
			}),
		).rejects.toThrow('configured_by_json');
	});

	it('stores and reads the configuring user when the column exists', async () => {
		await database(SERVICE_DDL);
		await appendRecordHistory(adapter, 'demo_history', {
			tenantId: 'tenant-a',
			recordId: 'claim-1',
			action: 'configured',
			actor: {
				kind: 'service',
				id: 'service-1',
				label: 'Importer',
				configuredBy: user,
			},
			changes: {},
			occurredAt: 7,
		});

		const page = await queryRecordHistory(adapter, 'demo_history', {
			tenantId: 'tenant-a',
			recordId: 'claim-1',
			limit: 10,
		});
		expect(page.entries[0]!.actor).toEqual({
			kind: 'service',
			id: 'service-1',
			label: 'Importer',
			configuredBy: user,
		});
	});

	it('refuses a table name that is not a schema identifier', async () => {
		await database();
		await expect(
			queryRecordHistory(adapter, 'demo_history; DROP TABLE demo_history', {
				tenantId: 'tenant-a',
				recordId: 'claim-1',
				limit: 10,
			}),
		).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
	});
});
