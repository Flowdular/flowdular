import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { OWNER_SCOPES } from '../src/acl/scopes.ts';
import { AuthService } from '../src/services/auth-service.ts';
import type { AuthMailDelivery } from '../src/services/mail-delivery.ts';
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

async function fixture(): Promise<AuthTestDatabase> {
	const database = await createAuthTestDatabase();
	open.add(database);
	return database;
}

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
		const repository = (await fixture()).repository;
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
		expect(
			(await service.resolveSession(issued.token))?.principal.accountId,
		).toBe(issued.principal.accountId);
		expect(await service.resolveSession('not-a-session')).toBeNull();
		const secondTenantId = randomUUID();
		await repository.createTenantMembership({
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
		expect(await service.resolveSession(issued.token)).toBeNull();
	});

	it('rejects a taken workspace slug and reports availability', async () => {
		const service = new AuthService((await fixture()).repository, {
			passwordHash: fastHash,
		});
		await service.signUp({
			email: 'first@example.com',
			password: 'correct horse battery staple',
			displayName: 'First Owner',
			organizationName: 'First Workspace',
			organizationSlug: 'shared-slug',
		});
		expect(await service.checkWorkspaceSlug('shared-slug')).toMatchObject({
			valid: true,
			available: false,
		});
		expect(await service.checkWorkspaceSlug('open-slug')).toMatchObject({
			valid: true,
			available: true,
		});
		expect(await service.checkWorkspaceSlug('X')).toMatchObject({
			valid: false,
		});
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
		const service = new AuthService((await fixture()).repository, {
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
		const service = new AuthService((await fixture()).repository, {
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
				await service.queryAudit({
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

	/* The address rule needs the account the link names, and looking that up
	   used to cost the link: the visitor got one refusal and a dead token. */
	it('keeps the reset link usable after the password policy refuses a submission', async () => {
		const mailbox = new Mailbox();
		const service = new AuthService((await fixture()).repository, {
			passwordHash: fastHash,
			mailDelivery: mailbox,
			publicBaseUrl: 'https://erp.example',
		});
		await service.signUp({
			email: 'ada.lovelace@example.com',
			password: 'correct horse battery staple',
			displayName: 'Ada Owner',
			organizationName: 'Example Operations',
			organizationSlug: 'example-operations',
		});
		await service.requestPasswordReset('ada.lovelace@example.com');
		const token = new URL(mailbox.messages[0]!.url).searchParams.get('token')!;

		await expect(
			service.completePasswordReset(token, 'ada.lovelace summer harbor'),
		).rejects.toMatchObject({ code: 'PASSWORD_CONTAINS_EMAIL', status: 400 });

		await expect(
			service.completePasswordReset(token, 'steady tangerine harbor'),
		).resolves.toBeUndefined();
		await expect(
			service.signIn({
				email: 'ada.lovelace@example.com',
				password: 'steady tangerine harbor',
			}),
		).resolves.toMatchObject({
			principal: { email: 'ada.lovelace@example.com' },
		});
	});

	it('requires an enrolled TOTP factor and consumes recovery codes only once', async () => {
		let now = 1_000_000;
		const service = new AuthService((await fixture()).repository, {
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
		const enrolled = await service.enrollTotp(owner.principal.accountId);
		expect(enrolled.recoveryCodes).toHaveLength(10);
		expect(
			enrolled.recoveryCodes.every((code) => /^[A-F0-9]{20}$/.test(code)),
		).toBe(true);
		expect(await service.mfaStatus(owner.principal.accountId)).toEqual({
			available: true,
			enrolled: false,
			pending: true,
		});
		await service.confirmTotp(
			owner.principal.accountId,
			totp(enrolled.secret, now),
		);
		expect(await service.mfaStatus(owner.principal.accountId)).toEqual({
			available: true,
			enrolled: true,
			pending: false,
		});
		await expect(
			service.enrollTotp(owner.principal.accountId),
		).rejects.toThrowError(/Multi-factor authentication is already enabled/);
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
		const service = new AuthService((await fixture()).repository, {
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
		const enrolled = await service.enrollTotp(owner.principal.accountId);
		await service.confirmTotp(
			owner.principal.accountId,
			totp(enrolled.secret, now),
		);
		await expect(
			service.signInExternalIdentity({
				provider: 'example',
				subject: 'provider-subject-1',
				email: 'owner@example.com',
			}),
		).resolves.toMatchObject({
			mfaRequired: true,
			csrfToken: '',
			sessionId: '',
		});
	});

	it('accepts a tenant invitation once and adds no membership to another tenant', async () => {
		const mailbox = new Mailbox();
		const repository = (await fixture()).repository;
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
			password: 'quiet lantern voyage steady',
		});
		expect(
			JSON.stringify(
				await service.queryAudit({
					tenantId: owner.principal.tenantId,
					limit: 100,
				}),
			),
		).not.toContain(token);
		const signedIn = await service.signIn({
			email: 'invitee@example.com',
			password: 'quiet lantern voyage steady',
		});
		expect(signedIn.principal.tenantId).toBe(owner.principal.tenantId);
		expect(signedIn.principal.tenants.map((tenant) => tenant.tenantId)).toEqual(
			[owner.principal.tenantId],
		);
		expect(
			await repository.findAccountMembership(
				signedIn.principal.accountId,
				otherOwner.principal.tenantId,
			),
		).toBeNull();
		await expect(
			service.acceptTenantInvitation({
				token,
				displayName: 'Invited Member',
				password: 'quiet lantern voyage steady',
			}),
		).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
	});
});
