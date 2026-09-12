import { afterEach, describe, expect, it } from 'vitest';
import { scimActor } from '../src/services/auth-port.ts';
import {
	issueToken,
	openHarness,
	type DirectoryHarness,
	type Session,
} from './support/harness.ts';

const open: DirectoryHarness[] = [];

afterEach(async () => {
	for (const harness of open.splice(0)) await harness.dispose();
});

async function harness(): Promise<DirectoryHarness> {
	const created = await openHarness();
	open.push(created);
	return created;
}

interface ScimGroup {
	readonly id: string;
	readonly displayName: string;
	readonly members: { readonly value: string }[];
}

async function createGroup(
	suite: DirectoryHarness,
	owner: Session,
	token: string,
	displayName: string,
): Promise<ScimGroup> {
	const response = await suite.scim({
		workspace: owner.slug,
		template: '/Groups',
		method: 'POST',
		token,
		body: { displayName },
	});
	if (response.status !== 201) {
		throw new Error(
			`Group creation failed with ${response.status}: ${await response.text()}`,
		);
	}
	return (await response.json()) as ScimGroup;
}

async function createUser(
	suite: DirectoryHarness,
	owner: Session,
	token: string,
	userName: string,
): Promise<{ id: string }> {
	const response = await suite.scim({
		workspace: owner.slug,
		template: '/Users',
		method: 'POST',
		token,
		body: { userName },
	});
	if (response.status !== 201) {
		throw new Error(`User creation failed with ${response.status}.`);
	}
	return (await response.json()) as { id: string };
}

async function map(
	suite: DirectoryHarness,
	owner: Session,
	id: string,
	roleKey: string | null,
	precedence: number,
): Promise<Response> {
	return suite.admin('/api/directory/groups/map', 'POST', owner, {
		id,
		roleKey,
		precedence,
	});
}

async function roleOf(
	suite: DirectoryHarness,
	owner: Session,
	email: string,
): Promise<string | undefined> {
	return (
		await (await suite.auth.service()).listTenantMembers(owner.tenantId)
	).find((member) => member.email === email)?.role;
}

async function changeMembers(
	suite: DirectoryHarness,
	owner: Session,
	token: string,
	groupId: string,
	operation: { op: string; value?: unknown; path?: string },
): Promise<Response> {
	return suite.scim({
		workspace: owner.slug,
		template: '/Groups/:id',
		method: 'PATCH',
		token,
		params: { id: groupId },
		body: {
			schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
			Operations: [operation],
		},
	});
}

/** A mapped role of its own, so a precedence step is visible in the walk. */
async function createRole(
	suite: DirectoryHarness,
	owner: Session,
	key: string,
): Promise<void> {
	const service = await suite.auth.service();
	const grantable = await service.listGrantableScopes(owner.tenantId);
	await service.createRole(
		{
			accountId: owner.accountId,
			tenantId: owner.tenantId,
			email: 'owner@example.com',
			role: 'owner',
			scopes: grantable,
		},
		{
			tenantId: owner.tenantId,
			key,
			name: key.toUpperCase(),
			description: 'A mapped role between owner and member.',
			scopes: grantable.slice(0, 1),
		},
	);
}

async function createLeadRole(
	suite: DirectoryHarness,
	owner: Session,
): Promise<void> {
	await createRole(suite, owner, 'lead');
}

describe('DIRECTORY-GROUP-ROLE', () => {
	it('walks precedence down to the workspace default and repeats write nothing', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		await createLeadRole(suite, owner);
		const user = await createUser(suite, owner, token.token, 'ada@example.com');
		const admins = await createGroup(suite, owner, token.token, 'Admins');
		const leads = await createGroup(suite, owner, token.token, 'Leads');
		expect((await map(suite, owner, admins.id, 'owner', 1)).status).toBe(200);
		expect((await map(suite, owner, leads.id, 'lead', 5)).status).toBe(200);

		for (const group of [admins, leads]) {
			const added = await changeMembers(suite, owner, token.token, group.id, {
				op: 'add',
				path: 'members',
				value: [{ value: user.id }],
			});
			expect(added.status).toBe(200);
		}
		expect(await roleOf(suite, owner, 'ada@example.com')).toBe('owner');

		/* Removing the lower-precedence group hands the role to the next one. */
		const removedAdmins = await changeMembers(
			suite,
			owner,
			token.token,
			admins.id,
			{ op: 'remove', path: `members[value eq "${user.id}"]` },
		);
		expect(removedAdmins.status).toBe(200);
		expect(await roleOf(suite, owner, 'ada@example.com')).toBe('lead');

		const removedLeads = await changeMembers(
			suite,
			owner,
			token.token,
			leads.id,
			{ op: 'remove', path: `members[value eq "${user.id}"]` },
		);
		expect(removedLeads.status).toBe(200);
		expect(await roleOf(suite, owner, 'ada@example.com')).toBe('member');

		const before = await provisioningEvents(suite, owner);
		const repeat = await changeMembers(suite, owner, token.token, leads.id, {
			op: 'remove',
			path: `members[value eq "${user.id}"]`,
		});
		expect(repeat.status).toBe(200);
		const after = await provisioningEvents(suite, owner);
		/* The repeat is recorded as unchanged and writes no role change. */
		expect(after.length).toBe(before.length + 1);
		expect(after[0]).toMatchObject({
			operation: 'membership-change',
			outcome: 'unchanged',
		});
		/* One entry per request, plus one per user whose role actually moved:
		   three moves, and `reason` stays empty because none was a refusal. */
		expect(
			before
				.filter((event) => event.subject === user.id)
				.map((event) => [event.operation, event.outcome, event.reason]),
		).toEqual([
			['membership-change', 'applied', null],
			['membership-change', 'applied', null],
			['membership-change', 'applied', null],
		]);
	});

	it('leaves an unmapped group without effect on the role', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		const user = await createUser(suite, owner, token.token, 'ada@example.com');
		const group = await createGroup(suite, owner, token.token, 'Everyone');
		const added = await changeMembers(suite, owner, token.token, group.id, {
			op: 'add',
			path: 'members',
			value: [{ value: user.id }],
		});
		expect(added.status).toBe(200);
		expect(await roleOf(suite, owner, 'ada@example.com')).toBe('member');
		const listed = (await (
			await suite.admin('/api/directory/groups', 'GET', owner)
		).json()) as {
			groups: {
				displayName: string;
				roleKey: string | null;
				memberCount: number;
			}[];
			roles: string[];
			defaultRole: string;
		};
		expect(listed.groups).toMatchObject([
			{ displayName: 'Everyone', roleKey: null, memberCount: 1 },
		]);
		expect(listed.roles).toContain('member');
		expect(listed.defaultRole).toBe('member');
	});

	it('applies a patch that names its attribute in the value instead of a path', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		const user = await createUser(suite, owner, token.token, 'ada@example.com');
		const group = await createGroup(suite, owner, token.token, 'Admins');

		/* The pathless spelling several providers send: the attribute is a key of
		   the value object rather than a path. */
		const renamed = await changeMembers(suite, owner, token.token, group.id, {
			op: 'replace',
			value: { displayName: 'Administrators' },
		});
		expect(renamed.status).toBe(200);
		expect(await renamed.json()).toMatchObject({
			displayName: 'Administrators',
		});

		const added = await changeMembers(suite, owner, token.token, group.id, {
			op: 'add',
			value: { members: [{ value: user.id }] },
		});
		expect(added.status).toBe(200);
		expect(await added.json()).toMatchObject({
			members: [{ value: user.id }],
		});
	});

	it('replaces the whole membership through PUT', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		await createRole(suite, owner, 'lead');
		const first = await createUser(
			suite,
			owner,
			token.token,
			'ada@example.com',
		);
		const second = await createUser(
			suite,
			owner,
			token.token,
			'grace@example.com',
		);
		const group = await createGroup(suite, owner, token.token, 'Leads');
		await map(suite, owner, group.id, 'lead', 1);
		await changeMembers(suite, owner, token.token, group.id, {
			op: 'add',
			path: 'members',
			value: [{ value: first.id }],
		});
		expect(await roleOf(suite, owner, 'ada@example.com')).toBe('lead');

		const replaced = await suite.scim({
			workspace: owner.slug,
			template: '/Groups/:id',
			method: 'PUT',
			token: token.token,
			params: { id: group.id },
			body: {
				displayName: 'Leads',
				members: [{ value: second.id }],
			},
		});
		expect(replaced.status).toBe(200);
		expect(await replaced.json()).toMatchObject({
			members: [{ value: second.id }],
		});
		/* The member that left the group falls back to the workspace default and
		   the one that joined takes the mapped role. */
		expect(await roleOf(suite, owner, 'ada@example.com')).toBe('member');
		expect(await roleOf(suite, owner, 'grace@example.com')).toBe('lead');
	});

	/* Two operations on the same member in one request: the last one wins, and
	   an add after a replace is not dropped. */
	it('applies the operations of one request in the order received', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		const first = await createUser(
			suite,
			owner,
			token.token,
			'ada@example.com',
		);
		const second = await createUser(
			suite,
			owner,
			token.token,
			'grace@example.com',
		);
		const group = await createGroup(suite, owner, token.token, 'Admins');

		const replaceThenAdd = await suite.scim({
			workspace: owner.slug,
			template: '/Groups/:id',
			method: 'PATCH',
			token: token.token,
			params: { id: group.id },
			body: {
				Operations: [
					{ op: 'replace', path: 'members', value: [{ value: first.id }] },
					{ op: 'add', path: 'members', value: [{ value: second.id }] },
				],
			},
		});
		expect(replaceThenAdd.status).toBe(200);
		expect(
			((await replaceThenAdd.json()) as ScimGroup).members
				.map((member) => member.value)
				.sort(),
		).toEqual([first.id, second.id].sort());

		const removeThenAdd = await suite.scim({
			workspace: owner.slug,
			template: '/Groups/:id',
			method: 'PATCH',
			token: token.token,
			params: { id: group.id },
			body: {
				Operations: [
					{ op: 'remove', path: `members[value eq "${first.id}"]` },
					{ op: 'add', path: 'members', value: [{ value: first.id }] },
				],
			},
		});
		expect(removeThenAdd.status).toBe(200);
		expect(
			((await removeThenAdd.json()) as ScimGroup).members.map(
				(member) => member.value,
			),
		).toContain(first.id);

		const addThenRemove = await suite.scim({
			workspace: owner.slug,
			template: '/Groups/:id',
			method: 'PATCH',
			token: token.token,
			params: { id: group.id },
			body: {
				Operations: [
					{ op: 'add', path: 'members', value: [{ value: first.id }] },
					{ op: 'remove', path: `members[value eq "${first.id}"]` },
				],
			},
		});
		expect(addThenRemove.status).toBe(200);
		expect(
			((await addThenRemove.json()) as ScimGroup).members.map(
				(member) => member.value,
			),
		).toEqual([second.id]);
	});

	/* A membership that is disabled holds no role anyone can act on, and
	   auth.core counts it out of the owner tally. */
	it('leaves a deactivated owner out of the recalculation', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		const user = await createUser(suite, owner, token.token, 'ada@example.com');
		const admins = await createGroup(suite, owner, token.token, 'Admins');
		await map(suite, owner, admins.id, 'owner', 1);
		await changeMembers(suite, owner, token.token, admins.id, {
			op: 'add',
			path: 'members',
			value: [{ value: user.id }],
		});
		const deactivated = await suite.scim({
			workspace: owner.slug,
			template: '/Users/:id',
			method: 'PATCH',
			token: token.token,
			params: { id: user.id },
			body: { Operations: [{ op: 'replace', path: 'active', value: false }] },
		});
		expect(deactivated.status).toBe(200);

		const removed = await changeMembers(suite, owner, token.token, admins.id, {
			op: 'remove',
			path: `members[value eq "${user.id}"]`,
		});
		expect(removed.status).toBe(200);
		const member = (
			await (await suite.auth.service()).listTenantMembers(owner.tenantId)
		).find((entry) => entry.email === 'ada@example.com');
		expect(member?.membershipStatus).toBe('disabled');
		expect(member?.role).toBe('owner');
	});

	/* A refused pass must leave no trace of the role changes it had to undo. */
	it('records no applied role change when the pass is rolled back', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		await createRole(suite, owner, 'lead');
		await createRole(suite, owner, 'auditor');
		const first = await createUser(
			suite,
			owner,
			token.token,
			'ada@example.com',
		);
		const second = await createUser(
			suite,
			owner,
			token.token,
			'grace@example.com',
		);
		const leads = await createGroup(suite, owner, token.token, 'Leads');
		const auditors = await createGroup(suite, owner, token.token, 'Auditors');
		await map(suite, owner, leads.id, 'lead', 1);
		await map(suite, owner, auditors.id, 'auditor', 5);
		for (const member of [first, second]) {
			await changeMembers(suite, owner, token.token, leads.id, {
				op: 'add',
				path: 'members',
				value: [{ value: member.id }],
			});
		}
		await changeMembers(suite, owner, token.token, auditors.id, {
			op: 'add',
			path: 'members',
			value: [{ value: first.id }],
		});
		suite.settings.set(
			owner.tenantId,
			'directory.core',
			'defaultRole',
			'ghost',
			'test',
		);

		const before = await provisioningEvents(suite, owner);
		const cleared = await changeMembers(suite, owner, token.token, leads.id, {
			op: 'replace',
			path: 'members',
			value: [],
		});
		expect(cleared.status).toBe(400);
		expect(await cleared.json()).toMatchObject({
			reason: 'DEFAULT_ROLE_UNKNOWN',
		});

		const after = await provisioningEvents(suite, owner);
		const added = after.slice(0, after.length - before.length);
		expect(added.map((event) => event.outcome)).toEqual(['refused']);
		expect(await roleOf(suite, owner, 'ada@example.com')).toBe('lead');
		expect(await roleOf(suite, owner, 'grace@example.com')).toBe('lead');
		const group = await suite.scim({
			workspace: owner.slug,
			template: '/Groups/:id',
			method: 'GET',
			token: token.token,
			params: { id: leads.id },
		});
		expect(((await group.json()) as ScimGroup).members).toHaveLength(2);
	});

	it('refuses a member value that names no SCIM user', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		const group = await createGroup(suite, owner, token.token, 'Admins');
		const refused = await changeMembers(suite, owner, token.token, group.id, {
			op: 'add',
			path: 'members',
			value: [{ value: 'no-such-user' }],
		});
		expect(refused.status).toBe(400);
		expect(await refused.json()).toMatchObject({ reason: 'USER_NOT_FOUND' });
	});

	it('refuses a duplicate group name with scimType uniqueness', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		await createGroup(suite, owner, token.token, 'Admins');
		const again = await suite.scim({
			workspace: owner.slug,
			template: '/Groups',
			method: 'POST',
			token: token.token,
			body: { displayName: 'admins' },
		});
		expect(again.status).toBe(409);
		expect(await again.json()).toMatchObject({
			scimType: 'uniqueness',
			reason: 'GROUP_EXISTS',
		});
	});

	it('returns the members to the workspace default when the group is deleted', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		await createLeadRole(suite, owner);
		const user = await createUser(suite, owner, token.token, 'ada@example.com');
		const leads = await createGroup(suite, owner, token.token, 'Leads');
		await map(suite, owner, leads.id, 'lead', 5);
		await changeMembers(suite, owner, token.token, leads.id, {
			op: 'add',
			path: 'members',
			value: [{ value: user.id }],
		});
		expect(await roleOf(suite, owner, 'ada@example.com')).toBe('lead');

		const deleted = await suite.scim({
			workspace: owner.slug,
			template: '/Groups/:id',
			method: 'DELETE',
			token: token.token,
			params: { id: leads.id },
		});
		expect(deleted.status).toBe(204);
		expect(await roleOf(suite, owner, 'ada@example.com')).toBe('member');
		const listed = await suite.scim({
			workspace: owner.slug,
			template: '/Groups',
			method: 'GET',
			token: token.token,
		});
		expect(await listed.json()).toMatchObject({ totalResults: 0 });
	});
});

describe('DIRECTORY-LAST-OWNER', () => {
	it('refuses deactivation and the demotion a group change would cause', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		const user = await createUser(suite, owner, token.token, 'ada@example.com');
		const admins = await createGroup(suite, owner, token.token, 'Admins');
		await map(suite, owner, admins.id, 'owner', 1);
		await changeMembers(suite, owner, token.token, admins.id, {
			op: 'add',
			path: 'members',
			value: [{ value: user.id }],
		});
		expect(await roleOf(suite, owner, 'ada@example.com')).toBe('owner');

		/* The human owner steps aside, so the provisioned user is the only active
		   owner left and every further change has to be refused. */
		const service = await suite.auth.service();
		await service.setMembershipStatus(
			scimActor(owner.tenantId, token.id),
			owner.accountId,
			'disabled',
		);

		const deactivated = await suite.scim({
			workspace: owner.slug,
			template: '/Users/:id',
			method: 'PATCH',
			token: token.token,
			params: { id: user.id },
			body: { Operations: [{ op: 'replace', path: 'active', value: false }] },
		});
		expect(deactivated.status).toBe(400);
		expect(await deactivated.json()).toMatchObject({
			scimType: 'mutability',
			reason: 'LAST_OWNER',
		});

		const demoted = await changeMembers(suite, owner, token.token, admins.id, {
			op: 'remove',
			path: `members[value eq "${user.id}"]`,
		});
		expect(demoted.status).toBe(400);
		expect(await demoted.json()).toMatchObject({ reason: 'LAST_OWNER' });

		/* The owner keeps the role, the membership and the group it came from. */
		const member = (await service.listTenantMembers(owner.tenantId)).find(
			(entry) => entry.email === 'ada@example.com',
		);
		expect(member?.role).toBe('owner');
		expect(member?.membershipStatus).toBe('active');
		const group = await suite.scim({
			workspace: owner.slug,
			template: '/Groups/:id',
			method: 'GET',
			token: token.token,
			params: { id: admins.id },
		});
		expect(await group.json()).toMatchObject({
			members: [{ value: user.id }],
		});
	});

	/**
	 * The administration screen cannot reach the same refusal: auth.core stops a
	 * non-owner from acting on an owner first, and an acting owner is itself a
	 * second active owner. What it can reach is a mapping change whose
	 * recalculation is refused partway, which has to leave nothing behind.
	 */
	it('puts the mapping and every applied role back when recalculation is refused', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		await createLeadRole(suite, owner);
		await createRole(suite, owner, 'auditor');
		const first = await createUser(
			suite,
			owner,
			token.token,
			'ada@example.com',
		);
		const second = await createUser(
			suite,
			owner,
			token.token,
			'grace@example.com',
		);
		const leads = await createGroup(suite, owner, token.token, 'Leads');
		const auditors = await createGroup(suite, owner, token.token, 'Auditors');
		await map(suite, owner, leads.id, 'lead', 1);
		await map(suite, owner, auditors.id, 'auditor', 5);
		for (const member of [first, second]) {
			await changeMembers(suite, owner, token.token, leads.id, {
				op: 'add',
				path: 'members',
				value: [{ value: member.id }],
			});
		}
		await changeMembers(suite, owner, token.token, auditors.id, {
			op: 'add',
			path: 'members',
			value: [{ value: first.id }],
		});
		expect(await roleOf(suite, owner, 'ada@example.com')).toBe('lead');
		expect(await roleOf(suite, owner, 'grace@example.com')).toBe('lead');

		/* A default role no workspace role matches: the member who falls back to
		   it is the one that makes the pass fail. */
		suite.settings.set(
			owner.tenantId,
			'directory.core',
			'defaultRole',
			'ghost',
			'test',
		);
		const cleared = await map(suite, owner, leads.id, null, 1);
		expect(cleared.status).toBe(400);
		expect(
			((await cleared.json()) as { error: { code: string } }).error.code,
		).toBe('ROLE_UNKNOWN');

		const listed = (await (
			await suite.admin('/api/directory/groups', 'GET', owner)
		).json()) as { groups: { displayName: string; roleKey: string | null }[] };
		expect(
			listed.groups.find((group) => group.displayName === 'Leads')?.roleKey,
		).toBe('lead');
		expect(await roleOf(suite, owner, 'ada@example.com')).toBe('lead');
		expect(await roleOf(suite, owner, 'grace@example.com')).toBe('lead');
	});
});

async function provisioningEvents(
	suite: DirectoryHarness,
	session: Session,
): Promise<
	{
		operation: string;
		outcome: string;
		reason: string | null;
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
				subject: string;
			}[];
		}
	).items;
}

/* A member entry as Okta and Entra echo it back: the value, the display name
   and an absolute $ref into this surface. The body ceiling has to admit a
   whole group of them, because the service provider configuration says a group
   may carry that many. */
function memberEntries(count: number, workspace: string) {
	return Array.from({ length: count }, (_unused, index) => {
		const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
		return {
			value: id,
			display: `member-${index}@example.com`,
			$ref: `https://erp.example/api/scim/v2/${workspace}/Users/${id}`,
		};
	});
}

describe('SCIM body ceiling', () => {
	it('admits a group write carrying the largest membership it allows', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		const group = await createGroup(suite, owner, token.token, 'Everyone');
		const body = {
			schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
			displayName: 'Everyone',
			members: memberEntries(1_000, owner.slug),
		};
		/* Far past the 16 KB a JSON body is otherwise bounded by, so a ceiling
		   that ignores the membership rule refuses this before reading it. */
		expect(JSON.stringify(body).length).toBeGreaterThan(100_000);

		const replaced = await suite.scim({
			workspace: owner.slug,
			template: '/Groups/:id',
			method: 'PUT',
			token: token.token,
			params: { id: group.id },
			body,
		});

		/* The body is read and the members are resolved: unknown ids are the
		   request's own problem, not the ceiling's. */
		expect(replaced.status).toBe(400);
		expect(await replaced.json()).toMatchObject({ reason: 'USER_NOT_FOUND' });
	});

	it('refuses a group write past the ceiling', async () => {
		const suite = await harness();
		const owner = await suite.signUp('owner@example.com', 'workspace-a');
		const token = await issueToken(suite, owner);
		const group = await createGroup(suite, owner, token.token, 'Everyone');

		const refused = await suite.scim({
			workspace: owner.slug,
			template: '/Groups/:id',
			method: 'PUT',
			token: token.token,
			params: { id: group.id },
			body: {
				displayName: 'Everyone',
				members: memberEntries(1_000, owner.slug),
				padding: 'x'.repeat(600_000),
			},
		});

		expect(refused.status).toBe(413);
	});
});
