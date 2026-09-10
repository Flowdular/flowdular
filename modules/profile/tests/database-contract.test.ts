import type {
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import { createPgliteTestProvider } from '@flowdular/database-testing';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createProfileRuntime } from '../src/server/runtime.ts';
import { ProfileService } from '../src/services/profile-service.ts';
import {
	closeProfileTestDatabases,
	createProfileTestDatabase,
	type ProfileTestDatabase,
} from './support/database.ts';

const databases = new Set<ProfileTestDatabase>();

afterEach(async () => {
	await Promise.all([...databases].map((database) => database.dispose()));
	databases.clear();
});

afterAll(closeProfileTestDatabases);

async function profileFixture(): Promise<ProfileTestDatabase> {
	const database = await createProfileTestDatabase();
	databases.add(database);
	return database;
}

describe('profile database repository contract', () => {
	it('runs the profile and language contract on the PostgreSQL adapter', async () => {
		const service = new ProfileService((await profileFixture()).repository);

		await service.update('tenant-a', 'account-1', { displayName: 'Ada A' });
		await service.update('tenant-b', 'account-1', { displayName: 'Ada B' });
		await service.updateLanguage('tenant-a', 'account-1', { locale: 'pl' });
		await service.updateLanguage('tenant-b', 'account-1', { locale: 'en' });

		expect(await service.read('tenant-a', 'account-1')).toMatchObject({
			tenantId: 'tenant-a',
			accountId: 'account-1',
			displayName: 'Ada A',
		});
		expect(await service.read('tenant-b', 'account-1')).toMatchObject({
			tenantId: 'tenant-b',
			accountId: 'account-1',
			displayName: 'Ada B',
		});
		await expect(service.readLanguage('tenant-a', 'account-1')).resolves.toBe(
			'pl',
		);
		await expect(service.readLanguage('tenant-b', 'account-1')).resolves.toBe(
			'en',
		);
	});

	it('normalizes the BIGINT timestamp PostgreSQL returns as a string', async () => {
		const service = new ProfileService((await profileFixture()).repository);
		const saved = await service.update('tenant-a', 'account-1', {
			displayName: 'Ada',
		});

		const read = await service.read('tenant-a', 'account-1');
		expect(read?.updatedAt).toBe(saved.updatedAt);
		expect(typeof read?.updatedAt).toBe('number');
	});

	it('keeps updates tenant-scoped when account ids match', async () => {
		const service = new ProfileService((await profileFixture()).repository);
		await service.update('tenant-a', 'shared-account', {
			displayName: 'Tenant A',
		});
		await service.update('tenant-b', 'shared-account', {
			displayName: 'Tenant B',
		});
		await service.update('tenant-a', 'shared-account', {
			displayName: 'Tenant A updated',
		});

		expect(
			(await service.read('tenant-a', 'shared-account'))?.displayName,
		).toBe('Tenant A updated');
		expect(
			(await service.read('tenant-b', 'shared-account'))?.displayName,
		).toBe('Tenant B');
	});

	it('refuses a write that forced row security assigns to another tenant', async () => {
		const database = await profileFixture();

		await expect(
			database.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO profile_records
							 (tenant_id, account_id, display_name, updated_at)
							 VALUES ($1, $2, $3, $4)`,
						parameters: ['tenant-b', 'rls-probe', 'Blocked', Date.now()],
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			),
		).rejects.toBeDefined();
	});

	it('refuses any runtime statement without a tenant context', async () => {
		const database = await profileFixture();

		await expect(
			database.runtime.transaction(async () => undefined, { access: 'read' }),
		).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
	});

	it('uses separate migration and runtime leases and releases the runtime lease', async () => {
		const embedded = createPgliteTestProvider();
		const requests: DatabaseProviderRequest[] = [];
		let releases = 0;
		const provider: DatabaseProvider = {
			async acquire(request) {
				requests.push(request);
				const lease = await embedded.acquire(request);
				let released = false;
				return {
					database: lease.database,
					async release() {
						if (released) return;
						released = true;
						releases += 1;
						await lease.release();
					},
				};
			},
			dispose: () => embedded.dispose(),
		};
		const runtime = createProfileRuntime({
			databases: provider,
			purpose: 'test',
		});

		try {
			const service = await runtime.service();
			await service.update('tenant-a', 'account-a', { displayName: 'Ada' });
			await runtime.dispose();

			expect(requests.map((request) => request.purpose)).toEqual([
				'migration',
				'test',
			]);
			expect(releases).toBe(2);
			await expect(runtime.service()).rejects.toThrow('disposed');
		} finally {
			await provider.dispose();
		}
	});
});
