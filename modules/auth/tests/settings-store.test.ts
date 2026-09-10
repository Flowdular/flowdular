import { createModuleSettingsRuntime } from '@flowdular/kernel';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createAuthSettingsStore } from '../src/services/settings-store.ts';
import { createAuthModuleSettings } from '../src/settings.ts';
import {
	closeAuthTestDatabases,
	createAuthTestDatabase,
	type AuthTestDatabase,
} from './support/database.ts';

const open = new Set<AuthTestDatabase>();

afterEach(async () => {
	await Promise.all([...open].map((database) => database.dispose()));
	open.clear();
});

afterAll(closeAuthTestDatabases);

async function fixture(): Promise<AuthTestDatabase> {
	const database = await createAuthTestDatabase();
	open.add(database);
	return database;
}

function runtimeOver(database: AuthTestDatabase) {
	const store = createAuthSettingsStore(() =>
		Promise.resolve(database.repository),
	);
	const settings = createModuleSettingsRuntime(store);
	settings.declare(createAuthModuleSettings({ allowSignUp: true }));
	return { store, settings };
}

describe('auth module settings store', () => {
	it('stores a platform setting under a tenant a workspace cannot claim', async () => {
		const database = await fixture();
		const { store, settings } = runtimeOver(database);

		settings.set('', 'auth.core', 'allowSignUp', false, 'account-a');
		await store.ready();

		const rows = await database.runtime.transaction(
			(transaction) =>
				transaction.query<{ tenant_id: string; value_json: string }>({
					text: 'SELECT tenant_id, value_json FROM module_settings WHERE key = $1',
					parameters: ['allowSignUp'],
				}),
			{ access: 'read', tenantId: 'auth.core:platform' },
		);
		expect(rows.rows).toEqual([
			{ tenant_id: 'auth.core:platform', value_json: 'false' },
		]);
	});

	it('serves a stored value to a runtime that started after it was written', async () => {
		const database = await fixture();
		const first = runtimeOver(database);
		first.settings.set('', 'auth.core', 'allowSignUp', false, 'account-a');
		await first.store.ready();

		const second = runtimeOver(database);
		/* The snapshot is empty until the read lands, which is why anything that
		   must not see the declared default primes it first. */
		await second.store.prime('', 'auth.core');

		expect(second.settings.get('', 'auth.core', 'allowSignUp')).toBe(false);
	});

	it('applies a write before it reaches the database and clears it again', async () => {
		const database = await fixture();
		const { store, settings } = runtimeOver(database);
		await store.prime('', 'auth.core');

		settings.set('', 'auth.core', 'allowSignUp', false, 'account-a');
		expect(settings.get('', 'auth.core', 'allowSignUp')).toBe(false);
		await store.ready();
		expect(
			await database.repository.loadSettings('', 'auth.core'),
		).toMatchObject({ allowSignUp: false });

		settings.set('', 'auth.core', 'allowSignUp', null, 'account-a');
		await store.ready();
		expect(await database.repository.loadSettings('', 'auth.core')).toEqual({});
		expect(settings.get('', 'auth.core', 'allowSignUp')).toBe(true);
	});

	it('keeps a tenant setting inside its own workspace', async () => {
		const database = await fixture();
		const { store, settings } = runtimeOver(database);

		settings.set('tenant-a', 'auth.core', 'defaultLocale', 'pl', 'account-a');
		await store.ready();

		expect(
			await database.repository.loadSettings('tenant-a', 'auth.core'),
		).toMatchObject({ defaultLocale: 'pl' });
		expect(
			await database.repository.loadSettings('tenant-b', 'auth.core'),
		).toEqual({});
	});

	it('reports a failed write through ready() instead of losing it silently', async () => {
		const database = await fixture();
		const store = createAuthSettingsStore(() =>
			Promise.reject(new Error('database unavailable')),
		);
		const settings = createModuleSettingsRuntime(store);
		settings.declare(createAuthModuleSettings({ allowSignUp: true }));

		settings.set('', 'auth.core', 'allowSignUp', false, 'account-a');

		await expect(store.ready()).rejects.toThrow('database unavailable');
		/* The snapshot still carries the value, and the next call starts clean. */
		expect(settings.get('', 'auth.core', 'allowSignUp')).toBe(false);
		await expect(store.ready()).resolves.toBeUndefined();
		expect(await database.repository.loadSettings('', 'auth.core')).toEqual({});
	});
});
