import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseAdapterLease,
	type DatabaseProvider,
} from '@flowdular/database';
import { createTestDatabaseProvider } from '@flowdular/database-testing';
import { DatabaseProviderRepository } from '../../src/services/provider-repository.ts';
import {
	DatabaseAgentRepository,
	migrateAgentsDatabase,
} from '../../src/services/database-repository.ts';

export interface AgentsTestDatabase {
	readonly databases: DatabaseProvider;
	readonly repository: DatabaseAgentRepository;
	readonly providers: DatabaseProviderRepository;
	/** Empties every table so the next case starts from a known state. */
	truncate(): Promise<void>;
	dispose(): Promise<void>;
}

const REQUIREMENTS = {
	dialectIds: [DATABASE_DIALECT_IDS.postgresql],
	capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
};

/**
 * An embedded PostgreSQL for one test file. Starting the engine costs about
 * half a second, so a suite starts it once and truncates between cases instead
 * of paying that per test.
 */
export async function openAgentsTestDatabase(): Promise<AgentsTestDatabase> {
	const databases = createTestDatabaseProvider();
	const migration = await databases.acquire({
		namespace: 'agents.core',
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
	await migrateAgentsDatabase(migration.database);
	const runtime = await databases.acquire({
		namespace: 'agents.core',
		purpose: 'test',
		requirements: REQUIREMENTS,
	});
	const background = await databases.acquire({
		namespace: 'agents.core',
		purpose: 'background',
		requirements: REQUIREMENTS,
	});
	const leases: readonly DatabaseAdapterLease[] = [
		background,
		runtime,
		migration,
	];
	const repository = new DatabaseAgentRepository({
		runtime: runtime.database,
		background: background.database,
	});
	await repository.adoptCurrentAgentRevisions();
	return {
		databases,
		repository,
		providers: new DatabaseProviderRepository(runtime.database),
		async truncate() {
			await migration.database.transaction(
				async (transaction) => {
					const tables = await transaction.query<{ tablename: string }>({
						text: `SELECT tablename FROM pg_tables
						       WHERE schemaname = current_schema()
						         AND tablename <> '_coreloom_migrations_v2'`,
					});
					if (tables.rows.length === 0) return;
					await transaction.execute({
						text: `TRUNCATE ${tables.rows
							.map((row) => `"${row.tablename}"`)
							.join(', ')} RESTART IDENTITY CASCADE`,
					});
				},
				{ access: 'write' },
			);
		},
		async dispose() {
			for (const lease of leases) await lease.release();
			await databases.dispose();
		},
	};
}
