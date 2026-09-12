import type {
	DatabaseAdapterLease,
	DatabaseHandle,
	DatabaseProvider,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import { createPgliteTestProvider } from '@flowdular/database-testing';
import {
	DatabaseDocumentsRepository,
	migrateDocumentsDatabase,
} from '../../src/services/database-repository.ts';
import {
	DocumentsService,
	type DocumentsServiceOptions,
} from '../../src/services/documents-service.ts';
import {
	openTestStorage,
	type TestStorage,
	type TestStorageOptions,
} from './storage.ts';

export const DOCUMENTS_TENANT_TABLES = ['documents_files'] as const;

export interface DocumentsTestContext {
	readonly databases: DatabaseProvider;
	readonly repository: DatabaseDocumentsRepository;
	/** Tenant-scoped handle, for assertions the repository does not expose. */
	readonly runtime: DatabaseHandle;
	readonly storage: TestStorage;
	/** A service over the same repository and port, with the seams a case needs. */
	service(
		options?: Partial<
			Pick<
				DocumentsServiceOptions,
				'quotaBytes' | 'readUrlSeconds' | 'now' | 'newId'
			>
		>,
	): DocumentsService;
	reset(): Promise<void>;
	dispose(): Promise<void>;
}

const REQUIREMENTS = {
	dialectIds: [DATABASE_DIALECT_IDS.postgresql],
	capabilities: [
		DATABASE_CAPABILITY_IDS.ROW_LEVEL_SECURITY,
		DATABASE_CAPABILITY_IDS.TENANT_CONTEXT,
		DATABASE_CAPABILITY_IDS.TRANSACTIONS,
	],
} as const;

/**
 * An embedded PostgreSQL with the real runtime role and forced row-level
 * security, plus the real storage port over a temporary directory. Starting the
 * engine costs seconds, so open one per file and `reset()` between cases.
 */
export async function openDocumentsTestContext(
	storageOptions: TestStorageOptions = {},
): Promise<DocumentsTestContext> {
	const storage = await openTestStorage(storageOptions);
	const databases: DatabaseProvider = createPgliteTestProvider();
	const leases: DatabaseAdapterLease[] = [];
	try {
		/* The owner lease outlives the migration: only a role above row-level
		   security can empty the tables between cases. */
		const owner = await databases.acquire({
			namespace: 'documents.core',
			purpose: 'migration',
			requirements: {
				dialectIds: REQUIREMENTS.dialectIds,
				capabilities: [
					DATABASE_CAPABILITY_IDS.MIGRATION_LOCK,
					DATABASE_CAPABILITY_IDS.SCHEMA_INTROSPECTION,
					DATABASE_CAPABILITY_IDS.TRANSACTIONAL_DDL,
				],
			},
		});
		leases.push(owner);
		await migrateDocumentsDatabase(owner.database);
		const runtime = await databases.acquire({
			namespace: 'documents.core',
			purpose: 'test',
			requirements: REQUIREMENTS,
		});
		leases.push(runtime);
		const repository = new DatabaseDocumentsRepository(runtime.database);
		return {
			databases,
			repository,
			runtime: runtime.database,
			storage,
			service(options = {}) {
				return new DocumentsService({
					repository,
					storage: storage.port,
					quotaBytes: options.quotaBytes ?? (() => 10 * 1024 * 1024),
					readUrlSeconds: options.readUrlSeconds ?? (() => 300),
					...(options.now ? { now: options.now } : {}),
					...(options.newId ? { newId: options.newId } : {}),
				});
			},
			async reset() {
				await owner.database.transaction(
					(transaction) =>
						transaction.execute({
							text: `TRUNCATE ${DOCUMENTS_TENANT_TABLES.join(', ')}`,
						}),
					{ access: 'write' },
				);
				/* The rows and the objects are two stores; a case that asserts one is
				   absent has to start with both empty. */
				await storage.clear();
			},
			async dispose() {
				for (const lease of leases.reverse()) await lease.release();
				await databases.dispose();
				await storage.dispose();
			},
		};
	} catch (error) {
		for (const lease of leases.reverse()) await lease.release();
		await databases.dispose();
		await storage.dispose();
		throw error;
	}
}
