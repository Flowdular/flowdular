import { describe, expect, it } from 'vitest';
import {
	createPlatformDatabaseProvider,
	databaseProviderConfigFromEnvironment,
} from './database.ts';

/* The provider logic and its configuration rules live in @flowdular/database and
   are covered there. What only the deployable can prove is that it supplies the
   node-postgres pool the contract package deliberately does not own. */
describe('platform database binding', () => {
	it('leases the embedded PostgreSQL without any driver factory', async () => {
		const provider = createPlatformDatabaseProvider(
			databaseProviderConfigFromEnvironment({ NODE_ENV: 'test' }, '/workspace'),
		);
		const lease = await provider.acquire({
			namespace: 'profile.core',
			purpose: 'migration',
		});

		await expect(
			lease.database.query({ text: 'SELECT 1 AS ready' }),
		).resolves.toMatchObject({ rows: [{ ready: 1 }] });
		expect(provider.adapter).toBe('pglite');
		await lease.release();
		await provider.dispose();
	});

	it('builds the PostgreSQL pools from pg without an injected factory', async () => {
		const provider = createPlatformDatabaseProvider(
			databaseProviderConfigFromEnvironment(
				{
					NODE_ENV: 'production',
					FD_DATABASE_ADAPTER: 'postgresql',
					FD_DATABASE_URL: 'postgresql://runtime:secret@db.example/flowdular',
					FD_DATABASE_MIGRATOR_URL:
						'postgresql://migrator:other-secret@db.example/flowdular',
				},
				'/workspace',
			),
		);

		expect(provider.adapter).toBe('postgresql');
		await provider.dispose();
	});
});
