import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { PROFILE_PERMISSIONS } from '../src/acl/permissions.ts';
import { assertSelfOnlyProfileTarget } from '../src/api/endpoints.ts';
import { moduleDefinition } from '../src/index.ts';
import {
	ProfileService,
	ProfileServiceError,
} from '../src/services/profile-service.ts';
import {
	closeProfileTestDatabases,
	createProfileTestDatabase,
	type ProfileTestDatabase,
} from './support/database.ts';

const databases = new Set<ProfileTestDatabase>();

async function profileService(): Promise<ProfileService> {
	const database = await createProfileTestDatabase();
	databases.add(database);
	return new ProfileService(database.repository);
}

afterEach(async () => {
	await Promise.all([...databases].map((database) => database.dispose()));
	databases.clear();
});

afterAll(closeProfileTestDatabases);

describe('profile.core', () => {
	it('exports its validated identity', () => {
		expect(moduleDefinition.manifest.id).toBe('profile.core');
		expect(moduleDefinition.permissions).toEqual([
			PROFILE_PERMISSIONS.manageSelf,
		]);
	});

	it('trims and stores display names from 2 to 120 characters', async () => {
		const service = await profileService();
		expect(
			(
				await service.update('tenant-a', 'account-a', {
					displayName: '  Ada Lovelace  ',
				})
			).displayName,
		).toBe('Ada Lovelace');
		expect(
			(await service.update('tenant-a', 'account-b', { displayName: 'AB' }))
				.displayName,
		).toBe('AB');
		expect(
			(
				await service.update('tenant-a', 'account-c', {
					displayName: 'A'.repeat(120),
				})
			).displayName,
		).toHaveLength(120);
	});

	it('rejects display names shorter than 2 characters after trimming', async () => {
		const service = await profileService();
		await expect(
			service.update('tenant-a', 'account-a', { displayName: ' A ' }),
		).rejects.toThrowError(ProfileServiceError);
	});

	it('rejects display names longer than 120 characters after trimming', async () => {
		const service = await profileService();
		await expect(
			service.update('tenant-a', 'account-a', {
				displayName: 'A'.repeat(121),
			}),
		).rejects.toThrowError(/between 2 and 120/);
	});

	it('rejects control characters in display names', async () => {
		const service = await profileService();
		await expect(
			service.update('tenant-a', 'account-a', {
				displayName: 'Ada\nLovelace',
			}),
		).rejects.toThrowError(/control characters/);
		await expect(
			service.update('tenant-a', 'account-a', {
				displayName: '\nAda Lovelace',
			}),
		).rejects.toThrowError(/control characters/);
	});

	it('rejects malformed tenant and account identifiers', async () => {
		const service = await profileService();
		await expect(
			service.read('tenant with spaces', 'account-a'),
		).rejects.toThrowError(/valid identifier/);
		await expect(service.read('tenant-a', '')).rejects.toThrowError(
			/valid identifier/,
		);
		await expect(
			service.read('tenant-a', 'a'.repeat(129)),
		).rejects.toThrowError(/valid identifier/);
	});

	it('keeps one display-name record per account and tenant', async () => {
		const service = await profileService();
		await service.update('tenant-a', 'account-a', {
			displayName: 'First Name',
		});
		await service.update('tenant-a', 'account-a', {
			displayName: 'Second Name',
		});
		expect((await service.read('tenant-a', 'account-a'))?.displayName).toBe(
			'Second Name',
		);
		await expect(service.read('tenant-a', 'account-b')).resolves.toBeNull();
	});

	it('isolates the same account identifier between tenants', async () => {
		const service = await profileService();
		await service.update('tenant-a', 'account-a', {
			displayName: 'Tenant Alpha',
		});
		await service.update('tenant-b', 'account-a', {
			displayName: 'Tenant Beta',
		});
		expect((await service.read('tenant-a', 'account-a'))?.displayName).toBe(
			'Tenant Alpha',
		);
		expect((await service.read('tenant-b', 'account-a'))?.displayName).toBe(
			'Tenant Beta',
		);
	});

	it('stores supported language preferences per account and tenant', async () => {
		const service = await profileService();
		await service.updateLanguage('tenant-a', 'account-a', { locale: 'PL' });
		await service.updateLanguage('tenant-b', 'account-a', { locale: 'en' });
		await expect(service.readLanguage('tenant-a', 'account-a')).resolves.toBe(
			'pl',
		);
		await expect(service.readLanguage('tenant-b', 'account-a')).resolves.toBe(
			'en',
		);
		await expect(
			service.readLanguage('tenant-a', 'account-b'),
		).resolves.toBeNull();
	});

	it('rejects an unsupported language without changing the stored preference', async () => {
		const service = await profileService();
		await service.updateLanguage('tenant-a', 'account-a', { locale: 'pl' });
		await expect(
			service.updateLanguage('tenant-a', 'account-a', { locale: 'de' }),
		).rejects.toThrowError(/supported interface languages/);
		await expect(service.readLanguage('tenant-a', 'account-a')).resolves.toBe(
			'pl',
		);
	});

	it('denies request-supplied account and tenant targets', () => {
		expect(() =>
			assertSelfOnlyProfileTarget(
				new Request('http://localhost/api/profile?accountId=account-b'),
			),
		).toThrowError(/targeting is not allowed/);
		expect(() =>
			assertSelfOnlyProfileTarget(
				new Request('http://localhost/api/profile', { method: 'PUT' }),
				{ displayName: 'Allowed Name', tenantId: 'tenant-b' },
			),
		).toThrowError(/targeting is not allowed/);
		expect(() =>
			assertSelfOnlyProfileTarget(
				new Request('http://localhost/api/profile', { method: 'PUT' }),
				{ displayName: 'Allowed Name' },
			),
		).not.toThrow();
	});
});
