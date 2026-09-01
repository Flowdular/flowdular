import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { OWNER_SCOPES } from '../src/acl/scopes.ts';
import { AuthService } from '../src/services/auth-service.ts';
import { SqliteAuthRepository } from '../src/services/sqlite-repository.ts';

const fastHash = {
	cost: 2 ** 12,
	blockSize: 8,
	parallelization: 1,
	keyLength: 32,
	maxMemory: 32 * 1024 * 1024,
} as const;

describe('AuthService', () => {
	it('creates a tenant owner and resolves only the issued session', async () => {
		const repository = new SqliteAuthRepository(':memory:');
		const service = new AuthService(repository, {
			passwordHash: fastHash,
			now: () => 1_000,
		});
		const issued = await service.signUp({
			email: 'Owner@Example.com',
			password: 'correct horse battery staple',
			displayName: 'Ada Owner',
			organizationName: 'Example Operations',
			organizationSlug: 'example-operations',
		});
		expect(issued.principal.email).toBe('owner@example.com');
		expect(issued.principal.scopes).toContain('system.workspace.access');
		expect(service.resolveSession(issued.token)?.principal.accountId).toBe(
			issued.principal.accountId,
		);
		expect(service.resolveSession('not-a-session')).toBeNull();
		const secondTenantId = randomUUID();
		repository.createTenantMembership({
			accountId: issued.principal.accountId,
			tenantId: secondTenantId,
			organizationName: 'Second Workspace',
			organizationSlug: 'second-workspace',
			role: 'owner',
			scopes: OWNER_SCOPES,
			createdAt: 1_001,
		});
		const switched = await service.switchTenant(issued.token, secondTenantId);
		expect(switched.principal.tenantId).toBe(secondTenantId);
		expect(switched.principal.tenants).toHaveLength(2);
		expect(service.resolveSession(issued.token)).toBeNull();
	});

	it('rejects a taken workspace slug and reports availability', async () => {
		const service = new AuthService(new SqliteAuthRepository(':memory:'), {
			passwordHash: fastHash,
		});
		await service.signUp({
			email: 'first@example.com',
			password: 'correct horse battery staple',
			displayName: 'First Owner',
			organizationName: 'First Workspace',
			organizationSlug: 'shared-slug',
		});
		expect(service.checkWorkspaceSlug('shared-slug')).toMatchObject({
			valid: true,
			available: false,
		});
		expect(service.checkWorkspaceSlug('open-slug')).toMatchObject({
			valid: true,
			available: true,
		});
		expect(service.checkWorkspaceSlug('X')).toMatchObject({ valid: false });
		await expect(
			service.signUp({
				email: 'second@example.com',
				password: 'correct horse battery staple',
				displayName: 'Second Owner',
				organizationName: 'Second Workspace',
				organizationSlug: 'shared-slug',
			}),
		).rejects.toMatchObject({ code: 'WORKSPACE_SLUG_TAKEN', status: 409 });
	});

	it('uses a generic error for incorrect credentials', async () => {
		const service = new AuthService(new SqliteAuthRepository(':memory:'), {
			passwordHash: fastHash,
		});
		await expect(
			service.signIn({
				email: 'missing@example.com',
				password: 'incorrect password',
			}),
		).rejects.toMatchObject({
			code: 'INVALID_CREDENTIALS',
			status: 401,
		});
	});
});
