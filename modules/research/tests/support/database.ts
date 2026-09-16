import type {
	DatabaseAdapterLease,
	DatabaseHandle,
	DatabaseProvider,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import { createTestDatabaseProvider } from '@flowdular/database-testing';
import {
	DatabaseResearchRepository,
	migrateResearchDatabase,
} from '../../src/services/database-repository.ts';
import { RESEARCH_TENANT_TABLES } from '../../src/services/migration.ts';

export interface ResearchTestDatabase {
	readonly databases: DatabaseProvider;
	readonly repository: DatabaseResearchRepository;
	/** Tenant-scoped runtime handle, for the reads and writes a case asserts with. */
	readonly runtime: DatabaseHandle;
	reset(): Promise<void>;
	dispose(): Promise<void>;
}

/**
 * The embedded PostgreSQL, or the cluster FD_TEST_DATABASE_ADAPTER names, with
 * the real runtime role and forced row-level security, migrated to this
 * module's schema. Open one per file and `reset()` between cases.
 */
export async function openResearchTestDatabase(): Promise<ResearchTestDatabase> {
	const databases = createTestDatabaseProvider();
	const leases: DatabaseAdapterLease[] = [];
	try {
		/* The owner lease outlives the migration: only a role above row-level
		   security can empty the tables between cases. */
		const owner = await databases.acquire({
			namespace: 'research.core',
			purpose: 'migration',
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [
					DATABASE_CAPABILITY_IDS.MIGRATION_LOCK,
					DATABASE_CAPABILITY_IDS.SCHEMA_INTROSPECTION,
					DATABASE_CAPABILITY_IDS.TRANSACTIONAL_DDL,
				],
			},
		});
		leases.push(owner);
		await migrateResearchDatabase(owner.database);
		const runtime = await databases.acquire({
			namespace: 'research.core',
			purpose: 'test',
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [
					DATABASE_CAPABILITY_IDS.ROW_LEVEL_SECURITY,
					DATABASE_CAPABILITY_IDS.TENANT_CONTEXT,
					DATABASE_CAPABILITY_IDS.TRANSACTIONS,
				],
			},
		});
		leases.push(runtime);
		return {
			databases,
			repository: new DatabaseResearchRepository(runtime.database),
			runtime: runtime.database,
			async reset() {
				await owner.database.transaction(
					(transaction) =>
						transaction.execute({
							text: `TRUNCATE ${RESEARCH_TENANT_TABLES.join(', ')}`,
						}),
					{ access: 'write' },
				);
			},
			async dispose() {
				for (const lease of leases.reverse()) await lease.release();
				await databases.dispose();
			},
		};
	} catch (error) {
		for (const lease of leases.reverse()) await lease.release();
		await databases.dispose();
		throw error;
	}
}
