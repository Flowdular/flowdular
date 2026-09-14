import {
	runDatabaseMigrations,
	type DatabaseMigration,
} from '@flowdular/database';
import { describe, expect, it } from 'vitest';
import { createPostgresTestProvider } from '../src/postgres.ts';

const migratorUrl = process.env.FD_TEST_POSTGRES_URL?.trim();

function migrationsFor(namespace: string): readonly DatabaseMigration[] {
	const table = namespace.replace(/[^a-z0-9]/g, '_');
	return [
		{
			id: `0001_${table}`,
			sql: {
				postgresql: `CREATE TABLE IF NOT EXISTS ${table}_a (id TEXT PRIMARY KEY);\n`,
			},
		},
		{
			id: `0002_${table}`,
			sql: {
				postgresql: `CREATE TABLE IF NOT EXISTS ${table}_b (id TEXT PRIMARY KEY);\n`,
			},
		},
	];
}

/* A production boot migrates every module at once, each under its own
   serializable transaction against the one ledger table. */
describe.skipIf(!migratorUrl)('PostgreSQL concurrent boot migrations', () => {
	it('migrates several modules at the same time without a serialization failure', async () => {
		const provider = await createPostgresTestProvider({
			migratorUrl: migratorUrl!,
			runtimeUrl: process.env.FD_TEST_POSTGRES_RUNTIME_URL?.trim() || undefined,
		});
		try {
			const namespaces = [
				'boot-a.core',
				'boot-b.core',
				'boot-c.core',
				'boot-d.core',
				'boot-e.core',
				'boot-f.core',
			];
			for (let round = 0; round < 3; round += 1) {
				const results = await Promise.all(
					namespaces.map(async (namespace) => {
						const lease = await provider.acquire({
							namespace,
							purpose: 'migration',
						});
						try {
							return await runDatabaseMigrations(
								lease.database,
								namespace,
								migrationsFor(namespace),
							);
						} finally {
							await lease.release();
						}
					}),
				);
				for (const entries of results) {
					expect(entries.map((entry) => entry.action)).toEqual(
						round === 0 ? ['applied', 'applied'] : ['unchanged', 'unchanged'],
					);
				}
			}
		} finally {
			await provider.dispose();
		}
	});
});
