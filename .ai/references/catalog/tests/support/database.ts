import type { DatabaseHandle, DatabaseProvider } from '@flowdular/sdk/database';
import { createTestDatabaseProvider } from '@flowdular/sdk/database-testing';
import {
	DatabaseCatalogRepository,
	migrateCatalogDatabase,
} from '../../src/services/database-repository.ts';

const TENANT_TABLES = [
	'catalog_items',
	'catalog_items_history',
	'catalog_items_history_v2',
	'catalog_idempotency_ledger',
];

export interface CatalogTestDatabase {
	readonly provider: DatabaseProvider;
	readonly runtime: DatabaseHandle;
	readonly repository: DatabaseCatalogRepository;
	dispose(): Promise<void>;
}

/* Booting an embedded PostgreSQL costs about two seconds, so a test file shares
   one migrated cluster and every fixture starts from truncated tables instead.
   Call closeCatalogTestDatabases() from the file's afterAll. */
let shared: Promise<DatabaseProvider> | undefined;

/** The file's migrated provider, with every catalog table emptied. */
export async function catalogTestProvider(): Promise<DatabaseProvider> {
	shared ??= (async () => {
		const provider = createTestDatabaseProvider();
		const lease = await provider.acquire({
			namespace: 'catalog.core',
			purpose: 'migration',
		});
		try {
			await migrateCatalogDatabase(lease.database);
		} finally {
			await lease.release();
		}
		return provider;
	})();
	const provider = await shared;
	const migration = await provider.acquire({
		namespace: 'catalog.core',
		purpose: 'migration',
	});
	try {
		await migration.database.execute({
			text: `TRUNCATE ${TENANT_TABLES.join(', ')} RESTART IDENTITY CASCADE`,
		});
	} finally {
		await migration.release();
	}
	return provider;
}

/** An empty catalog database with a tenant-scoped runtime handle. */
export async function createCatalogTestDatabase(): Promise<CatalogTestDatabase> {
	const provider = await catalogTestProvider();
	const lease = await provider.acquire({
		namespace: 'catalog.core',
		purpose: 'test',
	});
	return {
		provider,
		runtime: lease.database,
		repository: new DatabaseCatalogRepository(lease.database),
		dispose: () => lease.release(),
	};
}

export async function closeCatalogTestDatabases(): Promise<void> {
	const provider = shared;
	shared = undefined;
	if (provider) await (await provider).dispose();
}
