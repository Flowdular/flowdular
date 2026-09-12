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
	DatabaseApprovalsRepository,
	migrateApprovalsDatabase,
} from '../../src/services/database-repository.ts';

export interface ApprovalsTestDatabase {
	/** Migrated provider, for a runtime that should acquire its own leases. */
	readonly databases: DatabaseProvider;
	readonly repository: DatabaseApprovalsRepository;
	/** Tenant-scoped handle, for assertions the repository does not expose. */
	readonly runtime: DatabaseHandle;
	/** Cross-tenant read handle held by the expiry poll. */
	readonly background: DatabaseHandle;
	/** Empties every module table so one engine can serve a whole file. */
	reset(): Promise<void>;
	dispose(): Promise<void>;
}

export const APPROVALS_TENANT_TABLES = [
	'approvals_requests',
	'approvals_eligible',
	'approvals_decisions',
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
 * An embedded PostgreSQL with the real runtime and background roles and forced
 * row-level security, migrated to the module's current schema. Starting the
 * engine costs about half a second, so open one per file and `reset()` between
 * cases rather than paying it per test.
 */
export async function openApprovalsTestDatabase(): Promise<ApprovalsTestDatabase> {
	const databases: DatabaseProvider = createPgliteTestProvider();
	const leases: DatabaseAdapterLease[] = [];
	try {
		/* The owner lease outlives the migration: only a role above row-level
		   security can empty the tables between cases. */
		const owner = await databases.acquire({
			namespace: 'approvals.core',
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
		await migrateApprovalsDatabase(owner.database);
		const runtime = await databases.acquire({
			namespace: 'approvals.core',
			purpose: 'test',
			requirements: REQUIREMENTS,
		});
		leases.push(runtime);
		const background = await databases.acquire({
			namespace: 'approvals.core',
			purpose: 'background',
			requirements: REQUIREMENTS,
		});
		leases.push(background);
		return {
			databases,
			repository: new DatabaseApprovalsRepository({
				runtime: runtime.database,
				background: background.database,
			}),
			runtime: runtime.database,
			background: background.database,
			async reset() {
				await owner.database.transaction(
					(transaction) =>
						transaction.execute({
							text: `TRUNCATE ${APPROVALS_TENANT_TABLES.join(', ')}`,
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
