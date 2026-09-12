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
	DatabaseConnectorsRepository,
	migrateConnectorsDatabase,
} from '../../src/services/database-repository.ts';

export interface ConnectorsTestDatabase {
	/** Migrated provider, for a runtime that should acquire its own leases. */
	readonly databases: DatabaseProvider;
	readonly repository: DatabaseConnectorsRepository;
	/** Tenant-scoped handle, for assertions the repository does not expose. */
	readonly runtime: DatabaseHandle;
	/** Empties every module table so one engine can serve a whole file. */
	reset(): Promise<void>;
	dispose(): Promise<void>;
}

export const CONNECTORS_TENANT_TABLES = [
	'connectors_instances',
	'connectors_calls',
	'connectors_audit',
	'connectors_call_keys',
] as const;

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
 * security, migrated to the module's current schema. Starting the engine costs
 * about half a second, so open one per file and `reset()` between cases rather
 * than paying it per test.
 */
export async function openConnectorsTestDatabase(): Promise<ConnectorsTestDatabase> {
	const databases: DatabaseProvider = createPgliteTestProvider();
	const leases: DatabaseAdapterLease[] = [];
	try {
		/* The owner lease outlives the migration: only a role above row-level
		   security can empty the tables between cases. */
		const owner = await databases.acquire({
			namespace: 'connectors.core',
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
		await migrateConnectorsDatabase(owner.database);
		const runtime = await databases.acquire({
			namespace: 'connectors.core',
			purpose: 'test',
			requirements: REQUIREMENTS,
		});
		leases.push(runtime);
		return {
			databases,
			repository: new DatabaseConnectorsRepository(runtime.database),
			runtime: runtime.database,
			async reset() {
				await owner.database.transaction(
					(transaction) =>
						transaction.execute({
							text: `TRUNCATE ${CONNECTORS_TENANT_TABLES.join(', ')}`,
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
