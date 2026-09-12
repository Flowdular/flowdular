import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthActor } from '../src/domain/types.ts';
import {
	authed,
	call,
	closeAuthTestDatabases,
	jsonRequest,
	ORIGIN,
	signUpOwner,
	testRuntime,
	type SignedIn,
	type TestRuntime,
} from './helpers.ts';
import { authTestProvider } from './support/database.ts';

const PASSWORD = 'steady tangerine harbor';

const open = new Set<TestRuntime>();

beforeAll(async () => {
	await authTestProvider();
}, 60_000);

afterEach(async () => {
	await Promise.all([...open].map((runtime) => runtime.dispose()));
	open.clear();
});

afterAll(closeAuthTestDatabases);

function actorOf(session: SignedIn, email: string): AuthActor {
	return {
		accountId: session.accountId,
		tenantId: session.tenantId,
		email,
		role: 'owner',
		scopes: ['users.members.manage', 'auth.profile.read'],
	};
}

interface Fixture {
	readonly runtime: TestRuntime;
	readonly first: SignedIn;
	readonly second: SignedIn;
	readonly memberId: string;
}

/* One account with an active membership in two workspaces, which is the only
   shape where "per workspace" means anything. */
async function twoWorkspaces(): Promise<Fixture> {
	const runtime = await testRuntime();
	open.add(runtime);
	const first = await signUpOwner(runtime);
	const second = await signUpOwner(
		runtime,
		'second@example.com',
		'second-operations',
	);
	const member = await runtime.authService.createTenantMember(
		{
			tenantId: first.tenantId,
			email: 'shared@example.com',
			password: PASSWORD,
			displayName: 'Sam Shared',
			role: 'member',
		},
		actorOf(first, 'owner@example.com'),
	);
	const role = (await runtime.repository.findRoleByKey(
		second.tenantId,
		'member',
	))!;
	await runtime.repository.createMembershipInTenant({
		accountId: member.accountId,
		tenantId: second.tenantId,
		role: role.key,
		roleId: role.id,
		scopes: role.scopes,
		/* The second membership is the later one, so which workspace a password
		   sign-in resolves is decided by this fixture and not by a UUID. */
		createdAt: runtime.clock.now + 1_000,
	});
	return { runtime, first, second, memberId: member.accountId };
}

async function signInShared(runtime: TestRuntime): Promise<string> {
	const issued = await runtime.authService.signIn({
		email: 'shared@example.com',
		password: PASSWORD,
	});
	if ('mfaRequired' in issued) throw new Error('unexpected MFA challenge');
	return issued.token;
}

function setStatus(
	runtime: TestRuntime,
	session: SignedIn,
	body: Record<string, unknown>,
): Promise<Response> {
	return call(
		runtime,
		'/api/auth/memberships/status',
		jsonRequest('/api/auth/memberships/status', body, authed(session)),
	);
}

describe('AUTH-MEMBERSHIP-DISABLE', () => {
	it('revokes the sessions and tokens of one workspace and leaves the other working', async () => {
		const { runtime, first, second, memberId } = await twoWorkspaces();
		const service = runtime.authService;
		const inFirst = await signInShared(runtime);
		const switched = await service.switchTenant(inFirst, second.tenantId);
		const inSecond = switched.token;
		const againInFirst = await signInShared(runtime);
		const tokenOfFirst = await service.issueApiToken({
			tenantId: first.tenantId,
			accountId: memberId,
			label: 'first workspace',
			scopes: ['auth.profile.read'],
			expiresAt: null,
			createdBy: first.accountId,
		});
		const tokenOfSecond = await service.issueApiToken({
			tenantId: second.tenantId,
			accountId: memberId,
			label: 'second workspace',
			scopes: ['auth.profile.read'],
			expiresAt: null,
			createdBy: second.accountId,
		});

		const disabled = await setStatus(runtime, first, {
			accountId: memberId,
			status: 'disabled',
		});

		expect(disabled.status).toBe(200);
		expect(await disabled.json()).toEqual({
			membership: { accountId: memberId, status: 'disabled' },
		});
		expect(await service.resolveSession(againInFirst)).toBeNull();
		expect(await service.resolveApiToken(tokenOfFirst.token)).toBeNull();
		expect((await service.resolveSession(inSecond))?.principal.tenantId).toBe(
			second.tenantId,
		);
		expect((await service.resolveApiToken(tokenOfSecond.token))?.tenantId).toBe(
			second.tenantId,
		);
		/* Sign-in no longer lands in the workspace that disabled the membership. */
		const afterDisable = await signInShared(runtime);
		expect(
			(await service.resolveSession(afterDisable))?.principal.tenantId,
		).toBe(second.tenantId);
		await expect(
			service.switchTenant(afterDisable, first.tenantId),
		).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });

		const enabled = await setStatus(runtime, first, {
			accountId: memberId,
			status: 'active',
		});

		expect(enabled.status).toBe(200);
		const afterEnable = await signInShared(runtime);
		expect(
			(await service.resolveSession(afterEnable))?.principal.tenantId,
		).toBe(first.tenantId);
		/* A token revoked by the disable stays revoked. */
		expect(await service.resolveApiToken(tokenOfFirst.token)).toBeNull();
	});

	it('reports the membership status on the member list the users module reads', async () => {
		const { runtime, first, second, memberId } = await twoWorkspaces();

		await setStatus(runtime, first, {
			accountId: memberId,
			status: 'disabled',
		});

		const inFirst = await runtime.authService.listTenantMembers(first.tenantId);
		const inSecond = await runtime.authService.listTenantMembers(
			second.tenantId,
		);
		expect(
			inFirst.find((member) => member.accountId === memberId),
		).toMatchObject({ status: 'active', membershipStatus: 'disabled' });
		expect(
			inSecond.find((member) => member.accountId === memberId),
		).toMatchObject({ status: 'active', membershipStatus: 'active' });
	});

	it('appends an audit row naming the actor and the target', async () => {
		const { runtime, first, memberId } = await twoWorkspaces();

		await setStatus(runtime, first, {
			accountId: memberId,
			status: 'disabled',
		});

		const audit = await runtime.authService.queryAudit({
			tenantId: first.tenantId,
			limit: 20,
		});
		expect(
			audit.events.find((event) => event.action === 'auth.membership.status'),
		).toMatchObject({
			actorAccountId: first.accountId,
			subjectId: memberId,
			metadata: { status: 'disabled' },
		});
	});
});

describe('AUTH-MEMBERSHIP-DISABLE denials', () => {
	it('refuses without a session, without the scope and without a CSRF proof', async () => {
		const { runtime, first, memberId } = await twoWorkspaces();
		const memberSession = await runtime.authService.signIn({
			email: 'shared@example.com',
			password: PASSWORD,
		});
		if ('mfaRequired' in memberSession) throw new Error('unexpected challenge');

		const anonymous = await call(
			runtime,
			'/api/auth/memberships/status',
			jsonRequest('/api/auth/memberships/status', {
				accountId: memberId,
				status: 'disabled',
			}),
		);
		expect(anonymous.status).toBe(401);

		const withoutScope = await call(
			runtime,
			'/api/auth/memberships/status',
			jsonRequest(
				'/api/auth/memberships/status',
				{ accountId: first.accountId, status: 'disabled' },
				{
					cookie: `coreloom_session_dev=${memberSession.token}`,
					'x-csrf-token': memberSession.csrfToken,
				},
			),
		);
		expect(withoutScope.status).toBe(403);
		expect(await withoutScope.json()).toMatchObject({
			error: { code: 'FORBIDDEN' },
		});

		const withoutCsrf = await call(
			runtime,
			'/api/auth/memberships/status',
			jsonRequest(
				'/api/auth/memberships/status',
				{ accountId: memberId, status: 'disabled' },
				{ cookie: first.cookie },
			),
		);
		expect(withoutCsrf.status).toBe(403);
		expect(await withoutCsrf.json()).toMatchObject({
			error: { code: 'CSRF_REJECTED' },
		});

		const crossOrigin = await call(
			runtime,
			'/api/auth/memberships/status',
			new Request(`${ORIGIN}/api/auth/memberships/status`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: 'https://attacker.example',
					cookie: first.cookie,
					'x-csrf-token': first.csrfToken,
				},
				body: JSON.stringify({ accountId: memberId, status: 'disabled' }),
			}),
		);
		expect(crossOrigin.status).toBe(403);

		expect(
			(await runtime.authService.listTenantMembers(first.tenantId)).every(
				(member) => member.membershipStatus === 'active',
			),
		).toBe(true);
	});

	it('answers for a member of another workspace exactly as for an unknown account', async () => {
		const { runtime, second, memberId } = await twoWorkspaces();
		const third = await signUpOwner(
			runtime,
			'third@example.com',
			'third-operations',
		);

		const foreign = await setStatus(runtime, third, {
			accountId: memberId,
			status: 'disabled',
		});
		const unknown = await setStatus(runtime, third, {
			accountId: 'an-account-that-never-existed',
			status: 'disabled',
		});

		expect(foreign.status).toBe(404);
		expect(await foreign.json()).toEqual(await unknown.json());
		expect(
			(await runtime.authService.listTenantMembers(second.tenantId)).find(
				(member) => member.accountId === memberId,
			)?.membershipStatus,
		).toBe('active');
	});

	it('refuses an invalid status and the acting account itself', async () => {
		const { runtime, first, memberId } = await twoWorkspaces();

		const invalid = await setStatus(runtime, first, {
			accountId: memberId,
			status: 'suspended',
		});
		const itself = await setStatus(runtime, first, {
			accountId: first.accountId,
			status: 'disabled',
		});

		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toMatchObject({
			error: { code: 'INVALID_INPUT' },
		});
		expect(itself.status).toBe(400);
		expect(await itself.json()).toMatchObject({
			error: { code: 'SELF_TARGET' },
		});
		expect(
			(await runtime.authService.listTenantMembers(first.tenantId)).every(
				(member) => member.membershipStatus === 'active',
			),
		).toBe(true);
	});

	it('refuses a member who holds the management scope but is not an owner', async () => {
		const { runtime, first, memberId } = await twoWorkspaces();
		const actor = actorOf(first, 'owner@example.com');
		const owner = {
			...actor,
			scopes: await runtime.authService.listGrantableScopes(first.tenantId),
		};
		await runtime.authService.createRole(owner, {
			tenantId: first.tenantId,
			key: 'manager',
			name: 'Manager',
			description: 'Manages members',
			scopes: [
				'users.members.manage',
				'auth.profile.read',
				'auth.session.manage',
				'system.workspace.access',
			],
		});
		await runtime.authService.assignMemberRole(owner, memberId, 'manager');
		const manager = await runtime.authService.signIn({
			email: 'shared@example.com',
			password: PASSWORD,
		});
		if ('mfaRequired' in manager) throw new Error('unexpected challenge');

		const response = await call(
			runtime,
			'/api/auth/memberships/status',
			jsonRequest(
				'/api/auth/memberships/status',
				{ accountId: first.accountId, status: 'disabled' },
				{
					cookie: `coreloom_session_dev=${manager.token}`,
					'x-csrf-token': manager.csrfToken,
				},
			),
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: { code: 'OWNER_REQUIRED' },
		});
		expect(
			(await runtime.authService.listTenantMembers(first.tenantId)).find(
				(member) => member.accountId === first.accountId,
			)?.membershipStatus,
		).toBe('active');
	});
});

describe('AUTH-MEMBERSHIP-DISABLE last owner', () => {
	/* The guard asks whether this change would leave the workspace with no
	   active owner, so it has to read the membership it is about to change and
	   not the account block, which is a different axis the operator owns. */
	it('does nothing when an owner whose membership is already disabled is disabled again', async () => {
		const runtime = await testRuntime();
		open.add(runtime);
		const owner = await signUpOwner(runtime);
		const actor = {
			...actorOf(owner, 'owner@example.com'),
			scopes: await runtime.authService.listGrantableScopes(owner.tenantId),
		};
		const second = await runtime.authService.createTenantMember(
			{
				tenantId: owner.tenantId,
				email: 'second@example.com',
				password: PASSWORD,
				displayName: 'Second Owner',
				role: 'owner',
			},
			actor,
		);

		/* One active owner is left: the actor. The second owner's membership is
		   already disabled, so disabling it again takes nothing away. */
		expect(
			await runtime.authService.setMembershipStatus(
				actor,
				second.accountId,
				'disabled',
			),
		).toEqual({ accountId: second.accountId, status: 'disabled' });
		expect(await runtime.repository.countActiveOwners(owner.tenantId)).toBe(1);
		expect(
			await runtime.authService.setMembershipStatus(
				actor,
				second.accountId,
				'disabled',
			),
		).toEqual({ accountId: second.accountId, status: 'disabled' });

		/* An owner the operator blocked at the account level is not one of the
		   active owners either, so its membership is not held hostage. */
		const third = await runtime.authService.createTenantMember(
			{
				tenantId: owner.tenantId,
				email: 'third@example.com',
				password: PASSWORD,
				displayName: 'Third Owner',
				role: 'owner',
			},
			actor,
		);
		await runtime.repository.updateAccountStatus(third.accountId, 'disabled');
		expect(await runtime.repository.countActiveOwners(owner.tenantId)).toBe(1);
		expect(
			await runtime.authService.setMembershipStatus(
				actor,
				third.accountId,
				'disabled',
			),
		).toEqual({ accountId: third.accountId, status: 'disabled' });

		/* The workspace still has its one active owner, and it is the actor: the
		   rule the guard protects is unchanged. */
		expect(await runtime.repository.countActiveOwners(owner.tenantId)).toBe(1);
		await expect(
			runtime.authService.setMembershipStatus(
				actor,
				owner.accountId,
				'disabled',
			),
		).rejects.toMatchObject({ code: 'SELF_TARGET' });
	});
});
