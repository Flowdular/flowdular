import { PLATFORM_SETTINGS_TENANT } from '@flowdular/kernel';
import { afterEach, describe, expect, it } from 'vitest';
import {
	issueToken,
	openHarness,
	OWNER_PASSWORD,
	type CapturedMail,
	type DirectoryHarness,
	type HarnessOptions,
	type Session,
} from './support/harness.ts';

const open: DirectoryHarness[] = [];

afterEach(async () => {
	for (const harness of open.splice(0)) await harness.dispose();
});

async function harness(
	options: HarnessOptions = {},
): Promise<DirectoryHarness> {
	const created = await openHarness(options);
	open.push(created);
	return created;
}

interface ScimUser {
	readonly id: string;
	readonly userName: string;
	readonly displayName: string;
	readonly externalId?: string;
	readonly active: boolean;
	readonly meta: { readonly location: string };
}

async function createUser(
	suite: DirectoryHarness,
	owner: Session,
	token: string,
	body: Record<string, unknown>,
): Promise<ScimUser> {
	const response = await suite.scim({
		workspace: owner.slug,
		template: '/Users',
		method: 'POST',
		token,
		body,
	});
	if (response.status !== 201) {
		throw new Error(
			`SCIM create failed with ${response.status}: ${await response.text()}`,
		);
	}
	return (await response.json()) as ScimUser;
}

async function events(
	suite: DirectoryHarness,
	session: Session,
): Promise<
	{
		operation: string;
		outcome: string;
		reason: string | null;
		tokenId: string;
		subject: string;
	}[]
> {
	const response = await suite.admin(
		'/api/directory/provisioning-events',
		'GET',
		session,
	);
	return (
		(await response.json()) as {
			items: {
				operation: string;
				outcome: string;
				reason: string | null;
				tokenId: string;
				subject: string;
			}[];
		}
	).items;
}

describe('D-SCIM-RESET', () => {
	/* The account holds the unusable credential marker, so no password signs it
	   in. auth.core keeps the public reset open for it, and that is the whole
	   activation path where a workspace has no identity provider left: this
	   fails the day auth.core closes it and strands provisioned members. */
	it('activates a provisioned member through the public password reset', async () => {
		const mail: CapturedMail[] = [];
		const suite = await harness({ mail });
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		await createUser(suite, owner, token.token, {
			schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
			userName: 'ada@example.com',
			name: { givenName: 'Ada', familyName: 'Lovelace' },
		});
		const service = await suite.auth.service();
		const credentials = { email: 'ada@example.com', password: OWNER_PASSWORD };

		await expect(service.signIn(credentials)).rejects.toThrow();

		await service.requestPasswordReset('ada@example.com');
		const link = mail.find((message) => message.kind === 'password-reset');
		const reset = new URL(link?.url ?? '').searchParams.get('token') ?? '';
		await service.completePasswordReset(reset, OWNER_PASSWORD);

		const session = await service.signIn(credentials);
		expect(session.principal.tenantId).toBe(owner.tenantId);
	});
});

describe('DIRECTORY-USER-CREATE', () => {
	it('creates a passwordless member with the default role and logs the operation', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);

		const created = await createUser(suite, owner, token.token, {
			schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
			userName: 'Ada@Example.com',
			externalId: 'idp-ada',
			name: { givenName: 'Ada', familyName: 'Lovelace' },
		});
		expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(created.userName).toBe('ada@example.com');
		expect(created.externalId).toBe('idp-ada');
		expect(created.active).toBe(true);
		expect(created.meta.location).toContain('/Users/' + created.id);

		const members = await (
			await suite.auth.service()
		).listTenantMembers(owner.tenantId);
		const provisioned = members.find(
			(member) => member.email === 'ada@example.com',
		);
		expect(provisioned?.role).toBe('member');
		expect(provisioned?.membershipStatus).toBe('active');
		expect(provisioned?.displayName).toBe('Ada Lovelace');

		/* No password was set, so the password path stays closed: only an enabled
		   identity provider can sign this account in. */
		await expect(
			(await suite.auth.service()).signIn({
				email: 'ada@example.com',
				password: OWNER_PASSWORD,
			}),
		).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });

		const logged = await events(suite, owner);
		expect(logged).toHaveLength(1);
		expect(logged[0]).toMatchObject({
			operation: 'user-create',
			outcome: 'applied',
			tokenId: token.id,
			subject: 'ada@example.com',
		});
		expect(JSON.stringify(logged)).not.toContain(token.token);
	});

	it('refuses a second user for the same userName with scimType uniqueness', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		await createUser(suite, owner, token.token, {
			userName: 'ada@example.com',
		});
		const again = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'POST',
			token: token.token,
			body: { userName: 'ada@example.com' },
		});
		expect(again.status).toBe(409);
		expect(await again.json()).toMatchObject({
			scimType: 'uniqueness',
			reason: 'USER_EXISTS',
		});
	});

	it('refuses an address that already holds another membership', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		/* The owner's own address belongs to an account with a membership, which
		   is exactly the account SCIM must not absorb. */
		const refused = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'POST',
			token: token.token,
			body: { userName: 'owner@example.com' },
		});
		expect(refused.status).toBe(409);
		expect(await refused.json()).toMatchObject({
			scimType: 'uniqueness',
			reason: 'ACCOUNT_IN_USE',
		});
		expect(
			(await (await suite.auth.service()).listTenantMembers(owner.tenantId))
				.length,
		).toBe(1);
	});

	/* The member holds no password at all rather than a placeholder secret, so
	   the two paths that would read one have to say so themselves. */
	it('leaves the provisioned member with no password to change', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		const service = await suite.auth.service();

		await createUser(suite, owner, token.token, {
			userName: 'ada@example.com',
		});
		const provisioned = (await service.listTenantMembers(owner.tenantId)).find(
			(member) => member.email === 'ada@example.com',
		);

		/* A caller already authenticated as the account is told the cause; a
		   sign-in is not, because that would name the addresses holding none. */
		await expect(
			service.changePassword({
				accountId: provisioned!.accountId,
				currentPassword: OWNER_PASSWORD,
				newPassword: 'quiet lantern voyage',
			}),
		).rejects.toMatchObject({ code: 'PASSWORD_NOT_SET' });
	});

	/* The auth trail is where an owner sees how the account was created, and a
	   provisioned one has to be distinguishable from an ordinary member. */
	it('records the SCIM token as the actor and names the missing credential', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);

		await createUser(suite, owner, token.token, {
			userName: 'ada@example.com',
		});

		const created = (
			await (
				await suite.auth.service()
			).queryAudit({ tenantId: owner.tenantId, limit: 20 })
		).events.find((event) => event.action === 'users.member.created');

		expect(created?.actorLabel).toBe(`scim-token:${token.id}`);
		expect(created?.metadata).toMatchObject({
			email: 'ada@example.com',
			role: 'member',
			credential: 'none',
		});
		/* Nothing was drawn, so nothing about a secret can reach the trail. */
		expect(JSON.stringify(created)).not.toContain(token.token);
		expect(JSON.stringify(created)).not.toMatch(/password|scrypt/i);
	});

	it('refuses a body that is not SCIM JSON and one that is too large', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		const wrongType = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'POST',
			token: token.token,
			body: { userName: 'ada@example.com' },
			contentType: 'text/plain',
		});
		expect(wrongType.status).toBe(415);
		const oversized = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'POST',
			token: token.token,
			body: { userName: 'ada@example.com', padding: 'x'.repeat(600_000) },
		});
		expect(oversized.status).toBe(413);
	});
});

describe('DIRECTORY-USER-NO-PROVIDER', () => {
	it('refuses creation and creates no member', async () => {
		const suite = await harness({ identityProvider: false });
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		const refused = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'POST',
			token: token.token,
			body: { userName: 'ada@example.com' },
		});
		expect(refused.status).toBe(400);
		expect(await refused.json()).toMatchObject({
			scimType: 'invalidValue',
			reason: 'NO_ENABLED_PROVIDER',
		});

		expect(
			(await (await suite.auth.service()).listTenantMembers(owner.tenantId))
				.length,
		).toBe(1);
		const listed = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'GET',
			token: token.token,
		});
		expect(await listed.json()).toMatchObject({ totalResults: 0 });
		/* The refusal itself is the one row written: it is the evidence the
		   operator reads in the provisioning log. */
		expect(await events(suite, owner)).toMatchObject([
			{
				operation: 'user-create',
				outcome: 'refused',
				reason: 'NO_ENABLED_PROVIDER',
			},
		]);
	});
});

describe('DIRECTORY-USER-DEACTIVATE', () => {
	it('disables this membership only, then re-enables it', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const elsewhere = await suite.signUp('owner-b@example.com', 'workspace-b');
		const token = await issueToken(suite, owner);
		const created = await createUser(suite, owner, token.token, {
			userName: 'ada@example.com',
		});
		const service = await suite.auth.service();
		const member = (await service.listTenantMembers(owner.tenantId)).find(
			(entry) => entry.email === 'ada@example.com',
		)!;

		/* The same account joins a second workspace, so the deactivation below
		   has something to leave untouched. */
		await service.provisionMember({
			workspace: elsewhere.slug,
			email: 'ada@example.com',
			role: 'member',
			operator: 'test-operator',
		});
		const apiToken = await service.issueApiToken({
			tenantId: owner.tenantId,
			accountId: member.accountId,
			label: 'Her token',
			/* Any scope the member role actually holds: the token exists to prove
			   deactivation revokes it, not to carry authority. */
			scopes: member.scopes.slice(0, 1),
			expiresAt: null,
			createdBy: owner.accountId,
		});

		const deactivated = await suite.scim({
			workspace: owner.slug,
			template: '/Users/:id',
			method: 'PATCH',
			token: token.token,
			params: { id: created.id },
			body: {
				schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
				Operations: [{ op: 'replace', path: 'active', value: false }],
			},
		});
		expect(deactivated.status).toBe(200);
		expect(await deactivated.json()).toMatchObject({ active: false });

		const here = (await service.listTenantMembers(owner.tenantId)).find(
			(entry) => entry.email === 'ada@example.com',
		);
		const there = (await service.listTenantMembers(elsewhere.tenantId)).find(
			(entry) => entry.email === 'ada@example.com',
		);
		expect(here?.membershipStatus).toBe('disabled');
		expect(there?.membershipStatus).toBe('active');
		expect(await service.findAccountAccess('ada@example.com')).not.toBeNull();
		const tokensHere = await service.listApiTokens(owner.tenantId);
		expect(
			tokensHere.find((entry) => entry.id === apiToken.record.id)?.revokedAt,
		).not.toBeNull();

		/* DELETE deprovisions the same way, so a provider that sends both writes
		   nothing the second time. */
		const removed = await suite.scim({
			workspace: owner.slug,
			template: '/Users/:id',
			method: 'DELETE',
			token: token.token,
			params: { id: created.id },
		});
		expect(removed.status).toBe(204);
		expect(
			(await service.listTenantMembers(owner.tenantId)).find(
				(entry) => entry.email === 'ada@example.com',
			)?.membershipStatus,
		).toBe('disabled');

		const reactivated = await suite.scim({
			workspace: owner.slug,
			template: '/Users/:id',
			method: 'PATCH',
			token: token.token,
			params: { id: created.id },
			body: {
				Operations: [{ op: 'replace', value: { active: true } }],
			},
		});
		expect(reactivated.status).toBe(200);
		expect(await reactivated.json()).toMatchObject({ active: true });
		expect(
			(await service.listTenantMembers(owner.tenantId)).find(
				(entry) => entry.email === 'ada@example.com',
			)?.membershipStatus,
		).toBe('active');

		const logged = await events(suite, owner);
		expect(logged.map((entry) => [entry.operation, entry.outcome])).toEqual([
			['user-reactivate', 'applied'],
			['user-deactivate', 'unchanged'],
			['user-deactivate', 'applied'],
			['user-create', 'applied'],
		]);
	});

	it('refuses a userName change and a changed primary e-mail', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		const created = await createUser(suite, owner, token.token, {
			userName: 'ada@example.com',
		});
		const renamed = await suite.scim({
			workspace: owner.slug,
			template: '/Users/:id',
			method: 'PUT',
			token: token.token,
			params: { id: created.id },
			body: { userName: 'grace@example.com' },
		});
		expect(renamed.status).toBe(400);
		expect(await renamed.json()).toMatchObject({
			scimType: 'mutability',
			reason: 'IMMUTABLE_USER_NAME',
		});

		const rebranded = await suite.scim({
			workspace: owner.slug,
			template: '/Users/:id',
			method: 'PUT',
			token: token.token,
			params: { id: created.id },
			body: {
				userName: 'ada@example.com',
				emails: [{ value: 'grace@example.com', primary: true }],
			},
		});
		expect(rebranded.status).toBe(400);
		expect(await rebranded.json()).toMatchObject({
			reason: 'IMMUTABLE_EMAIL',
		});
	});

	it('replaces a user through PUT and reads it back by id', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		const created = await createUser(suite, owner, token.token, {
			userName: 'ada@example.com',
			name: { givenName: 'Ada', familyName: 'Lovelace' },
		});

		const replaced = await suite.scim({
			workspace: owner.slug,
			template: '/Users/:id',
			method: 'PUT',
			token: token.token,
			params: { id: created.id },
			body: {
				userName: 'ada@example.com',
				displayName: 'Ada King',
				externalId: 'idp-ada-2',
				active: true,
			},
		});
		expect(replaced.status).toBe(200);
		expect(await replaced.json()).toMatchObject({
			displayName: 'Ada King',
			externalId: 'idp-ada-2',
			active: true,
		});
		expect(
			(
				await (await suite.auth.service()).listTenantMembers(owner.tenantId)
			).find((member) => member.email === 'ada@example.com')?.displayName,
		).toBe('Ada King');

		const read = await suite.scim({
			workspace: owner.slug,
			template: '/Users/:id',
			method: 'GET',
			token: token.token,
			params: { id: created.id },
		});
		expect(read.status).toBe(200);
		expect(await read.json()).toMatchObject({
			id: created.id,
			userName: 'ada@example.com',
			displayName: 'Ada King',
		});

		/* A rename that also carries the current `active` is an update, not a
		   reactivation: the log has to say what actually moved. */
		const logged = await events(suite, owner);
		expect(logged[0]).toMatchObject({
			operation: 'user-update',
			outcome: 'applied',
		});

		const repeat = await suite.scim({
			workspace: owner.slug,
			template: '/Users/:id',
			method: 'PUT',
			token: token.token,
			params: { id: created.id },
			body: {
				userName: 'ada@example.com',
				displayName: 'Ada King',
				externalId: 'idp-ada-2',
				active: true,
			},
		});
		expect(repeat.status).toBe(200);
		expect((await events(suite, owner))[0]).toMatchObject({
			outcome: 'unchanged',
		});
	});

	/* The sub-attribute spelling providers actually send for an address change. */
	it('refuses an e-mail change sent through a sub-attribute path', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		const created = await createUser(suite, owner, token.token, {
			userName: 'ada@example.com',
		});
		const refused = await suite.scim({
			workspace: owner.slug,
			template: '/Users/:id',
			method: 'PATCH',
			token: token.token,
			params: { id: created.id },
			body: {
				Operations: [
					{
						op: 'replace',
						path: 'emails[type eq "work"].value',
						value: 'grace@example.com',
					},
				],
			},
		});
		expect(refused.status).toBe(400);
		expect(await refused.json()).toMatchObject({
			scimType: 'mutability',
			reason: 'IMMUTABLE_EMAIL',
		});
		expect(
			(await (await suite.auth.service()).listTenantMembers(owner.tenantId))
				.map((member) => member.email)
				.sort(),
		).toEqual(['ada@example.com', 'owner@example.com']);
	});

	/* Entra echoes the current userName next to the change it wants. */
	it('accepts a patch that repeats the current userName', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		const created = await createUser(suite, owner, token.token, {
			userName: 'ada@example.com',
		});
		const patched = await suite.scim({
			workspace: owner.slug,
			template: '/Users/:id',
			method: 'PATCH',
			token: token.token,
			params: { id: created.id },
			body: {
				Operations: [
					{
						op: 'replace',
						value: { userName: 'ada@example.com', active: false },
					},
				],
			},
		});
		expect(patched.status).toBe(200);
		expect(await patched.json()).toMatchObject({ active: false });
	});

	/* auth.core caps a display name at 80 characters; two 40 character halves
	   join past it, and that is a name, not a fault. */
	it('accepts a name whose halves join past the display name limit', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		const created = await createUser(suite, owner, token.token, {
			userName: 'ada@example.com',
			name: { givenName: 'A'.repeat(40), familyName: 'B'.repeat(40) },
		});
		expect(created.displayName.length).toBe(80);
	});

	/* Every refusal of a write is evidence, including the ones the body raises. */
	it('records a refusal raised while reading the body', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		const created = await createUser(suite, owner, token.token, {
			userName: 'ada@example.com',
		});
		const refused = await suite.scim({
			workspace: owner.slug,
			template: '/Users/:id',
			method: 'PUT',
			token: token.token,
			params: { id: created.id },
			body: { userName: 'grace@example.com' },
		});
		expect(refused.status).toBe(400);
		expect((await events(suite, owner))[0]).toMatchObject({
			operation: 'user-update',
			outcome: 'refused',
			reason: 'IMMUTABLE_USER_NAME',
			subject: created.id,
		});
	});

	it('refuses a patch path this service provider does not maintain', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		const created = await createUser(suite, owner, token.token, {
			userName: 'ada@example.com',
		});
		const refused = await suite.scim({
			workspace: owner.slug,
			template: '/Users/:id',
			method: 'PATCH',
			token: token.token,
			params: { id: created.id },
			body: { Operations: [{ op: 'replace', path: 'nickName', value: 'A' }] },
		});
		expect(refused.status).toBe(400);
		expect(await refused.json()).toMatchObject({
			scimType: 'noTarget',
			reason: 'UNSUPPORTED_PATH',
		});
	});

	it('answers 404 for a SCIM user of another workspace', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const other = await suite.signUp('owner-b@example.com', 'workspace-b');
		const token = await issueToken(suite, owner);
		const otherToken = await issueToken(suite, other, 'Other');
		const created = await createUser(suite, other, otherToken.token, {
			userName: 'ada@example.com',
		});
		const response = await suite.scim({
			workspace: owner.slug,
			template: '/Users/:id',
			method: 'GET',
			token: token.token,
			params: { id: created.id },
		});
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ reason: 'USER_NOT_FOUND' });
	});
});

describe('DIRECTORY-FILTER', () => {
	it('filters, pages and refuses an unsupported attribute', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		for (const name of ['ada', 'grace', 'edsger']) {
			await createUser(suite, owner, token.token, {
				userName: `${name}@example.com`,
				externalId: `idp-${name}`,
			});
		}
		await suite.scim({
			workspace: owner.slug,
			template: '/Groups',
			method: 'POST',
			token: token.token,
			body: { displayName: 'Engineering' },
		});

		const byUserName = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'GET',
			token: token.token,
			query: '?filter=' + encodeURIComponent('userName eq "grace@example.com"'),
		});
		expect(await byUserName.json()).toMatchObject({
			totalResults: 1,
			Resources: [{ userName: 'grace@example.com' }],
		});

		const byExternalId = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'GET',
			token: token.token,
			query: '?filter=' + encodeURIComponent('externalId eq "idp-ada"'),
		});
		expect(await byExternalId.json()).toMatchObject({ totalResults: 1 });

		const byDisplayName = await suite.scim({
			workspace: owner.slug,
			template: '/Groups',
			method: 'GET',
			token: token.token,
			query: '?filter=' + encodeURIComponent('displayName eq "engineering"'),
		});
		expect(await byDisplayName.json()).toMatchObject({
			totalResults: 1,
			Resources: [{ displayName: 'Engineering' }],
		});

		/* count above the platform maximum is clamped, never refused. */
		suite.settings.set(
			PLATFORM_SETTINGS_TENANT,
			'directory.core',
			'pageSizeMax',
			2,
			'test',
		);
		const clamped = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'GET',
			token: token.token,
			query: '?count=500&startIndex=1',
		});
		const page = (await clamped.json()) as {
			totalResults: number;
			itemsPerPage: number;
			startIndex: number;
		};
		expect(page).toMatchObject({
			totalResults: 3,
			itemsPerPage: 2,
			startIndex: 1,
		});

		const second = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'GET',
			token: token.token,
			query: '?count=500&startIndex=3',
		});
		expect(await second.json()).toMatchObject({
			totalResults: 3,
			itemsPerPage: 1,
			startIndex: 3,
		});

		const unsupported = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'GET',
			token: token.token,
			query: '?filter=' + encodeURIComponent('nickName co "ada"'),
		});
		expect(unsupported.status).toBe(400);
		expect(await unsupported.json()).toMatchObject({
			scimType: 'invalidFilter',
			reason: 'UNSUPPORTED_FILTER',
		});

		const unsupportedAttribute = await suite.scim({
			workspace: owner.slug,
			template: '/Groups',
			method: 'GET',
			token: token.token,
			query: '?filter=' + encodeURIComponent('userName eq "ada@example.com"'),
		});
		expect(unsupportedAttribute.status).toBe(400);
	});

	it('accepts the filter operator in any case and pages the log by cursor', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		for (const name of ['ada', 'grace', 'edsger']) {
			await createUser(suite, owner, token.token, {
				userName: `${name}@example.com`,
			});
		}
		const upperCase = await suite.scim({
			workspace: owner.slug,
			template: '/Users',
			method: 'GET',
			token: token.token,
			query: '?filter=' + encodeURIComponent('USERNAME EQ "grace@example.com"'),
		});
		expect(await upperCase.json()).toMatchObject({ totalResults: 1 });

		const first = await suite.admin(
			'/api/directory/provisioning-events?limit=2',
			'GET',
			owner,
		);
		const firstPage = (await first.json()) as {
			items: { id: string }[];
			page: { nextCursor: string | null };
		};
		expect(firstPage.items).toHaveLength(2);
		expect(firstPage.page.nextCursor).not.toBeNull();

		const second = await suite.admin(
			'/api/directory/provisioning-events?limit=2&cursor=' +
				encodeURIComponent(firstPage.page.nextCursor!),
			'GET',
			owner,
		);
		const secondPage = (await second.json()) as {
			items: { id: string }[];
			page: { nextCursor: string | null };
		};
		expect(secondPage.items).toHaveLength(1);
		expect(secondPage.page.nextCursor).toBeNull();
		/* The pages are disjoint: a cursor never re-reads the row it ended on. */
		expect(
			secondPage.items.filter((event) =>
				firstPage.items.some((seen) => seen.id === event.id),
			),
		).toEqual([]);

		const forged = await suite.admin(
			'/api/directory/provisioning-events?cursor=c1.forged.signature',
			'GET',
			owner,
		);
		expect(forged.status).toBe(400);
	});

	it('serves the discovery endpoints the protocol requires', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		const config = await suite.scim({
			workspace: owner.slug,
			template: '/ServiceProviderConfig',
			method: 'GET',
			token: token.token,
		});
		expect(config.headers.get('content-type')).toBe('application/scim+json');
		expect(await config.json()).toMatchObject({
			patch: { supported: true },
			bulk: { supported: false },
			filter: { supported: true },
		});
		expect(
			(
				(await (
					await suite.scim({
						workspace: owner.slug,
						template: '/ResourceTypes',
						method: 'GET',
						token: token.token,
					})
				).json()) as { Resources: { id: string }[] }
			).Resources.map((entry) => entry.id),
		).toEqual(['User', 'Group']);
		expect(
			(
				(await (
					await suite.scim({
						workspace: owner.slug,
						template: '/Schemas',
						method: 'GET',
						token: token.token,
					})
				).json()) as { totalResults: number }
			).totalResults,
		).toBe(2);
	});
});
