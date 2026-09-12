import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { AuthActor } from '../src/domain/types.ts';
import { DevelopmentMailDelivery } from '../src/services/mail-delivery.ts';
import {
	AuthService,
	TENANT_MEMBER_LOOKUP_LIMIT,
	TENANT_MEMBER_SEARCH_LIMIT,
} from '../src/services/auth-service.ts';
import { textArrayLiteral } from '../src/services/database-repository.ts';
import { fastHash } from './helpers.ts';
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

interface Workspace {
	readonly service: AuthService;
	readonly owner: AuthActor;
	/** The composed delivery port, so a case can read the link it carried. */
	readonly mail: DevelopmentMailDelivery;
}

async function workspace(
	email = 'owner@example.com',
	slug = 'example-operations',
): Promise<Workspace> {
	const database = await createAuthTestDatabase();
	open.add(database);
	const mail = new DevelopmentMailDelivery();
	const service = new AuthService(database.repository, {
		passwordHash: fastHash,
		mailDelivery: mail,
		policy: () => ({
			sessionTtlMs: 12 * 60 * 60 * 1000,
			sessionIdleMs: 2 * 60 * 60 * 1000,
			passwordMinLength: 12,
		}),
	});
	const issued = await service.signUp({
		email,
		password: 'correct horse battery staple',
		displayName: 'Olive Owner',
		organizationName: 'Example Operations',
		organizationSlug: slug,
	});
	return {
		service,
		mail,
		owner: {
			accountId: issued.principal.accountId,
			tenantId: issued.principal.tenantId,
			email: issued.principal.email,
			role: 'owner',
			scopes: issued.principal.scopes,
		},
	};
}

/** A second workspace on the same database, for the tenant-scoping cases. */
async function second(service: AuthService): Promise<AuthActor> {
	const issued = await service.signUp({
		email: 'other@example.com',
		password: 'correct horse battery staple',
		displayName: 'Bo Other',
		organizationName: 'Fabrikam',
		organizationSlug: 'fabrikam',
	});
	return {
		accountId: issued.principal.accountId,
		tenantId: issued.principal.tenantId,
		email: issued.principal.email,
		role: 'owner',
		scopes: issued.principal.scopes,
	};
}

describe('AUTH-MEMBER-NO-PASSWORD', () => {
	it('refuses a password sign-in for a member created without one, exactly as an unknown address is refused', async () => {
		const { service, owner } = await workspace();
		const member = await service.createTenantMemberWithoutPassword(
			{
				tenantId: owner.tenantId,
				email: 'Ada@Example.com',
				displayName: 'Ada Lovelace',
				role: 'member',
			},
			owner,
		);

		expect(member.email).toBe('ada@example.com');
		/* The workspace's own password is the closest guess an attacker has, and
		   no password at all is stored, so nothing can match. */
		await expect(
			service.signIn({
				email: 'ada@example.com',
				password: 'correct horse battery staple',
			}),
		).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
		/* The refusal must not say that the address exists and holds no password:
		   an address nobody registered answers with the same code. */
		await expect(
			service.signIn({
				email: 'nobody@example.com',
				password: 'correct horse battery staple',
			}),
		).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
	});

	it('names the actor and the missing credential in the audit trail', async () => {
		const { service, owner } = await workspace();
		await service.createTenantMemberWithoutPassword(
			{
				tenantId: owner.tenantId,
				email: 'ada@example.com',
				displayName: 'Ada Lovelace',
				role: 'member',
			},
			owner,
		);

		const created = (
			await service.queryAudit({ tenantId: owner.tenantId, limit: 10 })
		).events.find((event) => event.action === 'users.member.created');

		expect(created?.actorLabel).toBe(owner.email);
		expect(created?.actorAccountId).toBe(owner.accountId);
		expect(created?.metadata).toMatchObject({
			email: 'ada@example.com',
			role: 'member',
			credential: 'none',
		});
		/* No secret was drawn, so none can leak into the trail. */
		expect(JSON.stringify(created)).not.toMatch(/passwordHash|scrypt/);
	});

	it('lets the public reset flow set the first password and sign the member in', async () => {
		const { service, owner, mail } = await workspace();
		const member = await service.createTenantMemberWithoutPassword(
			{
				tenantId: owner.tenantId,
				email: 'ada@example.com',
				displayName: 'Ada Lovelace',
				role: 'member',
			},
			owner,
		);

		/* The public path, not an administrative one: an account holding no
		   password is found by its address and receives a link like any other. */
		await service.requestPasswordReset('ada@example.com');
		const delivered = mail.messages.at(-1);
		expect(delivered).toMatchObject({
			to: 'ada@example.com',
			kind: 'password-reset',
		});
		const token = new URL(delivered!.url).searchParams.get('token')!;

		await service.completePasswordReset(token, 'quiet lantern voyage');

		const session = await service.signIn({
			email: 'ada@example.com',
			password: 'quiet lantern voyage',
		});
		expect(session.principal.accountId).toBe(member.accountId);
	});

	it('tells a member who never had a password why the change is refused', async () => {
		const { service, owner } = await workspace();
		const member = await service.createTenantMemberWithoutPassword(
			{
				tenantId: owner.tenantId,
				email: 'ada@example.com',
				displayName: 'Ada Lovelace',
				role: 'member',
			},
			owner,
		);

		/* The caller is already authenticated as the account here, so the cause is
		   named rather than folded into the sign-in refusal. */
		await expect(
			service.changePassword({
				accountId: member.accountId,
				currentPassword: 'correct horse battery staple',
				newPassword: 'quiet lantern voyage',
			}),
		).rejects.toMatchObject({ code: 'PASSWORD_NOT_SET' });
	});

	it('keeps the password path working and refuses a member of another workspace', async () => {
		const { service, owner } = await workspace();
		const other = await second(service);

		const member = await service.createTenantMember(
			{
				tenantId: owner.tenantId,
				email: 'grace@example.com',
				password: 'steady tangerine harbor',
				displayName: 'Grace Hopper',
				role: 'member',
			},
			owner,
		);
		expect(
			(
				await service.signIn({
					email: 'grace@example.com',
					password: 'steady tangerine harbor',
				})
			).principal.accountId,
		).toBe(member.accountId);

		await expect(
			service.createTenantMemberWithoutPassword(
				{
					tenantId: other.tenantId,
					email: 'ada@example.com',
					displayName: 'Ada Lovelace',
					role: 'member',
				},
				owner,
			),
		).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
	});
});

describe('AUTH-MEMBER-LOOKUP', () => {
	it('answers only the addresses its own workspace holds', async () => {
		const { service, owner } = await workspace();
		const other = await second(service);
		await service.createTenantMemberWithoutPassword(
			{
				tenantId: owner.tenantId,
				email: 'ada@example.com',
				displayName: 'Ada Lovelace',
				role: 'member',
			},
			owner,
		);
		await service.createTenantMemberWithoutPassword(
			{
				tenantId: other.tenantId,
				email: 'grace@example.com',
				displayName: 'Grace Hopper',
				role: 'member',
			},
			other,
		);

		expect(
			(
				await service.findTenantMembersByEmail(owner.tenantId, [
					'  Ada@Example.COM ',
					'grace@example.com',
					'nobody@example.com',
				])
			).map((member) => member.email),
		).toEqual(['ada@example.com']);
		/* The same call from the other workspace sees its own member and not Ada,
		   so the read carries the workspace rather than the address. */
		expect(
			(
				await service.findTenantMembersByEmail(other.tenantId, [
					'ada@example.com',
					'grace@example.com',
				])
			).map((member) => member.email),
		).toEqual(['grace@example.com']);
	});

	it('refuses more addresses than one lookup may carry', async () => {
		const { service, owner } = await workspace();
		const addresses = Array.from(
			{ length: TENANT_MEMBER_LOOKUP_LIMIT + 1 },
			(_, index) => `person${index}@example.com`,
		);

		await expect(
			service.findTenantMembersByEmail(owner.tenantId, addresses),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		await expect(
			service.findTenantMembersByEmail(
				owner.tenantId,
				addresses.slice(0, TENANT_MEMBER_LOOKUP_LIMIT),
			),
		).resolves.toEqual([]);
	});

	it('matches an address that carries an array or quoting character literally', async () => {
		const { service, owner } = await workspace();

		/* The list travels as one PostgreSQL array literal, so an element that
		   carries a quote, a backslash or a comma must not end it. */
		expect(textArrayLiteral(['a"b', 'c\\d', 'e,f'])).toBe(
			'{"a\\"b","c\\\\d","e,f"}',
		);
		await expect(
			service.findTenantMembersByEmail(owner.tenantId, [
				'a"b@example.com',
				'c\\d@example.com',
				'owner@example.com',
			]),
		).resolves.toMatchObject([{ email: 'owner@example.com' }]);
	});
});

describe('AUTH-MEMBER-SEARCH', () => {
	async function seeded(): Promise<Workspace & { other: AuthActor }> {
		const { service, owner, mail } = await workspace();
		const other = await second(service);
		for (const [email, displayName] of [
			['ada@example.com', 'Ada Lovelace'],
			['alan@example.com', 'Alan Turing'],
			['grace@navy.example', 'Grace Hopper'],
		] as const) {
			await service.createTenantMemberWithoutPassword(
				{ tenantId: owner.tenantId, email, displayName, role: 'member' },
				owner,
			);
		}
		await service.createTenantMemberWithoutPassword(
			{
				tenantId: other.tenantId,
				email: 'ada@other.example',
				displayName: 'Ada Elsewhere',
				role: 'member',
			},
			other,
		);
		return { service, owner, mail, other };
	}

	it('matches a name and an address by their start, in its own workspace', async () => {
		const { service, owner, other } = await seeded();

		/* The address does not start with this, so only the display name answers. */
		expect(
			(
				await service.searchTenantMembers(owner.tenantId, {
					query: 'alan t',
					limit: 50,
				})
			).map((member) => member.email),
		).toEqual(['alan@example.com']);
		/* And the reverse: the display name is Grace Hopper, so only the address
		   answers this one. */
		expect(
			(
				await service.searchTenantMembers(owner.tenantId, {
					query: 'grace@',
					limit: 50,
				})
			).map((member) => member.email),
		).toEqual(['grace@navy.example']);
		/* A term inside a name no longer matches. Migration 0028 serves both
		   branches from a prefix index, and a containment is a range no btree can
		   answer: the search used to read and sort the workspace per keystroke. */
		expect(
			await service.searchTenantMembers(owner.tenantId, {
				query: 'lovelace',
				limit: 50,
			}),
		).toEqual([]);
		expect(
			(
				await service.searchTenantMembers(owner.tenantId, {
					query: 'ADA',
					limit: 50,
				})
			).map((member) => member.email),
		).toEqual(['ada@example.com']);
		/* The other workspace's Ada is invisible from here, and this workspace's
		   Ada is invisible from there. */
		expect(
			(
				await service.searchTenantMembers(other.tenantId, {
					query: 'ada',
					limit: 50,
				})
			).map((member) => member.email),
		).toEqual(['ada@other.example']);
	});

	it('cuts the answer to the limit it was given', async () => {
		const { service, owner } = await seeded();

		/* Ada and Alan both start with the term, so a limit of one proves the cut
		   rather than the predicate. */
		expect(
			await service.searchTenantMembers(owner.tenantId, {
				query: 'a',
				limit: 50,
			}),
		).toHaveLength(2);
		expect(
			await service.searchTenantMembers(owner.tenantId, {
				query: 'a',
				limit: 1,
			}),
		).toHaveLength(1);
		for (const limit of [0, -1, TENANT_MEMBER_SEARCH_LIMIT + 1, 1.5]) {
			await expect(
				service.searchTenantMembers(owner.tenantId, { query: 'a', limit }),
			).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		}
		await expect(
			service.searchTenantMembers(owner.tenantId, { query: '   ', limit: 10 }),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' });
	});

	it('treats a LIKE wildcard in the term as a character to match', async () => {
		const { service, owner } = await seeded();

		/* An unescaped '%' would match every member of the workspace. */
		expect(
			await service.searchTenantMembers(owner.tenantId, {
				query: '%',
				limit: 50,
			}),
		).toEqual([]);
		expect(
			await service.searchTenantMembers(owner.tenantId, {
				query: '_da',
				limit: 50,
			}),
		).toEqual([]);
	});
});
