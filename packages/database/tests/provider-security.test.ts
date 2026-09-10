import { createPgliteCluster } from '@flowdular/database-pglite';
import {
	createPgliteTestProvider,
	createTestDatabaseProvider,
} from '@flowdular/database-testing';
import { describe, expect, it } from 'vitest';
import {
	createDatabaseProvider,
	runDatabaseMigrations,
	type DatabaseProvider,
	type DatabaseRequirements,
} from '../src/index.ts';

const providers: readonly [string, () => DatabaseProvider][] = [
	[
		'platform',
		() =>
			createDatabaseProvider(
				{
					adapter: 'pglite',
					production: false,
					workspaceRoot: '/unused',
					environment: {},
				},
				{ pgliteCluster: createPgliteCluster },
			),
	],
	['test', createPgliteTestProvider],
	['selected test adapter', createTestDatabaseProvider],
];

describe.each(providers)('%s provider boundaries', (_name, create) => {
	it('lets runtime inserts use module-owned sequences without granting background access', async () => {
		const provider = create();
		const migration = await provider.acquire({
			namespace: 'demo.core',
			purpose: 'migration',
		});
		const runtime = await provider.acquire({
			namespace: 'demo.core',
			purpose: 'runtime',
		});
		const background = await provider.acquire({
			namespace: 'demo.core',
			purpose: 'background',
		});
		try {
			await migration.database.executeScript(`CREATE TABLE sequence_records (
				id SERIAL NOT NULL,
				tenant_id TEXT NOT NULL,
				PRIMARY KEY (tenant_id, id)
			);
			ALTER TABLE sequence_records ENABLE ROW LEVEL SECURITY;
			ALTER TABLE sequence_records FORCE ROW LEVEL SECURITY;
			CREATE POLICY sequence_records_tenant_policy ON sequence_records
				USING (tenant_id = current_setting('coreloom.tenant_id', true))
				WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));`);
			const insert = (tenantId: string) =>
				runtime.database.transaction(
					(tx) =>
						tx.query<{ id: number }>({
							text: 'INSERT INTO sequence_records (tenant_id) VALUES ($1) RETURNING id',
							parameters: [tenantId],
						}),
					{ tenantId, access: 'write' },
				);
			expect((await insert('tenant-a')).rows).toEqual([{ id: 1 }]);
			expect((await insert('tenant-b')).rows).toEqual([{ id: 2 }]);
			const visible = await runtime.database.transaction(
				(tx) =>
					tx.query({
						text: 'SELECT id FROM sequence_records',
					}),
				{ tenantId: 'tenant-a', access: 'read' },
			);
			expect(visible.rows).toEqual([{ id: 1 }]);
			await expect(
				background.database.query({
					text: "SELECT nextval('sequence_records_id_seq')",
				}),
			).rejects.toMatchObject({ code: '42501' });
		} finally {
			await background.release();
			await runtime.release();
			await migration.release();
			await provider.dispose();
		}
	}, 30_000);

	it.each<DatabaseRequirements>([
		{ adapterIds: ['other.adapter'] },
		{ dialectIds: ['other-dialect'] },
		{ capabilities: ['other.capability'] },
	])(
		'refuses incompatible requirements without retaining a lease: %j',
		async (requirements) => {
			const provider = create();
			try {
				// Release even an incorrect successful lease so the regression cannot hang disposal.
				await expect(
					provider
						.acquire({
							namespace: 'demo.core',
							purpose: 'runtime',
							requirements,
						})
						.then(async (lease) => {
							await lease.release();
							return lease;
						}),
				).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
			} finally {
				await provider.dispose();
			}
		},
	);

	it('refuses an already cancelled acquisition', async () => {
		const provider = create();
		try {
			await expect(
				provider
					.acquire({
						namespace: 'demo.core',
						purpose: 'runtime',
						signal: AbortSignal.abort(),
					})
					.then(async (lease) => {
						await lease.release();
						return lease;
					}),
			).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
		} finally {
			await provider.dispose();
		}
	});

	it('keeps the checksum ledger writable only by the migrator, including after an upgrade', async () => {
		const provider = create();
		const migration = await provider.acquire({
			namespace: 'demo.core',
			purpose: 'migration',
		});
		const runtime = await provider.acquire({
			namespace: 'demo.core',
			purpose: 'runtime',
		});
		try {
			const migrations = [
				{ id: '0001_demo_core', sql: { postgresql: 'SELECT 1;' } },
			];
			for (const upgrade of [false, true]) {
				if (upgrade)
					await migration.database.executeScript(
						'GRANT ALL ON _coreloom_migrations_v2 TO coreloom_runtime;',
					);
				await runDatabaseMigrations(
					migration.database,
					'demo.core',
					migrations,
				);
				for (const text of [
					"UPDATE _coreloom_migrations_v2 SET checksum = 'tampered'",
					'DELETE FROM _coreloom_migrations_v2',
					"INSERT INTO _coreloom_migrations_v2 VALUES ('fake.core', '0001_fake', 'postgresql', 'fake', 0)",
					'TRUNCATE _coreloom_migrations_v2',
				]) {
					await expect(
						runtime.database.transaction((tx) => tx.execute({ text }), {
							tenantId: 'tenant-a',
							access: 'write',
						}),
					).rejects.toMatchObject({ code: '42501' });
				}
				await expect(
					runDatabaseMigrations(migration.database, 'demo.core', migrations),
				).resolves.toMatchObject([{ action: 'unchanged' }]);
			}
		} finally {
			await runtime.release();
			await migration.release();
			await provider.dispose();
		}
	}, 30_000);
});
