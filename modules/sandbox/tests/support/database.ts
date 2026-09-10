import type { DatabaseHandle, DatabaseProvider } from '@flowdular/database';
import { createTestDatabaseProvider } from '@flowdular/database-testing';
import {
	DatabaseSandboxRepository,
	migrateSandboxDatabase,
} from '../../src/services/database-repository.ts';

const TENANT_TABLES = [
	'sandbox_access_grants',
	'sandbox_sessions',
	'sandbox_audit_events',
];

export interface SandboxTestDatabase {
	readonly provider: DatabaseProvider;
	readonly runtime: DatabaseHandle;
	readonly repository: DatabaseSandboxRepository;
	dispose(): Promise<void>;
}

/* Booting an embedded PostgreSQL costs about two seconds, so a test file shares
   one migrated cluster and every fixture starts from truncated tables instead.
   Call closeSandboxTestDatabases() from the file's afterAll. */
let shared: Promise<DatabaseProvider> | undefined;

/** The file's migrated provider, with every sandbox table emptied. */
export async function sandboxTestProvider(): Promise<DatabaseProvider> {
	shared ??= (async () => {
		const provider = createTestDatabaseProvider();
		const lease = await provider.acquire({
			namespace: 'sandbox.core',
			purpose: 'migration',
		});
		try {
			await migrateSandboxDatabase(lease.database);
		} finally {
			await lease.release();
		}
		return provider;
	})();
	const provider = await shared;
	const migration = await provider.acquire({
		namespace: 'sandbox.core',
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

/** An empty sandbox database with a tenant-scoped runtime handle. */
export async function createSandboxTestDatabase(): Promise<SandboxTestDatabase> {
	const provider = await sandboxTestProvider();
	const lease = await provider.acquire({
		namespace: 'sandbox.core',
		purpose: 'test',
	});
	return {
		provider,
		runtime: lease.database,
		repository: new DatabaseSandboxRepository(lease.database),
		dispose: () => lease.release(),
	};
}

export async function closeSandboxTestDatabases(): Promise<void> {
	const provider = shared;
	shared = undefined;
	if (provider) await (await provider).dispose();
}
