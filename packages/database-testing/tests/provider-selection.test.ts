import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@flowdular/database';
import { createTestDatabaseProvider } from '../src/provider.ts';
import { createPostgresTestProvider } from '../src/postgres.ts';
import { createPgliteTestProvider } from '../src/pglite.ts';

vi.mock('../src/pglite.ts', () => ({ createPgliteTestProvider: vi.fn() }));
vi.mock('../src/postgres.ts', () => ({ createPostgresTestProvider: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const environment = {
	FD_TEST_DATABASE_ADAPTER: 'postgresql',
	FD_TEST_POSTGRES_URL: 'postgres://migrator@localhost/test',
	FD_TEST_POSTGRES_RUNTIME_URL: 'postgres://runtime@localhost/test',
	FD_TEST_POSTGRES_BACKGROUND_URL: 'postgres://background@localhost/test',
};

describe('test provider selection', () => {
	it('defaults to the embedded engine', () => {
		createTestDatabaseProvider({});
		expect(createPgliteTestProvider).toHaveBeenCalledOnce();
		expect(createPostgresTestProvider).not.toHaveBeenCalled();
	});
	it('refuses incomplete server configuration and unknown adapters', () => {
		for (const key of [
			'FD_TEST_POSTGRES_URL',
			'FD_TEST_POSTGRES_RUNTIME_URL',
			'FD_TEST_POSTGRES_BACKGROUND_URL',
		]) {
			expect(() =>
				createTestDatabaseProvider({ ...environment, [key]: '' }),
			).toThrow(key);
		}
		expect(() =>
			createTestDatabaseProvider({ FD_TEST_DATABASE_ADAPTER: 'typo' }),
		).toThrow('Unknown');
		expect(createPgliteTestProvider).not.toHaveBeenCalled();
	});
	it('shares a lazy server provider, awaits cleanup once, and refuses use after disposal', async () => {
		const backing = {
			acquire: vi.fn().mockResolvedValue({}),
			dispose: vi.fn().mockResolvedValue(undefined),
		} as unknown as DatabaseProvider;
		vi.mocked(createPostgresTestProvider).mockResolvedValue(backing);
		const provider = createTestDatabaseProvider(environment);
		expect(createPostgresTestProvider).not.toHaveBeenCalled();
		await Promise.all([
			provider.acquire({ namespace: 'demo.core', purpose: 'test' }),
			provider.acquire({ namespace: 'demo.core', purpose: 'test' }),
		]);
		expect(createPostgresTestProvider).toHaveBeenCalledExactlyOnceWith({
			migratorUrl: environment.FD_TEST_POSTGRES_URL,
			runtimeUrl: environment.FD_TEST_POSTGRES_RUNTIME_URL,
			backgroundUrl: environment.FD_TEST_POSTGRES_BACKGROUND_URL,
		});
		await Promise.all([provider.dispose(), provider.dispose()]);
		expect(backing.dispose).toHaveBeenCalledOnce();
		await expect(
			provider.acquire({ namespace: 'demo.core', purpose: 'test' }),
		).rejects.toMatchObject({ code: 'ADAPTER_DISPOSED' });
	});
	it('never falls back to the embedded engine after server failure', async () => {
		vi.mocked(createPostgresTestProvider).mockRejectedValue(
			new Error('unavailable'),
		);
		const provider = createTestDatabaseProvider(environment);
		await expect(
			provider.acquire({ namespace: 'demo.core', purpose: 'test' }),
		).rejects.toThrow('unavailable');
		await expect(provider.dispose()).rejects.toThrow('unavailable');
		expect(createPgliteTestProvider).not.toHaveBeenCalled();
	});
});
