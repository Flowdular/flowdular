import { describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { OWNER_SCOPES } from '../src/acl/scopes.ts';
import { AuthService } from '../src/services/auth-service.ts';
import { SqliteAuthRepository } from '../src/services/sqlite-repository.ts';
import type { AuthMailDelivery } from '../src/services/mail-delivery.ts';

const fastHash = {
	cost: 2 ** 12,
	blockSize: 8,
	parallelization: 1,
	keyLength: 32,
	maxMemory: 32 * 1024 * 1024,
} as const;

function totp(secret: string, now: number): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = 0;
	let value = 0;
	const bytes: number[] = [];
	for (const character of secret) {
		value = (value << 5) | alphabet.indexOf(character);
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
	const digest = createHmac('sha1', Buffer.from(bytes))
		.update(counter)
		.digest();
	const offset = digest[digest.length - 1]! & 15;
	const integer =
		((digest[offset]! & 127) << 24) |
		(digest[offset + 1]! << 16) |
		(digest[offset + 2]! << 8) |
		digest[offset + 3]!;
	return String(integer % 1_000_000).padStart(6, '0');
}

class Mailbox implements AuthMailDelivery {
	readonly messages: {
		to: string;
		kind: 'password-reset' | 'tenant-invitation';
		url: string;
	}[] = [];
	async send(message: {
		to: string;
		kind: 'password-reset' | 'tenant-invitation';
		url: string;
	}): Promise<void> {
		this.messages.push(message);
	}
}

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

	it('resets passwords using a short-lived, single-use delivered token without disclosing account existence', async () => {
		let now = 1_000_000;
		const mailbox = new Mailbox();
		const service = new AuthService(new SqliteAuthRepository(':memory:'), {
			passwordHash: fastHash,
			now: () => now,
			mailDelivery: mailbox,
			publicBaseUrl: 'https://erp.example',
		});
		const owner = await service.signUp({
			email: 'owner@example.com',
			password: 'correct horse battery staple',
			displayName: 'Ada Owner',
			organizationName: 'Example Operations',
			organizationSlug: 'example-operations',
		});
		await service.requestPasswordReset('missing@example.com');
		expect(mailbox.messages).toHaveLength(0);
		await service.requestPasswordReset('owner@example.com');
		expect(new URL(mailbox.messages[0]!.url).pathname).toBe(
			'/auth/reset-password',
		);
		const token = new URL(mailbox.messages[0]!.url).searchParams.get('token')!;
		expect(
			JSON.stringify(
				service.queryAudit({
					tenantId: owner.principal.tenantId,
					limit: 100,
				}),
			),
		).not.toContain(token);
		await service.completePasswordReset(
			token,
			'new correct horse battery staple',
		);
		await expect(
			service.completePasswordReset(
				token,
				'another correct horse battery staple',
			),
		).rejects.toMatchObject({ code: 'RESET_TOKEN_INVALID' });
		await expect(
			service.signIn({
				email: 'owner@example.com',
				password: 'correct horse battery staple',
			}),
		).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
		await expect(
			service.signIn({
				email: 'owner@example.com',
				password: 'new correct horse battery staple',
			}),
		).resolves.toMatchObject({ principal: { email: 'owner@example.com' } });
		await service.requestPasswordReset('owner@example.com');
		now += 31 * 60 * 1000;
		const expired = new URL(mailbox.messages[1]!.url).searchParams.get(
			'token',
		)!;
		await expect(
			service.completePasswordReset(
				expired,
				'another correct horse battery staple',
			),
		).rejects.toMatchObject({ code: 'RESET_TOKEN_INVALID' });
	});

	it('requires an enrolled TOTP factor and consumes recovery codes only once', async () => {
		let now = 1_000_000;
		const service = new AuthService(new SqliteAuthRepository(':memory:'), {
			passwordHash: fastHash,
			now: () => now,
			mfaEncryptionKey: 'f'.repeat(64),
		});
		const owner = await service.signUp({
			email: 'owner@example.com',
			password: 'correct horse battery staple',
			displayName: 'Ada Owner',
			organizationName: 'Example Operations',
			organizationSlug: 'example-operations',
		});
		const enrolled = service.enrollTotp(owner.principal.accountId);
		expect(enrolled.recoveryCodes).toHaveLength(10);
		expect(
			enrolled.recoveryCodes.every((code) => /^[A-F0-9]{20}$/.test(code)),
		).toBe(true);
		expect(service.mfaStatus(owner.principal.accountId)).toEqual({
			available: true,
			enrolled: false,
			pending: true,
		});
		service.confirmTotp(owner.principal.accountId, totp(enrolled.secret, now));
		expect(service.mfaStatus(owner.principal.accountId)).toEqual({
			available: true,
			enrolled: true,
			pending: false,
		});
		expect(() => service.enrollTotp(owner.principal.accountId)).toThrowError(
			/Multi-factor authentication is already enabled/,
		);
		const challenge = await service.signIn({
			email: 'owner@example.com',
			password: 'correct horse battery staple',
		});
		expect(challenge.mfaRequired).toBe(true);
		const session = await service.completeMfaChallenge(
			challenge.token,
			undefined,
			enrolled.recoveryCodes[0],
		);
		expect(session.principal.email).toBe('owner@example.com');
		const replay = await service.signIn({
			email: 'owner@example.com',
			password: 'correct horse battery staple',
		});
		await expect(
			service.completeMfaChallenge(
				replay.token,
				undefined,
				enrolled.recoveryCodes[0],
			),
		).rejects.toMatchObject({ code: 'MFA_CODE_INVALID' });
	});

	it('continues an OIDC sign-in with the same MFA challenge contract', async () => {
		const now = 1_000_000;
		const service = new AuthService(new SqliteAuthRepository(':memory:'), {
			passwordHash: fastHash,
			now: () => now,
			mfaEncryptionKey: 'f'.repeat(64),
		});
		const owner = await service.signUp({
			email: 'owner@example.com',
			password: 'correct horse battery staple',
			displayName: 'Ada Owner',
			organizationName: 'Example Operations',
			organizationSlug: 'example-operations',
		});
		const enrolled = service.enrollTotp(owner.principal.accountId);
		service.confirmTotp(owner.principal.accountId, totp(enrolled.secret, now));
		await expect(
			service.signInVerifiedExternalEmail('owner@example.com'),
		).resolves.toMatchObject({
			mfaRequired: true,
			csrfToken: '',
			sessionId: '',
		});
	});

	it('accepts a tenant invitation once and adds no membership to another tenant', async () => {
		const mailbox = new Mailbox();
		const repository = new SqliteAuthRepository(':memory:');
		const service = new AuthService(repository, {
			passwordHash: fastHash,
			mailDelivery: mailbox,
			publicBaseUrl: 'https://erp.example',
		});
		const owner = await service.signUp({
			email: 'owner@example.com',
			password: 'correct horse battery staple',
			displayName: 'Ada Owner',
			organizationName: 'Example Operations',
			organizationSlug: 'example-operations',
		});
		const otherOwner = await service.signUp({
			email: 'other-owner@example.com',
			password: 'correct horse battery staple',
			displayName: 'Other Owner',
			organizationName: 'Other Operations',
			organizationSlug: 'other-operations',
		});
		const actor = {
			accountId: owner.principal.accountId,
			tenantId: owner.principal.tenantId,
			email: owner.principal.email,
			role: 'owner',
			scopes: owner.principal.scopes,
		};
		await service.createTenantInvitation(
			actor,
			'invitee@example.com',
			'member',
		);
		expect(new URL(mailbox.messages[0]!.url).pathname).toBe(
			'/auth/accept-invitation',
		);
		const token = new URL(mailbox.messages[0]!.url).searchParams.get('token')!;
		await service.acceptTenantInvitation({
			token,
			displayName: 'Invited Member',
			password: 'invitee password long enough',
		});
		expect(
			JSON.stringify(
				service.queryAudit({
					tenantId: owner.principal.tenantId,
					limit: 100,
				}),
			),
		).not.toContain(token);
		const signedIn = await service.signIn({
			email: 'invitee@example.com',
			password: 'invitee password long enough',
		});
		expect(signedIn.principal.tenantId).toBe(owner.principal.tenantId);
		expect(signedIn.principal.tenants.map((tenant) => tenant.tenantId)).toEqual(
			[owner.principal.tenantId],
		);
		expect(
			repository.findAccountMembership(
				signedIn.principal.accountId,
				otherOwner.principal.tenantId,
			),
		).toBeNull();
		await expect(
			service.acceptTenantInvitation({
				token,
				displayName: 'Invited Member',
				password: 'invitee password long enough',
			}),
		).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
	});
});
