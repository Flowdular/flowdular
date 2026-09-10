import type { DatabaseHandle, DatabaseProvider } from '@flowdular/database';
import { createTestDatabaseProvider } from '@flowdular/database-testing';
import {
	DatabaseProfileRepository,
	migrateProfileDatabase,
} from '../../src/services/database-repository.ts';

const TENANT_TABLES = ['profile_records', 'profile_language_preferences'];

export interface ProfileTestDatabase {
	readonly provider: DatabaseProvider;
	readonly runtime: DatabaseHandle;
	readonly repository: DatabaseProfileRepository;
	dispose(): Promise<void>;
}

/* Booting an embedded PostgreSQL costs about two seconds, so a test file shares
   one migrated cluster and every fixture starts from truncated tables instead.
   Call closeProfileTestDatabases() from the file's afterAll. */
let shared: Promise<DatabaseProvider> | undefined;

/** The file's migrated provider, with every profile table emptied. */
export async function profileTestProvider(): Promise<DatabaseProvider> {
	shared ??= (async () => {
		const provider = createTestDatabaseProvider();
		const lease = await provider.acquire({
			namespace: 'profile.core',
			purpose: 'migration',
		});
		try {
			await migrateProfileDatabase(lease.database);
		} finally {
			await lease.release();
		}
		return provider;
	})();
	const provider = await shared;
	const migration = await provider.acquire({
		namespace: 'profile.core',
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

/** An empty profile database with a tenant-scoped runtime handle. */
export async function createProfileTestDatabase(): Promise<ProfileTestDatabase> {
	const provider = await profileTestProvider();
	const lease = await provider.acquire({
		namespace: 'profile.core',
		purpose: 'test',
	});
	return {
		provider,
		runtime: lease.database,
		repository: new DatabaseProfileRepository(lease.database),
		dispose: () => lease.release(),
	};
}

export async function closeProfileTestDatabases(): Promise<void> {
	const provider = shared;
	shared = undefined;
	if (provider) await (await provider).dispose();
}
