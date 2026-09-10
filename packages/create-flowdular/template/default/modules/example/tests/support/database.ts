import type { DatabaseHandle, DatabaseProvider } from '@flowdular/sdk/database';
import { createPgliteTestProvider } from '@flowdular/sdk/database-testing';
import {
	DatabaseNoteRepository,
	migrateExampleDatabase,
} from '../../src/services/database-repository.ts';

export interface ExampleTestDatabase {
	readonly provider: DatabaseProvider;
	readonly runtime: DatabaseHandle;
	readonly repository: DatabaseNoteRepository;
	dispose(): Promise<void>;
}

/* Booting an embedded PostgreSQL costs about two seconds, so a test file shares
   one migrated cluster and every fixture starts from truncated tables instead.
   Call closeExampleTestDatabases() from the file's afterAll. */
let shared: Promise<DatabaseProvider> | undefined;

/** The file's migrated provider, with every example table emptied. */
export async function exampleTestProvider(): Promise<DatabaseProvider> {
	shared ??= (async () => {
		const provider = createPgliteTestProvider();
		const lease = await provider.acquire({
			namespace: 'example.core',
			purpose: 'migration',
		});
		try {
			await migrateExampleDatabase(lease.database);
		} finally {
			await lease.release();
		}
		return provider;
	})();
	const provider = await shared;
	const migration = await provider.acquire({
		namespace: 'example.core',
		purpose: 'migration',
	});
	try {
		await migration.database.execute({
			text: 'TRUNCATE example_notes RESTART IDENTITY CASCADE',
		});
	} finally {
		await migration.release();
	}
	return provider;
}

/** An empty example database with a tenant-scoped runtime handle. */
export async function createExampleTestDatabase(): Promise<ExampleTestDatabase> {
	const provider = await exampleTestProvider();
	const lease = await provider.acquire({
		namespace: 'example.core',
		purpose: 'test',
	});
	return {
		provider,
		runtime: lease.database,
		repository: new DatabaseNoteRepository(lease.database),
		dispose: () => lease.release(),
	};
}

export async function closeExampleTestDatabases(): Promise<void> {
	const provider = shared;
	shared = undefined;
	if (provider) await (await provider).dispose();
}
