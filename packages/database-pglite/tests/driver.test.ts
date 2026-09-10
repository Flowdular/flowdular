import {
	appendRecordHistory,
	postgresTenantTableState,
	PostgresDatabaseAdapter,
	queryRecordHistory,
	runDatabaseMigrations,
	type DatabaseMigration,
} from '@flowdular/database';
import { afterEach, describe, expect, it } from 'vitest';
import { createPgliteDriverPool } from '../src/driver.ts';

const adapters: PostgresDatabaseAdapter[] = [];

afterEach(async () => {
	await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
});

/* The runtime role is what production uses: no superuser, no BYPASSRLS. Every
   lease enters it, so forced row security binds exactly as it does on a server. */
const BOOTSTRAP = `CREATE ROLE coreloom_runtime NOSUPERUSER NOBYPASSRLS;`;

function migrator(): PostgresDatabaseAdapter {
	const adapter = new PostgresDatabaseAdapter({
		pool: createPgliteDriverPool({ bootstrap: BOOTSTRAP }),
	});
	adapters.push(adapter);
	return adapter;
}

const migrations: readonly DatabaseMigration[] = [
	{
		id: '0001_demo_core',
		sql: {
			postgresql: `CREATE TABLE IF NOT EXISTS demo_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS demo_records_tenant_created_idx
  ON demo_records (tenant_id, created_at, id);
ALTER TABLE demo_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_records FORCE ROW LEVEL SECURITY;
CREATE POLICY demo_records_tenant_policy ON demo_records
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON demo_records TO coreloom_runtime;
`,
		},
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'demo_records',
				'demo_records_tenant_policy',
				[() => database.schema.hasIndex('demo_records_tenant_created_idx')],
			),
	},
];

describe('PGlite driver', () => {
	it('reports the PostgreSQL dialect and its capabilities', async () => {
		const database = migrator();

		expect(database.dialectId).toBe('postgresql');
		expect(database.capabilities.parameterStyle).toBe('numbered');
		expect(database.capabilities.migrationLock).toBe('advisory-transaction');
		expect(database.capabilities.transactionalDdl).toBe(true);
	});

	it('applies, adopts and re-reads migrations through the shared runner', async () => {
		const database = migrator();

		const applied = await runDatabaseMigrations(
			database,
			'demo.core',
			migrations,
		);
		expect(applied.map((entry) => entry.action)).toEqual(['applied']);

		const again = await runDatabaseMigrations(
			database,
			'demo.core',
			migrations,
		);
		expect(again.map((entry) => entry.action)).toEqual(['unchanged']);
	});

	it('rolls a failed transaction back, including its DDL', async () => {
		const database = migrator();

		await expect(
			database.transaction(async (transaction) => {
				await transaction.executeScript(
					'CREATE TABLE rolled_back (id TEXT PRIMARY KEY);',
				);
				throw new Error('deliberate');
			}),
		).rejects.toThrow('deliberate');

		await expect(database.schema.hasTable('rolled_back')).resolves.toBe(false);
	});

	it('serializes overlapping transactions on the single connection', async () => {
		const database = migrator();
		await database.executeScript(
			'CREATE TABLE counters (id TEXT PRIMARY KEY, total BIGINT NOT NULL);',
		);
		await database.execute({
			text: 'INSERT INTO counters (id, total) VALUES ($1, $2)',
			parameters: ['a', 0],
		});

		await Promise.all(
			Array.from({ length: 8 }, () =>
				database.transaction(async (transaction) => {
					const current = await transaction.query<{ total: string | number }>({
						text: 'SELECT total FROM counters WHERE id = $1',
						parameters: ['a'],
					});
					await transaction.execute({
						text: 'UPDATE counters SET total = $1 WHERE id = $2',
						parameters: [Number(current.rows[0]!.total) + 1, 'a'],
					});
				}),
			),
		);

		const result = await database.query<{ total: string | number }>({
			text: 'SELECT total FROM counters WHERE id = $1',
			parameters: ['a'],
		});
		expect(Number(result.rows[0]!.total)).toBe(8);
	});

	it('keeps the record history helper working on the embedded build', async () => {
		const database = migrator();
		await database.executeScript(`CREATE TABLE demo_history (
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
  occurred_at BIGINT NOT NULL
);`);

		for (const action of ['created', 'updated']) {
			await appendRecordHistory(database, 'demo_history', {
				tenantId: 'tenant-a',
				recordId: 'record-1',
				action,
				actor: { kind: 'user', id: 'account-a', label: 'Ada' },
				changes: {},
				occurredAt: 1_700_000_000_000,
			});
		}

		const page = await queryRecordHistory(database, 'demo_history', {
			tenantId: 'tenant-a',
			recordId: 'record-1',
			limit: 10,
		});
		expect(page.entries.map((entry) => entry.version)).toEqual([2, 1]);
		expect(page.entries[0]!.occurredAt).toBe(1_700_000_000_000);
	});
});

/* The reason for choosing an embedded PostgreSQL over SQLite: the isolation a
   local run exercises is the isolation production enforces, not an application
   filter that happens to agree with it. */
describe('forced row-level security on the embedded build', () => {
	async function cluster() {
		const { createPgliteCluster } = await import('../src/driver.ts');
		const created = createPgliteCluster({
			bootstrap: 'CREATE ROLE coreloom_runtime NOSUPERUSER NOBYPASSRLS;',
		});
		const migrator = new PostgresDatabaseAdapter({ pool: created.pool() });
		await runDatabaseMigrations(migrator, 'demo.core', migrations);
		await migrator.execute({
			text: 'INSERT INTO demo_records (id, tenant_id, title, created_at) VALUES ($1, $2, $3, $4)',
			parameters: ['a', 'tenant-a', 'A', 1],
		});
		await migrator.execute({
			text: 'INSERT INTO demo_records (id, tenant_id, title, created_at) VALUES ($1, $2, $3, $4)',
			parameters: ['b', 'tenant-b', 'B', 1],
		});
		const runtime = new PostgresDatabaseAdapter({
			pool: created.pool('coreloom_runtime'),
			tenantRequired: true,
		});
		adapters.push(migrator, runtime);
		return { runtime, close: () => created.close() };
	}

	it('shows one tenant only its own rows', async () => {
		const { runtime, close } = await cluster();
		try {
			const rows = async (tenantId: string) =>
				(
					await runtime.transaction(
						(transaction) =>
							transaction.query<{ id: string }>({
								text: 'SELECT id FROM demo_records ORDER BY id',
							}),
						{ access: 'read', tenantId },
					)
				).rows.map((row) => row.id);

			await expect(rows('tenant-a')).resolves.toEqual(['a']);
			await expect(rows('tenant-b')).resolves.toEqual(['b']);
		} finally {
			await close();
		}
	});

	it('refuses a forged tenant write and a missing tenant context', async () => {
		const { runtime, close } = await cluster();
		try {
			await expect(
				runtime.transaction(
					(transaction) =>
						transaction.execute({
							text: 'INSERT INTO demo_records (id, tenant_id, title, created_at) VALUES ($1, $2, $3, $4)',
							parameters: ['forged', 'tenant-b', 'Forged', 1],
						}),
					{ access: 'write', tenantId: 'tenant-a' },
				),
			).rejects.toBeDefined();

			await expect(
				runtime.transaction(async () => undefined, { access: 'read' }),
			).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
		} finally {
			await close();
		}
	});
});

/* A scheduler and a recovery worker must read across tenants. The capability is
   an explicit, read-only policy on named tables, not a role that bypasses row
   security, so a reviewer can see exactly what crosses the boundary. */
describe('cross-tenant background reads', () => {
	const BACKGROUND_ROLE = 'coreloom_background';

	async function cluster() {
		const { createPgliteCluster } = await import('../src/driver.ts');
		const created = createPgliteCluster({
			bootstrap: `CREATE ROLE coreloom_runtime NOSUPERUSER NOBYPASSRLS;
CREATE ROLE ${BACKGROUND_ROLE} NOSUPERUSER NOBYPASSRLS;`,
		});
		const migrator = new PostgresDatabaseAdapter({ pool: created.pool() });
		await migrator.executeScript(`CREATE TABLE due_work (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  ready BOOLEAN NOT NULL
);
CREATE TABLE private_notes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL
);
ALTER TABLE due_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE due_work FORCE ROW LEVEL SECURITY;
ALTER TABLE private_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY due_work_tenant_policy ON due_work
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
CREATE POLICY private_notes_tenant_policy ON private_notes
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
CREATE POLICY due_work_background_policy ON due_work
  FOR SELECT TO ${BACKGROUND_ROLE} USING (true);
GRANT SELECT ON due_work, private_notes TO ${BACKGROUND_ROLE};
INSERT INTO due_work (id, tenant_id, ready) VALUES ('a', 'tenant-a', true), ('b', 'tenant-b', true);
INSERT INTO private_notes (id, tenant_id) VALUES ('n1', 'tenant-a');
`);
		const background = new PostgresDatabaseAdapter({
			pool: created.pool(BACKGROUND_ROLE),
		});
		adapters.push(migrator, background);
		return { background, close: () => created.close() };
	}

	it('sees every tenant on a table that grants it, and none on one that does not', async () => {
		const { background, close } = await cluster();
		try {
			const due = await background.query<{ id: string }>({
				text: 'SELECT id FROM due_work ORDER BY id',
			});
			expect(due.rows.map((row) => row.id)).toEqual(['a', 'b']);

			/* No background policy on this table, so forced row security still
			   answers with nothing even though the role holds SELECT. */
			const notes = await background.query<{ id: string }>({
				text: 'SELECT id FROM private_notes',
			});
			expect(notes.rows).toEqual([]);
		} finally {
			await close();
		}
	});

	it('cannot write through the background role', async () => {
		const { background, close } = await cluster();
		try {
			await expect(
				background.execute({
					text: "UPDATE due_work SET ready = false WHERE id = 'a'",
				}),
			).rejects.toBeDefined();
		} finally {
			await close();
		}
	});
});
