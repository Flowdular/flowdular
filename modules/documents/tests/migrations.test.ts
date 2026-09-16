import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
	DATABASE_MIGRATION_LEDGER,
	databaseMigrationStatus,
	runDatabaseMigrations,
	type DatabaseHandle,
	type DatabaseProvider,
} from '@flowdular/database';
import { createTestDatabaseProvider } from '@flowdular/database-testing';
import { databaseMigrations } from '../src/services/migration.ts';
import { migrateDocumentsDatabase } from '../src/services/database-repository.ts';
import { DOCUMENTS_TENANT_TABLES } from './support/database.ts';

const directory = new URL('../migrations/', import.meta.url);

let providers: DatabaseProvider[] = [];

afterEach(async () => {
	const open = providers;
	providers = [];
	for (const provider of open) await provider.dispose();
});

async function migrator(): Promise<DatabaseHandle> {
	const provider = createTestDatabaseProvider();
	providers.push(provider);
	const lease = await provider.acquire({
		namespace: 'documents.core',
		purpose: 'migration',
	});
	return lease.database;
}

interface RelationSecurity {
	readonly relrowsecurity: boolean;
	readonly relforcerowsecurity: boolean;
	readonly policies: number | bigint | string;
}

describe('documents migrations', () => {
	it('mirrors every numbered up file byte for byte', () => {
		for (const migration of databaseMigrations) {
			expect(migration.sql.postgresql).toBe(
				readFileSync(new URL(`${migration.id}.up.sql`, directory), 'utf8'),
			);
		}
	});

	it('applies every migration once and records it in the ledger', async () => {
		const database = await migrator();
		const applied = await runDatabaseMigrations(
			database,
			'documents.core',
			databaseMigrations,
		);
		expect(applied.map((result) => [result.id, result.action])).toEqual(
			databaseMigrations.map((migration) => [migration.id, 'applied']),
		);
		const ledger = await database.transaction(
			(transaction) =>
				transaction.query<{ id: string }>({
					text: `SELECT id FROM ${DATABASE_MIGRATION_LEDGER}
					 WHERE namespace = $1 ORDER BY id`,
					parameters: ['documents.core'],
				}),
			{ access: 'read' },
		);
		expect(ledger.rows.map((row) => row.id)).toEqual(
			databaseMigrations.map((migration) => migration.id),
		);

		const second = await runDatabaseMigrations(
			database,
			'documents.core',
			databaseMigrations,
		);
		expect(second.every((result) => result.action === 'unchanged')).toBe(true);
	});

	it('forces row level security with a tenant policy on every tenant table', async () => {
		const database = await migrator();
		await migrateDocumentsDatabase(database);
		for (const table of DOCUMENTS_TENANT_TABLES) {
			const security = await database.transaction(
				(transaction) =>
					transaction.query<RelationSecurity>({
						text: `SELECT relation.relrowsecurity, relation.relforcerowsecurity,
						              (SELECT count(*) FROM pg_policy
						               WHERE polrelid = relation.oid
						                 AND polname = $2) AS policies
						       FROM pg_class AS relation
						       JOIN pg_namespace AS namespace
						         ON namespace.oid = relation.relnamespace
						       WHERE namespace.nspname = current_schema()
						         AND relation.relname = $1`,
						parameters: [table, `${table}_tenant_policy`],
					}),
				{ access: 'read' },
			);
			expect(security.rows[0]).toMatchObject({
				relrowsecurity: true,
				relforcerowsecurity: true,
			});
			expect(Number(security.rows[0]?.policies)).toBe(1);
		}
	});

	/* The quota sum and the record lookup both read an index; a schema without
	   one still answers, but it answers by walking the workspace's rows. */
	it('creates the indexes the quota and the attachment lookup read', async () => {
		const database = await migrator();
		await migrateDocumentsDatabase(database);
		const present = await database.transaction(
			(transaction) =>
				transaction.query<{ indexname: string }>({
					text: `SELECT indexname FROM pg_indexes
					 WHERE schemaname = current_schema() AND tablename = 'documents_files'
					 ORDER BY indexname`,
				}),
			{ access: 'read' },
		);
		expect(present.rows.map((row) => row.indexname)).toEqual([
			'documents_files_page_idx',
			'documents_files_pkey',
			'documents_files_record_idx',
			'documents_files_storage_key_idx',
			'documents_files_tenant_created_idx',
			'documents_files_usage_idx',
		]);
	});

	it('refuses a second row on one storage key', async () => {
		const database = await migrator();
		await migrateDocumentsDatabase(database);
		const insert = (id: string) =>
			database.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO documents_files
						 (id, tenant_id, owner_module, record_ref, filename, content_type,
						  bytes, checksum, storage_key, uploader_account_id, scan, status,
						  description, created_at)
						 VALUES ($1, 'tenant-a', 'directory.core', 'party-4711',
						         'contract.pdf', 'application/pdf', 10, NULL,
						         'tenant-a/documents.core/object-1', 'account-ada',
						         'clean', 'stored', NULL, 1)`,
						parameters: [id],
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			);
		await insert('document-1');
		await expect(insert('document-2')).rejects.toThrow();
	});

	it('adopts a schema that already carries the objects instead of reapplying them', async () => {
		const database = await migrator();
		await migrateDocumentsDatabase(database);
		await database.transaction(
			(transaction) =>
				transaction.execute({
					text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = $1`,
					parameters: ['documents.core'],
				}),
			{ access: 'write' },
		);

		const status = await databaseMigrationStatus(
			database,
			'documents.core',
			databaseMigrations,
		);
		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'adopted'),
		);

		const adopted = await runDatabaseMigrations(
			database,
			'documents.core',
			databaseMigrations,
		);
		expect(adopted.every((result) => result.action === 'adopted')).toBe(true);
	});

	it('DOCUMENTS-TEXT-TENANT creates the text indexes and grants the background role the routing columns alone', async () => {
		const database = await migrator();
		await migrateDocumentsDatabase(database);
		const indexes = await database.transaction(
			(transaction) =>
				transaction.query<{ indexname: string }>({
					text: `SELECT indexname FROM pg_indexes
					 WHERE schemaname = current_schema() AND tablename = 'documents_text'
					 ORDER BY indexname`,
				}),
			{ access: 'read' },
		);
		expect(indexes.rows.map((row) => row.indexname)).toEqual([
			'documents_text_checksum_idx',
			'documents_text_pending_idx',
			'documents_text_pkey',
		]);
		const grants = await database.transaction(
			(transaction) =>
				transaction.query<{ column_name: string; granted: boolean }>({
					text: `SELECT column_name,
					        has_column_privilege('coreloom_background', 'documents_text', column_name, 'SELECT') AS granted
					 FROM information_schema.columns
					 WHERE table_schema = current_schema() AND table_name = 'documents_text'
					 ORDER BY column_name`,
				}),
			{ access: 'read' },
		);
		expect(
			grants.rows.filter((row) => row.granted).map((row) => row.column_name),
		).toEqual(['document_id', 'requested_at', 'status', 'tenant_id']);
	});

	it('reports a text table without its background grant as partial', async () => {
		const database = await migrator();
		await migrateDocumentsDatabase(database);
		await database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = $1 AND id = $2`,
					parameters: ['documents.core', '0004_documents_text'],
				});
				await transaction.execute({
					text: 'REVOKE SELECT (tenant_id, document_id, status, requested_at) ON documents_text FROM coreloom_background',
				});
			},
			{ access: 'write' },
		);
		const status = await databaseMigrationStatus(
			database,
			'documents.core',
			databaseMigrations,
		);
		expect(status.at(-1)).toMatchObject({
			id: '0004_documents_text',
			state: 'partial',
		});
	});

	it('reports a pending schema before anything is applied', async () => {
		const database = await migrator();
		const status = await databaseMigrationStatus(
			database,
			'documents.core',
			databaseMigrations,
		);
		expect(status.map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'pending'),
		);
	});
});
