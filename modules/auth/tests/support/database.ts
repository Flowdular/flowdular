import type { DatabaseHandle, DatabaseProvider } from '@flowdular/database';
import { createTestDatabaseProvider } from '@flowdular/database-testing';
import {
	DatabaseAuthRepository,
	migrateAuthDatabase,
} from '../../src/services/database-repository.ts';

const TABLES = [
	'auth_tenants',
	'auth_accounts',
	'auth_memberships',
	'auth_membership_scopes',
	'auth_sessions',
	'auth_api_tokens',
	'auth_roles',
	'auth_audit',
	'auth_sign_in_failures',
	'auth_password_reset_tokens',
	'auth_tenant_invitations',
	'auth_mfa_totp',
	'auth_mfa_recovery_codes',
	'auth_mfa_challenges',
	'module_settings',
];

export interface AuthTestDatabase {
	readonly provider: DatabaseProvider;
	readonly runtime: DatabaseHandle;
	readonly background: DatabaseHandle;
	readonly repository: DatabaseAuthRepository;
	dispose(): Promise<void>;
}

/* Booting an embedded PostgreSQL costs about two seconds, so a test file shares
   one migrated cluster and every fixture starts from truncated tables instead.
   Call closeAuthTestDatabases() from the file's afterAll. */
let shared: Promise<DatabaseProvider> | undefined;

/** The file's migrated provider, with every auth.core table emptied. */
export async function authTestProvider(): Promise<DatabaseProvider> {
	shared ??= (async () => {
		const provider = createTestDatabaseProvider();
		const lease = await provider.acquire({
			namespace: 'auth.core',
			purpose: 'migration',
		});
		try {
			await migrateAuthDatabase(lease.database);
		} finally {
			await lease.release();
		}
		return provider;
	})();
	const provider = await shared;
	const migration = await provider.acquire({
		namespace: 'auth.core',
		purpose: 'migration',
	});
	try {
		await migration.database.execute({
			text: `TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`,
		});
	} finally {
		await migration.release();
	}
	return provider;
}

/** An empty auth database with the tenant-scoped and cross-tenant handles. */
export async function createAuthTestDatabase(): Promise<AuthTestDatabase> {
	const provider = await authTestProvider();
	const runtime = await provider.acquire({
		namespace: 'auth.core',
		purpose: 'test',
	});
	const background = await provider.acquire({
		namespace: 'auth.core',
		purpose: 'background',
	});
	return {
		provider,
		runtime: runtime.database,
		background: background.database,
		repository: new DatabaseAuthRepository({
			runtime: runtime.database,
			background: background.database,
		}),
		async dispose() {
			await background.release();
			await runtime.release();
		},
	};
}

export async function closeAuthTestDatabases(): Promise<void> {
	const provider = shared;
	shared = undefined;
	if (provider) await (await provider).dispose();
}
