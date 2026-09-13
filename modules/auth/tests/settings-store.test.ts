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
	const settings = createModuleSettingsRuntime(
		createAuthSettingsStore(() => Promise.resolve(database.repository)),
	);
	settings.declare(createAuthModuleSettings({ allowSignUp: true }));
	return settings;
}

describe('auth module settings store', () => {
	it('stores a platform setting under a tenant a workspace cannot claim', async () => {
		const database = await fixture();
		const settings = runtimeOver(database);

		await settings.set('', 'auth.core', 'allowSignUp', false, 'account-a');

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
		await first.set('', 'auth.core', 'allowSignUp', false, 'account-a');

		const second = runtimeOver(database);
		/* Nothing is loaded until the caller primes, which is why a read before
		   it fails rather than answering the declared default. */
		expect(() => second.get('', 'auth.core', 'allowSignUp')).toThrow(
			expect.objectContaining({ code: 'SETTINGS_NOT_PRIMED' }),
		);
		await second.prime('');

		expect(second.get('', 'auth.core', 'allowSignUp')).toBe(false);
	});

	it('writes a value to the database and clears it again', async () => {
		const database = await fixture();
		const settings = runtimeOver(database);
		await settings.prime('');

		await settings.set('', 'auth.core', 'allowSignUp', false, 'account-a');
		expect(settings.get('', 'auth.core', 'allowSignUp')).toBe(false);
		expect(
			await database.repository.loadSettings('', 'auth.core'),
		).toMatchObject({ allowSignUp: false });

		await settings.set('', 'auth.core', 'allowSignUp', null, 'account-a');
		expect(await database.repository.loadSettings('', 'auth.core')).toEqual({});
		expect(settings.get('', 'auth.core', 'allowSignUp')).toBe(true);
	});

	it('keeps a tenant setting inside its own workspace', async () => {
		const database = await fixture();
		const settings = runtimeOver(database);

		await settings.set(
			'tenant-a',
			'auth.core',
			'defaultLocale',
			'pl',
			'account-a',
		);

		expect(
			await database.repository.loadSettings('tenant-a', 'auth.core'),
		).toMatchObject({ defaultLocale: 'pl' });
		expect(
			await database.repository.loadSettings('tenant-b', 'auth.core'),
		).toEqual({});
	});

	it('reports a failed write to the caller that made it', async () => {
		const settings = createModuleSettingsRuntime(
			createAuthSettingsStore(() =>
				Promise.reject(new Error('database unavailable')),
			),
		);
		settings.declare(createAuthModuleSettings({ allowSignUp: true }));

		await expect(
			settings.set('', 'auth.core', 'allowSignUp', false, 'account-a'),
		).rejects.toThrow('database unavailable');
		expect(() => settings.get('', 'auth.core', 'allowSignUp')).toThrow(
			/not loaded/,
		);
	});
});
