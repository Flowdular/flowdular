import { readdirSync, readFileSync } from 'node:fs';
import {
	databaseMigrationStatus,
	type DatabaseProvider,
} from '@flowdular/database';
import { describe, expect, it } from 'vitest';
import { migrateWorkflowsDatabase } from '../src/services/database-repository.ts';
import { databaseMigrations } from '../src/services/migration.ts';
import {
	createWorkflowsTestProvider,
	withOwnerHandle,
} from './support/database.ts';

const directory = new URL('../migrations/', import.meta.url);

/* The runtime applies the v2 ledger, so a database is read back through the
   same runner the module uses. */
function states(databases: DatabaseProvider): Promise<readonly string[]> {
	return withOwnerHandle(databases, async (database) =>
		(
			await databaseMigrationStatus(
				database,
				'workflows.core',
				databaseMigrations,
			)
		).map((entry) => entry.state),
	);
}

describe('workflows migrations', () => {
	it('mirrors every up file byte for byte', () => {
		const files = readdirSync(directory)
			.filter((name) => name.endsWith('.up.sql'))
			.sort();

		expect(
			databaseMigrations.map((migration) => `${migration.id}.up.sql`),
		).toEqual(files);
		for (const migration of databaseMigrations) {
			expect(migration.sql.postgresql).toBe(
				readFileSync(new URL(`${migration.id}.up.sql`, directory), 'utf8'),
			);
		}
	});

	/* Every tenant table must carry forced row security, or the runtime role
	   could read another tenant. */
	it('declares forced row security for every tenant table', () => {
		for (const migration of databaseMigrations) {
			const sql = migration.sql.postgresql ?? '';
			if (!sql.includes('CREATE TABLE')) continue;
			expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
			expect(sql).toContain('FORCE ROW LEVEL SECURITY');
			expect(sql).toContain("current_setting('coreloom.tenant_id', true)");
			expect(sql).toContain('WITH CHECK');
		}
	});

	it('applies on a fresh database and is unchanged on the second run', async () => {
		const databases = createWorkflowsTestProvider();
		try {
			await withOwnerHandle(databases, migrateWorkflowsDatabase);
			expect(await states(databases)).toEqual(
				databaseMigrations.map(() => 'applied'),
			);

			await withOwnerHandle(databases, migrateWorkflowsDatabase);
			expect(await states(databases)).toEqual(
				databaseMigrations.map(() => 'applied'),
			);
		} finally {
			await databases.dispose();
		}
	});

	it('adopts a complete pre-ledger schema without replaying or losing data', async () => {
		const databases = createWorkflowsTestProvider();
		try {
			await withOwnerHandle(databases, (database) =>
				database.transaction(
					async (transaction) => {
						for (const migration of databaseMigrations) {
							await transaction.executeScript(migration.sql.postgresql!);
						}
						await transaction.execute({
							text: `INSERT INTO workflow_definitions
							 (id, tenant_id, workflow_key, name, description, status,
							  current_draft_revision, published_revision, created_at, updated_at)
							 VALUES ($1, $2, $3, $4, $5, 'active', 1, NULL, 1, 1)`,
							parameters: [
								'workflow-1',
								'tenant-a',
								'adopted-flow',
								'Adopted',
								'Kept',
							],
						});
					},
					{ access: 'write', tenantId: 'tenant-a' },
				),
			);
			expect(await states(databases)).toEqual(
				databaseMigrations.map(() => 'adopted'),
			);

			await withOwnerHandle(databases, migrateWorkflowsDatabase);
			expect(await states(databases)).toEqual(
				databaseMigrations.map(() => 'applied'),
			);
			const kept = await withOwnerHandle(databases, (database) =>
				database.transaction(
					(transaction) =>
						transaction.query<{ name: string }>({
							text: 'SELECT name FROM workflow_definitions',
						}),
					{ access: 'read', tenantId: 'tenant-a' },
				),
			);
			expect(kept.rows).toEqual([{ name: 'Adopted' }]);
		} finally {
			await databases.dispose();
		}
	});
});
