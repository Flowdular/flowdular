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
	DatabaseAdaptersRepository,
	migrateAdaptersDatabase,
} from '../../src/services/database-repository.ts';
import { ADAPTERS_TENANT_TABLES } from '../../src/services/migration.ts';

export interface AdaptersTestDatabase {
	readonly databases: DatabaseProvider;
	readonly repository: DatabaseAdaptersRepository;
	/** Tenant-scoped runtime handle, for reads a case asserts with. */
	readonly runtime: DatabaseHandle;
	readonly background: DatabaseHandle;
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
 * The embedded PostgreSQL, or the cluster FD_TEST_DATABASE_ADAPTER names, with
 * the real runtime and background roles and forced row-level security,
 * migrated to this module's schema. Open one per file, `reset()` per case.
 */
export async function openAdaptersTestDatabase(): Promise<AdaptersTestDatabase> {
	const databases = createTestDatabaseProvider();
	const leases: DatabaseAdapterLease[] = [];
	try {
		/* The owner lease outlives the migration: only a role above row-level
		   security can empty the tables between cases. */
		const owner = await databases.acquire({
			namespace: 'adapters.core',
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
		await migrateAdaptersDatabase(owner.database);
		const runtime = await databases.acquire({
			namespace: 'adapters.core',
			purpose: 'test',
			requirements: REQUIREMENTS,
		});
		leases.push(runtime);
		const background = await databases.acquire({
			namespace: 'adapters.core',
			purpose: 'background',
			requirements: REQUIREMENTS,
		});
		leases.push(background);
		return {
			databases,
			repository: new DatabaseAdaptersRepository({
				runtime: runtime.database,
				background: background.database,
			}),
			runtime: runtime.database,
			background: background.database,
			async reset() {
				await owner.database.transaction(
					(transaction) =>
						transaction.execute({
							text: `TRUNCATE ${ADAPTERS_TENANT_TABLES.join(', ')}`,
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
