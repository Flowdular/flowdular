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
	DatabaseNotificationsRepository,
	migrateNotificationsDatabase,
} from '../../src/services/database-repository.ts';

export interface NotificationsTestDatabase {
	/** Migrated provider, for a runtime that should acquire its own leases. */
	readonly databases: DatabaseProvider;
	readonly repository: DatabaseNotificationsRepository;
	/** Tenant-scoped handle, for assertions the repository does not expose. */
	readonly runtime: DatabaseHandle;
	/** Cross-tenant read handle held by the delivery poll. */
	readonly background: DatabaseHandle;
	/** Empties every module table so one engine can serve a whole file. */
	reset(): Promise<void>;
	dispose(): Promise<void>;
}

export const NOTIFICATIONS_TENANT_TABLES = [
	'notifications_inbox',
	'notifications_preferences',
	'notifications_member_preferences',
	'notifications_webhook_subscriptions',
	'notifications_deliveries',
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
export async function openNotificationsTestDatabase(): Promise<NotificationsTestDatabase> {
	const databases: DatabaseProvider = createPgliteTestProvider();
	const leases: DatabaseAdapterLease[] = [];
	try {
		/* The owner lease outlives the migration: only a role above row-level
		   security can empty the tables between cases. */
		const owner = await databases.acquire({
			namespace: 'notifications.core',
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
		await migrateNotificationsDatabase(owner.database);
		const runtime = await databases.acquire({
			namespace: 'notifications.core',
			purpose: 'test',
			requirements: REQUIREMENTS,
		});
		leases.push(runtime);
		const background = await databases.acquire({
			namespace: 'notifications.core',
			purpose: 'background',
			requirements: REQUIREMENTS,
		});
		leases.push(background);
		return {
			databases,
			repository: new DatabaseNotificationsRepository({
				runtime: runtime.database,
				background: background.database,
			}),
			runtime: runtime.database,
			background: background.database,
			async reset() {
				await owner.database.transaction(
					(transaction) =>
						transaction.execute({
							text: `TRUNCATE ${NOTIFICATIONS_TENANT_TABLES.join(', ')}`,
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
