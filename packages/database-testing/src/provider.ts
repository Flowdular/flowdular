import { DatabaseError, type DatabaseProvider } from '@flowdular/database';
import { createPgliteTestProvider } from './pglite.ts';
import { createPostgresTestProvider } from './postgres.ts';

/** One test suite, two engines. Server mode never silently falls back to PGlite. */
export function createTestDatabaseProvider(
	environment: NodeJS.ProcessEnv = process.env,
): DatabaseProvider {
	const adapter = environment.FD_TEST_DATABASE_ADAPTER ?? 'pglite';
	if (adapter === 'pglite') return createPgliteTestProvider();
	if (adapter !== 'postgresql')
		throw new Error(`Unknown test database adapter: ${adapter}`);
	const required = (key: string): string => {
		const value = environment[key]?.trim();
		if (!value) throw new Error(`${key} is required for PostgreSQL tests.`);
		return value;
	};
	const options = {
		migratorUrl: required('FD_TEST_POSTGRES_URL'),
		runtimeUrl: required('FD_TEST_POSTGRES_RUNTIME_URL'),
		backgroundUrl: required('FD_TEST_POSTGRES_BACKGROUND_URL'),
	};
	let pending: Promise<DatabaseProvider> | undefined;
	let disposed = false;
	let closing: Promise<void> | undefined;
	return {
		async acquire(request) {
			if (disposed)
				throw new DatabaseError(
					'ADAPTER_DISPOSED',
					'The test provider is disposed.',
				);
			pending ??= createPostgresTestProvider(options);
			return (await pending).acquire(request);
		},
		dispose() {
			disposed = true;
			closing ??=
				pending?.then((provider) => provider.dispose()) ?? Promise.resolve();
			return closing;
		},
	};
}
