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
	DatabaseAccessRepository,
	migrateAccessDatabase,
} from '../../src/services/database-repository.ts';
import { ACCESS_TENANT_TABLES } from '../../src/services/migration.ts';

export { ACCESS_TENANT_TABLES };

export interface AccessTestDatabase {
	readonly databases: DatabaseProvider;
	readonly repository: DatabaseAccessRepository;
	/** Tenant-scoped handle, for the writes the repository will not make. */
	readonly runtime: DatabaseHandle;
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
 * security, migrated to this module's schema. Starting the engine costs about
 * two seconds, so open one per file and `reset()` between cases.
 */
export async function openAccessTestDatabase(): Promise<AccessTestDatabase> {
	const databases: DatabaseProvider = createPgliteTestProvider();
	const leases: DatabaseAdapterLease[] = [];
	try {
		/* The owner lease outlives the migration: only a role above row-level
		   security can empty the tables between cases. */
		const owner = await databases.acquire({
			namespace: 'access.core',
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
		await migrateAccessDatabase(owner.database);
		const runtime = await databases.acquire({
			namespace: 'access.core',
			purpose: 'test',
			requirements: REQUIREMENTS,
		});
		leases.push(runtime);
		return {
			databases,
			repository: new DatabaseAccessRepository(runtime.database),
			runtime: runtime.database,
			async reset() {
				await owner.database.transaction(
					(transaction) =>
						transaction.execute({
							text: `TRUNCATE ${ACCESS_TENANT_TABLES.join(', ')}`,
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
