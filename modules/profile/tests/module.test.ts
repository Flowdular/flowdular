import { describe, expect, it } from 'vitest';
import { PROFILE_PERMISSIONS } from '../src/acl/permissions.ts';
import { assertSelfOnlyProfileTarget } from '../src/api/endpoints.ts';
import { moduleDefinition } from '../src/index.ts';
import {
	ProfileService,
	ProfileServiceError,
} from '../src/services/profile-service.ts';
import { SqliteProfileRepository } from '../src/services/sqlite-repository.ts';

describe('profile.core', () => {
	it('exports its validated identity', () => {
		expect(moduleDefinition.manifest.id).toBe('profile.core');
		expect(moduleDefinition.permissions).toEqual([
			PROFILE_PERMISSIONS.manageSelf,
		]);
	});

	it('trims and stores display names from 2 to 120 characters', () => {
		const service = new ProfileService(new SqliteProfileRepository(':memory:'));
		expect(
			service.update('tenant-a', 'account-a', {
				displayName: '  Ada Lovelace  ',
			}).displayName,
		).toBe('Ada Lovelace');
		expect(
			service.update('tenant-a', 'account-b', { displayName: 'AB' })
				.displayName,
		).toBe('AB');
		expect(
			service.update('tenant-a', 'account-c', {
				displayName: 'A'.repeat(120),
			}).displayName,
		).toHaveLength(120);
	});

	it('rejects display names shorter than 2 characters after trimming', () => {
		const service = new ProfileService(new SqliteProfileRepository(':memory:'));
		expect(() =>
			service.update('tenant-a', 'account-a', { displayName: ' A ' }),
		).toThrowError(ProfileServiceError);
	});

	it('rejects display names longer than 120 characters after trimming', () => {
		const service = new ProfileService(new SqliteProfileRepository(':memory:'));
		expect(() =>
			service.update('tenant-a', 'account-a', {
				displayName: 'A'.repeat(121),
			}),
		).toThrowError(/between 2 and 120/);
	});

	it('rejects control characters in display names', () => {
		const service = new ProfileService(new SqliteProfileRepository(':memory:'));
		expect(() =>
			service.update('tenant-a', 'account-a', {
				displayName: 'Ada\nLovelace',
			}),
		).toThrowError(/control characters/);
		expect(() =>
			service.update('tenant-a', 'account-a', {
				displayName: '\nAda Lovelace',
			}),
		).toThrowError(/control characters/);
	});

	it('rejects malformed tenant and account identifiers', () => {
		const service = new ProfileService(new SqliteProfileRepository(':memory:'));
		expect(() => service.read('tenant with spaces', 'account-a')).toThrowError(
			/valid identifier/,
		);
		expect(() => service.read('tenant-a', '')).toThrowError(/valid identifier/);
		expect(() => service.read('tenant-a', 'a'.repeat(129))).toThrowError(
			/valid identifier/,
		);
	});

	it('keeps one display-name record per account and tenant', () => {
		const service = new ProfileService(new SqliteProfileRepository(':memory:'));
		service.update('tenant-a', 'account-a', { displayName: 'First Name' });
		service.update('tenant-a', 'account-a', { displayName: 'Second Name' });
		expect(service.read('tenant-a', 'account-a')?.displayName).toBe(
			'Second Name',
		);
		expect(service.read('tenant-a', 'account-b')).toBeNull();
	});

	it('isolates the same account identifier between tenants', () => {
		const service = new ProfileService(new SqliteProfileRepository(':memory:'));
		service.update('tenant-a', 'account-a', { displayName: 'Tenant Alpha' });
		service.update('tenant-b', 'account-a', { displayName: 'Tenant Beta' });
		expect(service.read('tenant-a', 'account-a')?.displayName).toBe(
			'Tenant Alpha',
		);
		expect(service.read('tenant-b', 'account-a')?.displayName).toBe(
			'Tenant Beta',
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
