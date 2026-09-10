import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { AuthService } from '../src/services/auth-service.ts';
import {
	closeAuthTestDatabases,
	createAuthTestDatabase,
	type AuthTestDatabase,
} from './support/database.ts';

const fastHash = {
	cost: 2 ** 12,
	blockSize: 8,
	parallelization: 1,
	keyLength: 32,
	maxMemory: 32 * 1024 * 1024,
} as const;

const open = new Set<AuthTestDatabase>();

afterEach(async () => {
	await Promise.all([...open].map((database) => database.dispose()));
	open.clear();
});

afterAll(closeAuthTestDatabases);

/* Every case here runs against an embedded PostgreSQL, whose first boot alone
   outlasts the default per-test timeout. */

async function ownerService(now: () => number = () => 1_000) {
	const database = await createAuthTestDatabase();
	open.add(database);
	const service = new AuthService(database.repository, {
		passwordHash: fastHash,
		now,
	});
	const issued = await service.signUp({
		email: 'owner@example.com',
		password: 'correct horse battery staple',
		displayName: 'Ada Owner',
		organizationName: 'Example Operations',
		organizationSlug: 'example-operations',
	});
	return { service, principal: issued.principal };
}

describe('API tokens', () => {
	it('returns the raw token once and stores only safe metadata', async () => {
		const { service, principal } = await ownerService();
		const issued = await service.issueApiToken({
			tenantId: principal.tenantId,
			accountId: principal.accountId,
			label: 'Local sandbox',
			scopes: ['parties.records.read', 'sandbox.access.use'],
			expiresAt: null,
			createdBy: principal.accountId,
		});
		expect(issued.token.startsWith('clat_')).toBe(true);
		expect(issued.record.prefix.length).toBeLessThan(issued.token.length);
		expect(
			JSON.stringify(await service.listApiTokens(principal.tenantId)),
		).not.toContain(issued.token);
	});

	it('narrows requested scopes to the live membership', async () => {
		const { service, principal } = await ownerService();
		const issued = await service.issueApiToken({
			tenantId: principal.tenantId,
			accountId: principal.accountId,
			label: 'Narrowed',
			scopes: ['parties.records.read', 'not.a.granted.scope'],
			expiresAt: null,
			createdBy: principal.accountId,
		});
		expect(issued.record.scopes).toEqual(['parties.records.read']);
	});

	it('refuses a token that carries no held scope', async () => {
		const { service, principal } = await ownerService();
		await expect(
			service.issueApiToken({
				tenantId: principal.tenantId,
				accountId: principal.accountId,
				label: 'Empty',
				scopes: ['not.a.granted.scope'],
				expiresAt: null,
				createdBy: principal.accountId,
			}),
		).rejects.toThrow(/None of the requested scopes/);
	});

	it('resolves a principal for a live token and denies revoked or expired ones', async () => {
		let now = 1_000;
		const { service, principal } = await ownerService(() => now);
		const issued = await service.issueApiToken({
			tenantId: principal.tenantId,
			accountId: principal.accountId,
			label: 'Bridge',
			scopes: ['parties.records.read'],
			expiresAt: now + 60_000,
			createdBy: principal.accountId,
		});
		const resolved = await service.resolveApiToken(issued.token);
		expect(resolved?.accountId).toBe(principal.accountId);
		expect(resolved?.scopes).toEqual(['parties.records.read']);

		now += 60_001;
		expect(await service.resolveApiToken(issued.token)).toBeNull();

		now = 1_000;
		await service.revokeApiToken(
			principal.tenantId,
			issued.record.id,
			principal.accountId,
		);
		expect(await service.resolveApiToken(issued.token)).toBeNull();
	});

	it('rejects malformed credentials without a database lookup', async () => {
		const { service } = await ownerService();
		expect(await service.resolveApiToken(null)).toBeNull();
		expect(await service.resolveApiToken('not-a-token')).toBeNull();
		expect(await service.resolveApiToken('clat_short')).toBeNull();
	});

	it('keeps tokens scoped to their workspace', async () => {
		const { service, principal } = await ownerService();
		const issued = await service.issueApiToken({
			tenantId: principal.tenantId,
			accountId: principal.accountId,
			label: 'Scoped',
			scopes: ['parties.records.read'],
			expiresAt: null,
			createdBy: principal.accountId,
		});
		expect(await service.listApiTokens('another-tenant')).toHaveLength(0);
		await expect(
			service.revokeApiToken(
				'another-tenant',
				issued.record.id,
				principal.accountId,
			),
		).rejects.toThrow(/does not exist/);
	});
});

describe('self-service password change', () => {
	it('replaces the credential and revokes every other session', async () => {
		const { service, principal } = await ownerService();
		const second = await service.signIn({
			email: 'owner@example.com',
			password: 'correct horse battery staple',
		});
		await service.changePassword({
			accountId: principal.accountId,
			currentPassword: 'correct horse battery staple',
			newPassword: 'another correct horse battery',
			keepSessionToken: second.token,
		});
		expect(await service.resolveSession(second.token)).not.toBeNull();
		await expect(
			service.signIn({
				email: 'owner@example.com',
				password: 'correct horse battery staple',
			}),
		).rejects.toThrow(/incorrect/);
		await expect(
			service.signIn({
				email: 'owner@example.com',
				password: 'another correct horse battery',
			}),
		).resolves.toBeDefined();
	});

	it('rejects a wrong current password, a weak new one, and no change', async () => {
		const { service, principal } = await ownerService();
		await expect(
			service.changePassword({
				accountId: principal.accountId,
				currentPassword: 'wrong password value',
				newPassword: 'another correct horse battery',
			}),
		).rejects.toThrow(/current password is incorrect/);
		await expect(
			service.changePassword({
				accountId: principal.accountId,
				currentPassword: 'correct horse battery staple',
				newPassword: 'short',
			}),
		).rejects.toThrow(/at least 12 characters/);
		await expect(
			service.changePassword({
				accountId: principal.accountId,
				currentPassword: 'correct horse battery staple',
				newPassword: 'correct horse battery staple',
			}),
		).rejects.toThrow(/must differ/);
	});
});
