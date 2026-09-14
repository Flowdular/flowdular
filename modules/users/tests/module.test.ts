import { createContext } from '@octanejs/app-core';
import type { DatabaseProvider } from '@flowdular/database';
import { createPgliteTestProvider } from '@flowdular/database-testing';
import type { TenantMember } from '@flowdular/module-auth';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	AUDIT_ACTIONS,
	createAuthRoutes,
	createAuthRuntime,
} from '@flowdular/module-auth/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createUserRoutes } from '../src/api/endpoints.ts';
import { UsersService } from '../src/services/users-service.ts';
import { moduleDefinition } from '../src/index.ts';

const ORIGIN = 'https://erp.example';

const opened: { runtime: AuthRuntime; databases: DatabaseProvider }[] = [];

/* One routes instance per runtime: the cursor secret lives in it, so a cursor a
   page answered is only valid on the routes that signed it. */
const routes = new WeakMap<AuthRuntime, ReturnType<typeof createUserRoutes>>();

function userRoutes(auth: AuthRuntime) {
	let existing = routes.get(auth);
	if (!existing) {
		existing = createUserRoutes(auth);
		routes.set(auth, existing);
	}
	return existing;
}

afterEach(async () => {
	for (const entry of opened.splice(0)) {
		await entry.runtime.dispose();
		await entry.databases.dispose();
	}
});

/* The auth runtime is composed from its public server entry over an embedded
   PostgreSQL, the same way the platform composes it, so these tests exercise
   the real administration port and never reach into auth.core internals. */
async function authRuntime(): Promise<AuthRuntime> {
	const databases = createPgliteTestProvider();
	const runtime = createAuthRuntime({
		databases,
		purpose: 'test',
		secureCookies: false,
		cookieName: 'coreloom_session_dev',
		sessionTtlMs: 3_600_000,
		sessionIdleMs: 3_600_000,
		passwordMinLength: 12,
		allowSignUp: true,
		emailConfirmation: false,
		signInProviders: [],
	});
	opened.push({ runtime, databases });
	return runtime;
}

interface Session {
	readonly cookie: string;
	readonly csrfToken: string;
	readonly accountId: string;
	readonly tenantId: string;
}

interface MemberPage {
	readonly items: readonly TenantMember[];
	readonly page: { readonly nextCursor: string | null; readonly limit: number };
}

interface ErrorBody {
	readonly error?: { readonly code: string };
}

async function signUp(
	auth: AuthRuntime,
	email: string,
	slug: string,
): Promise<Session> {
	const signUpRoute = createAuthRoutes(auth).find(
		(route) => route.path === '/api/auth/sign-up',
	)!;
	const response = await signUpRoute.handler(
		createContext(
			new Request(`${ORIGIN}/api/auth/sign-up`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: ORIGIN },
				body: JSON.stringify({
					email,
					password: 'correct horse battery staple',
					displayName: 'Owner Person',
					organizationName: 'Workspace',
					organizationSlug: slug,
				}),
			}),
			{},
		),
	);
	const body = (await response.json()) as {
		csrfToken: string;
		principal: { accountId: string; tenantId: string };
	};
	return {
		cookie: response.headers.get('set-cookie')!.split(';')[0]!,
		csrfToken: body.csrfToken,
		accountId: body.principal.accountId,
		tenantId: body.principal.tenantId,
	};
}

async function callUsers(
	auth: AuthRuntime,
	path: string,
	method: string,
	session: Session | null,
	body?: unknown,
): Promise<Response> {
	const route = userRoutes(auth).find(
		(candidate) =>
			candidate.path === path.replace(/\?.*$/, '') &&
			candidate.methods.includes(method),
	)!;
	const request = new Request(`${ORIGIN}${path}`, {
		method,
		headers: {
			'content-type': 'application/json',
			origin: ORIGIN,
			...(session
				? { cookie: session.cookie, 'x-csrf-token': session.csrfToken }
				: {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const context = createContext(request, {});
	// Run the auth middleware the platform registers so the principal is set.
	await auth.middleware(context, async () => new Response(null));
	return route.handler(context);
}

/* The member drawer's Reset MFA action posts to auth.core's administration
   route with the same member management scope the users API requires. */
async function callAuthMutation(
	auth: AuthRuntime,
	path: string,
	session: Session | null,
	body: unknown,
): Promise<Response> {
	const route = createAuthRoutes(auth).find(
		(candidate) =>
			candidate.path === path && candidate.methods.includes('POST'),
	);
	if (!route) throw new Error(`auth.core exposes no POST ${path}.`);
	const context = createContext(
		new Request(`${ORIGIN}${path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: ORIGIN,
				...(session
					? { cookie: session.cookie, 'x-csrf-token': session.csrfToken }
					: {}),
			},
			body: JSON.stringify(body),
		}),
		{},
	);
	return (await auth.middleware(context, () =>
		Promise.resolve(route.handler(context)),
	)) as Response;
}

async function signInMember(
	auth: AuthRuntime,
	email: string,
	password: string,
): Promise<Session> {
	const issued = await (await auth.service()).signIn({ email, password });
	return {
		cookie: `coreloom_session_dev=${issued.token}`,
		csrfToken: issued.csrfToken,
		accountId: issued.principal.accountId,
		tenantId: issued.principal.tenantId,
	};
}

describe('users.core', () => {
	it('exports its validated identity', () => {
		expect(moduleDefinition.manifest.id).toBe('users.core');
	});

	it('lists one page of members and answers the screen context separately', async () => {
		const auth = await authRuntime();
		const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
		const response = await callUsers(auth, '/api/users', 'GET', owner);
		expect(response.status).toBe(200);
		const body = (await response.json()) as MemberPage;
		expect(body.items.map((user) => user.email)).toEqual(['owner@example.com']);
		expect(body.items[0]?.scopes).toContain('users.members.manage');
		expect(body.page).toEqual({ nextCursor: null, limit: 50 });
		expect(Object.keys(body).sort()).toEqual(['items', 'page']);

		const context = await callUsers(auth, '/api/users/context', 'GET', owner);
		expect(context.status).toBe(200);
		const screen = (await context.json()) as {
			roles: { key: string }[];
			grantableScopes: string[];
			actor: { accountId: string; role: string };
			passwordMinLength: number;
			memberCount: number;
			ownerCount: number;
		};
		expect(screen.roles.map((role) => role.key)).toEqual(['owner', 'member']);
		expect(screen.grantableScopes).toContain('auth.roles.manage');
		expect(screen.actor).toEqual({ accountId: owner.accountId, role: 'owner' });
		expect(screen.passwordMinLength).toBe(12);
		expect(screen.memberCount).toBe(1);
		expect(screen.ownerCount).toBe(1);
		expect((await callUsers(auth, '/api/users', 'GET', null)).status).toBe(401);
		expect(
			(await callUsers(auth, '/api/users/context', 'GET', null)).status,
		).toBe(401);
	});

	/* USERS-PAGE: the walk, the cursor's binding and the refusals. */
	describe('USERS-PAGE', () => {
		const NAMES = ['Dana', 'bea', 'Cal', 'ada', 'Eli'];

		async function workspaceOfSix() {
			const auth = await authRuntime();
			const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
			for (const name of NAMES) {
				const created = await callUsers(auth, '/api/users', 'POST', owner, {
					email: `${name.toLowerCase()}@example.com`,
					password: 'steady tangerine harbor',
					displayName: name,
					role: 'member',
				});
				expect(created.status).toBe(201);
			}
			return { auth, owner };
		}

		async function page(
			auth: AuthRuntime,
			session: Session,
			query: Record<string, string>,
		): Promise<{ status: number; body: MemberPage & ErrorBody }> {
			const response = await callUsers(
				auth,
				'/api/users?' + new URLSearchParams(query).toString(),
				'GET',
				session,
			);
			return {
				status: response.status,
				body: (await response.json()) as MemberPage & ErrorBody,
			};
		}

		it('walks every member once, in order, with a cursor on full pages only', async () => {
			const { auth, owner } = await workspaceOfSix();
			const first = await page(auth, owner, { limit: '4' });
			expect(first.status).toBe(200);
			expect(first.body.items.map((user) => user.displayName)).toEqual([
				'ada',
				'bea',
				'Cal',
				'Dana',
			]);
			expect(first.body.page.limit).toBe(4);
			expect(first.body.page.nextCursor).not.toBeNull();

			const second = await page(auth, owner, {
				limit: '4',
				cursor: first.body.page.nextCursor!,
			});
			expect(second.status).toBe(200);
			expect(second.body.items.map((user) => user.displayName)).toEqual([
				'Eli',
				'Owner Person',
			]);
			/* Two rows in a page of four: the walk ends here. */
			expect(second.body.page.nextCursor).toBeNull();

			const descending = await page(auth, owner, {
				limit: '3',
				sort: 'email',
				direction: 'desc',
			});
			expect(descending.body.items.map((user) => user.email)).toEqual([
				'owner@example.com',
				'eli@example.com',
				'dana@example.com',
			]);
			const rest = await page(auth, owner, {
				limit: '3',
				sort: 'email',
				direction: 'desc',
				cursor: descending.body.page.nextCursor!,
			});
			expect(rest.body.items.map((user) => user.email)).toEqual([
				'cal@example.com',
				'bea@example.com',
				'ada@example.com',
			]);
			/* A full last page still carries a cursor; the page after it is empty. */
			expect(rest.body.page.nextCursor).not.toBeNull();
			const past = await page(auth, owner, {
				limit: '3',
				sort: 'email',
				direction: 'desc',
				cursor: rest.body.page.nextCursor!,
			});
			expect(past.body.items).toEqual([]);
			expect(past.body.page.nextCursor).toBeNull();
		});

		it('narrows by a prefix and by membership status in the query', async () => {
			const { auth, owner } = await workspaceOfSix();
			const byName = await page(auth, owner, { q: 'DA' });
			expect(byName.body.items.map((user) => user.displayName)).toEqual([
				'Dana',
			]);
			const byAddress = await page(auth, owner, { q: 'owner@' });
			expect(byAddress.body.items.map((user) => user.email)).toEqual([
				'owner@example.com',
			]);
			const service = await auth.service();
			const cal = (await service.listTenantMembers(owner.tenantId)).find(
				(member) => member.displayName === 'Cal',
			)!;
			await service.setMembershipStatus(
				{
					accountId: owner.accountId,
					tenantId: owner.tenantId,
					email: 'owner@example.com',
					role: 'owner',
					scopes: ['users.members.manage'],
				},
				cal.accountId,
				'disabled',
			);
			const disabled = await page(auth, owner, { status: 'disabled' });
			expect(disabled.body.items.map((user) => user.displayName)).toEqual([
				'Cal',
			]);
			const active = await page(auth, owner, { status: 'active', limit: '2' });
			expect(active.body.items.map((user) => user.displayName)).toEqual([
				'ada',
				'bea',
			]);
			const activeRest = await page(auth, owner, {
				status: 'active',
				limit: '2',
				cursor: active.body.page.nextCursor!,
			});
			expect(activeRest.body.items.map((user) => user.displayName)).toEqual([
				'Dana',
				'Eli',
			]);
		});

		it('refuses a tampered, foreign, re-sorted or re-filtered cursor and bad paging input', async () => {
			const { auth, owner } = await workspaceOfSix();
			const other = await signUp(auth, 'other@example.com', 'workspace-two');
			const first = await page(auth, owner, { limit: '1', q: 'a' });
			const cursor = first.body.page.nextCursor!;
			const refused = async (
				session: Session,
				query: Record<string, string>,
			) => {
				const answer = await page(auth, session, query);
				expect(answer.status).toBe(400);
				return answer.body.error?.code;
			};

			expect(
				await refused(owner, { limit: '1', q: 'a', cursor: cursor + 'x' }),
			).toBe('CURSOR_INVALID');
			expect(
				await refused(owner, {
					limit: '1',
					q: 'a',
					cursor: cursor.replace(/^c1\.[^.]+/, 'c1.eyJ0IjoieCJ9'),
				}),
			).toBe('CURSOR_INVALID');
			expect(await refused(other, { limit: '1', q: 'a', cursor })).toBe(
				'CURSOR_INVALID',
			);
			expect(
				await refused(owner, { limit: '1', q: 'a', sort: 'email', cursor }),
			).toBe('CURSOR_INVALID');
			expect(
				await refused(owner, { limit: '1', q: 'a', direction: 'desc', cursor }),
			).toBe('CURSOR_INVALID');
			expect(await refused(owner, { limit: '1', q: 'ab', cursor })).toBe(
				'CURSOR_INVALID',
			);
			expect(await refused(owner, { limit: '1', cursor })).toBe(
				'CURSOR_INVALID',
			);
			expect(
				await refused(owner, { limit: '1', q: 'a', status: 'active', cursor }),
			).toBe('CURSOR_INVALID');
			/* The same cursor on the same listing still answers. */
			expect(
				(await page(auth, owner, { limit: '1', q: 'a', cursor })).status,
			).toBe(200);

			/* The filters are digested into the cursor, so the longest term the
			   server accepts still leaves room for the keyset. */
			const long = 'ż'.repeat(200);
			expect(long.length).toBe(200);
			const named = await callUsers(auth, '/api/users', 'POST', owner, {
				email: `${long}@example.com`,
				password: 'steady tangerine harbor',
				displayName: 'Long Address',
				role: 'member',
			});
			expect(named.status).toBe(201);
			const longPage = await page(auth, owner, { limit: '1', q: long });
			expect(longPage.status).toBe(200);
			expect(longPage.body.items).toHaveLength(1);
			expect(longPage.body.page.nextCursor).not.toBeNull();
			expect(
				(
					await page(auth, owner, {
						limit: '1',
						q: long,
						cursor: longPage.body.page.nextCursor!,
					})
				).status,
			).toBe(200);

			expect(await refused(owner, { sort: 'role' })).toBe('INVALID_INPUT');
			expect(await refused(owner, { direction: 'up' })).toBe('INVALID_INPUT');
			expect(await refused(owner, { status: 'gone' })).toBe('INVALID_INPUT');
			expect(await refused(owner, { limit: '0' })).toBe('INVALID_INPUT');
			expect(await refused(owner, { limit: '201' })).toBe('INVALID_INPUT');
			expect(await refused(owner, { q: 'a'.repeat(201) })).toBe(
				'INVALID_INPUT',
			);
		});
	});

	describe('bulk member actions', () => {
		type Outcome = {
			accountId: string;
			outcome: string;
			reason?: string;
		};

		async function createMember(
			auth: AuthRuntime,
			owner: Session,
			name: string,
		): Promise<string> {
			const created = await callUsers(auth, '/api/users', 'POST', owner, {
				email: `${name}@example.com`,
				password: 'steady tangerine harbor',
				displayName: name,
				role: 'member',
			});
			expect(created.status).toBe(201);
			return ((await created.json()) as { user: { accountId: string } }).user
				.accountId;
		}

		async function membership(
			auth: AuthRuntime,
			session: Session,
			accountId: string,
		) {
			const listed = (await (
				await callUsers(auth, '/api/users?limit=200', 'GET', session)
			).json()) as MemberPage;
			return listed.items.find((user) => user.accountId === accountId);
		}

		async function auditSubjects(
			auth: AuthRuntime,
			tenantId: string,
			action: string,
		): Promise<string[]> {
			const page = await (
				await auth.service()
			).queryAudit({ tenantId, action, limit: 100 });
			return page.events.map((event) => event.subjectId).sort();
		}

		it('USERS-STATUS-MANY refuses bad bounds, the wrong permission and a missing CSRF proof before any write', async () => {
			const auth = await authRuntime();
			const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
			const member = await createMember(auth, owner, 'plain');
			for (const body of [
				{ accountIds: [], status: 'disabled' },
				{ accountIds: 'x', status: 'disabled' },
				{
					accountIds: Array.from({ length: 101 }, (_, i) => `id-${i}`),
					status: 'disabled',
				},
				{ accountIds: [member, member], status: 'disabled' },
				{ accountIds: [member], status: 'gone' },
				{ accountIds: [member] },
			]) {
				const refused = await callUsers(
					auth,
					'/api/users/status-many',
					'POST',
					owner,
					body,
				);
				expect(refused.status).toBe(400);
				expect(await refused.json()).toMatchObject({
					error: { code: 'INVALID_INPUT' },
				});
			}
			expect(
				(
					await callUsers(auth, '/api/users/role-many', 'POST', owner, {
						accountIds: [member],
					})
				).status,
			).toBe(400);

			const csrf = await callUsers(
				auth,
				'/api/users/status-many',
				'POST',
				{ ...owner, csrfToken: 'wrong-token' },
				{ accountIds: [member], status: 'disabled' },
			);
			expect(csrf.status).toBe(403);
			expect(await csrf.json()).toMatchObject({
				error: { code: 'CSRF_REJECTED' },
			});
			const plain = await signInMember(
				auth,
				'plain@example.com',
				'steady tangerine harbor',
			);
			expect(
				(
					await callUsers(auth, '/api/users/status-many', 'POST', plain, {
						accountIds: [owner.accountId],
						status: 'disabled',
					})
				).status,
			).toBe(403);
			expect(
				(
					await callUsers(auth, '/api/users/role-many', 'POST', null, {
						accountIds: [member],
						role: 'member',
					})
				).status,
			).toBe(401);
			expect((await membership(auth, owner, member))?.membershipStatus).toBe(
				'active',
			);
		});

		it('USERS-STATUS-MANY answers one outcome per id and touches only the members it may', async () => {
			const auth = await authRuntime();
			const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
			const other = await signUp(auth, 'other@example.com', 'workspace-two');
			const first = await createMember(auth, owner, 'first');
			const second = await createMember(auth, owner, 'second');

			const response = await callUsers(
				auth,
				'/api/users/status-many',
				'POST',
				owner,
				{
					accountIds: [
						first,
						'not-a-member',
						other.accountId,
						owner.accountId,
						second,
					],
					status: 'disabled',
				},
			);
			expect(response.status).toBe(200);
			expect(
				((await response.json()) as { outcomes: Outcome[] }).outcomes,
			).toEqual([
				{ accountId: first, outcome: 'updated' },
				{ accountId: 'not-a-member', outcome: 'not-found' },
				{ accountId: other.accountId, outcome: 'not-found' },
				{
					accountId: owner.accountId,
					outcome: 'refused',
					reason: 'SELF_TARGET',
				},
				{ accountId: second, outcome: 'updated' },
			]);
			expect((await membership(auth, owner, first))?.membershipStatus).toBe(
				'disabled',
			);
			expect((await membership(auth, owner, second))?.membershipStatus).toBe(
				'disabled',
			);
			expect(
				(await membership(auth, owner, owner.accountId))?.membershipStatus,
			).toBe('active');
			expect(
				(await membership(auth, other, other.accountId))?.membershipStatus,
			).toBe('active');
			/* One audit event per updated row, none for the refused or missing. */
			expect(
				await auditSubjects(
					auth,
					owner.tenantId,
					AUDIT_ACTIONS.membershipStatus,
				),
			).toEqual([first, second].sort());
		});

		it('USERS-ROLE-MANY assigns per id under the owner cap and records each row', async () => {
			const auth = await authRuntime();
			const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
			const first = await createMember(auth, owner, 'first');
			const second = await createMember(auth, owner, 'second');
			const manager = await createMember(auth, owner, 'manager');
			await (
				await auth.service()
			).setMembershipScopes(
				{
					accountId: owner.accountId,
					tenantId: owner.tenantId,
					email: 'owner@example.com',
					role: 'owner',
					scopes: [],
				},
				manager,
				[
					'users.members.read',
					'users.members.manage',
					'system.workspace.access',
				],
			);
			const managerSession = await signInMember(
				auth,
				'manager@example.com',
				'steady tangerine harbor',
			);

			/* A non-owner may neither hand out the owner role nor touch an owner,
			   and each refusal is its own outcome. */
			const capped = await callUsers(
				auth,
				'/api/users/role-many',
				'POST',
				managerSession,
				{ accountIds: [first, owner.accountId], role: 'owner' },
			);
			expect(capped.status).toBe(200);
			expect(
				((await capped.json()) as { outcomes: Outcome[] }).outcomes,
			).toEqual([
				{ accountId: first, outcome: 'refused', reason: 'OWNER_REQUIRED' },
				{
					accountId: owner.accountId,
					outcome: 'refused',
					reason: 'OWNER_REQUIRED',
				},
			]);
			expect((await membership(auth, owner, first))?.role).toBe('member');

			const promoted = await callUsers(
				auth,
				'/api/users/role-many',
				'POST',
				owner,
				{
					accountIds: [first, 'not-a-member', owner.accountId, second],
					role: 'owner',
				},
			);
			expect(promoted.status).toBe(200);
			expect(
				((await promoted.json()) as { outcomes: Outcome[] }).outcomes,
			).toEqual([
				{ accountId: first, outcome: 'updated' },
				{ accountId: 'not-a-member', outcome: 'not-found' },
				{
					accountId: owner.accountId,
					outcome: 'refused',
					reason: 'SELF_TARGET',
				},
				{ accountId: second, outcome: 'updated' },
			]);
			expect((await membership(auth, owner, first))?.role).toBe('owner');
			expect((await membership(auth, owner, second))?.role).toBe('owner');
			expect((await membership(auth, owner, manager))?.role).toBe('member');
			expect(
				await auditSubjects(auth, owner.tenantId, AUDIT_ACTIONS.memberRole),
			).toEqual([first, second].sort());
		});

		/* LAST_OWNER cannot come from a live session: a signed-in owner is
		   counted as an active owner, so two owners may always act on each other.
		   It is the refusal of the owner an operator has since blocked, whose
		   sessions the block deleted, so the bulk paths are driven through the
		   service with that owner's principal, as the single-row case is. */
		it('USERS-STATUS-MANY and USERS-ROLE-MANY refuse the last active owner per id and record nothing for it', async () => {
			const auth = await authRuntime();
			const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
			const secondOwner = await callUsers(auth, '/api/users', 'POST', owner, {
				email: 'second@example.com',
				password: 'steady tangerine harbor',
				displayName: 'Second Owner',
				role: 'owner',
			});
			expect(secondOwner.status).toBe(201);
			const second = (
				(await secondOwner.json()) as { user: { accountId: string } }
			).user.accountId;
			const first = await createMember(auth, owner, 'first');
			const third = await createMember(auth, owner, 'third');
			const fourth = await createMember(auth, owner, 'fourth');
			const service = await auth.service();
			const issued = await service.signIn({
				email: 'owner@example.com',
				password: 'correct horse battery staple',
			});
			if ('mfaRequired' in issued) throw new Error('unexpected challenge');

			const secondSession = await signInMember(
				auth,
				'second@example.com',
				'steady tangerine harbor',
			);
			const blocked = await callUsers(
				auth,
				'/api/users/status',
				'POST',
				secondSession,
				{ accountId: owner.accountId, status: 'disabled' },
			);
			expect(blocked.status).toBe(200);

			const users = new UsersService(auth);
			expect(
				await users.setMembershipStatusMany(
					issued.principal,
					[first, second, third],
					'disabled',
				),
			).toEqual([
				{ accountId: first, outcome: 'updated' },
				{ accountId: second, outcome: 'refused', reason: 'LAST_OWNER' },
				{ accountId: third, outcome: 'updated' },
			]);
			expect(
				await users.assignRoleMany(
					issued.principal,
					[fourth, second],
					'member',
				),
			).toEqual([
				{ accountId: fourth, outcome: 'updated' },
				{ accountId: second, outcome: 'refused', reason: 'LAST_OWNER' },
			]);
			expect(
				(await membership(auth, secondSession, second))?.membershipStatus,
			).toBe('active');
			expect((await membership(auth, secondSession, second))?.role).toBe(
				'owner',
			);
			expect(
				await auditSubjects(
					auth,
					owner.tenantId,
					AUDIT_ACTIONS.membershipStatus,
				),
			).toEqual([first, third].sort());
			expect(
				await auditSubjects(auth, owner.tenantId, AUDIT_ACTIONS.memberRole),
			).toEqual([fourth]);
		});
	});

	it('caps owner creation to owners and denies token principals', async () => {
		const auth = await authRuntime();
		const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
		const created = await callUsers(auth, '/api/users', 'POST', owner, {
			email: 'manager@example.com',
			password: 'quiet lantern voyage',
			displayName: 'Man Ager',
			role: 'member',
		});
		expect(created.status).toBe(201);
		const manager = ((await created.json()) as { user: { accountId: string } })
			.user;
		await (
			await auth.service()
		).setMembershipScopes(
			{
				accountId: owner.accountId,
				tenantId: owner.tenantId,
				email: 'owner@example.com',
				role: 'owner',
				scopes: [],
			},
			manager.accountId,
			['users.members.read', 'users.members.manage', 'system.workspace.access'],
		);
		const managerSession = await signInMember(
			auth,
			'manager@example.com',
			'quiet lantern voyage',
		);
		const escalation = await callUsers(
			auth,
			'/api/users',
			'POST',
			managerSession,
			{
				email: 'evil@example.com',
				password: 'brisk copper meadow',
				displayName: 'Evil Owner',
				role: 'owner',
			},
		);
		expect(escalation.status).toBe(403);
		expect(await escalation.json()).toMatchObject({
			error: { code: 'OWNER_REQUIRED' },
		});
		const promote = await callUsers(
			auth,
			'/api/users/role',
			'POST',
			managerSession,
			{
				accountId: manager.accountId,
				role: 'owner',
			},
		);
		expect(promote.status).toBe(400);
		const editOwner = await callUsers(
			auth,
			'/api/users/update',
			'POST',
			managerSession,
			{ accountId: owner.accountId, displayName: 'Hijacked' },
		);
		expect(editOwner.status).toBe(403);
		const capped = await callUsers(
			auth,
			'/api/users/scopes',
			'POST',
			managerSession,
			{ accountId: owner.accountId, scopes: ['auth.tokens.manage'] },
		);
		expect(capped.status).toBe(403);

		const token = await (
			await auth.service()
		).issueApiToken({
			tenantId: owner.tenantId,
			accountId: owner.accountId,
			label: 'Automation',
			scopes: ['users.members.manage'],
			expiresAt: null,
			createdBy: owner.accountId,
		});
		const route = createUserRoutes(auth).find(
			(candidate) =>
				candidate.path === '/api/users/status' &&
				candidate.methods.includes('POST'),
		)!;
		const context = createContext(
			new Request(`${ORIGIN}/api/users/status`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: ORIGIN,
					authorization: `Bearer ${token.token}`,
				},
				body: JSON.stringify({
					accountId: manager.accountId,
					status: 'disabled',
				}),
			}),
			{},
		);
		await auth.middleware(context, async () => new Response(null));
		const viaToken = await route.handler(context);
		expect(viaToken.status).toBe(403);
		expect(await viaToken.json()).toMatchObject({
			error: { code: 'TOKEN_MUTATION_DENIED' },
		});
	});

	it('keeps member administration inside the acting tenant', async () => {
		const auth = await authRuntime();
		const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
		const other = await signUp(auth, 'other@example.com', 'workspace-two');
		const foreign = await callUsers(auth, '/api/users/update', 'POST', other, {
			accountId: owner.accountId,
			displayName: 'Renamed by a stranger',
		});
		expect(foreign.status).toBe(404);
		const disable = await callUsers(auth, '/api/users/status', 'POST', other, {
			accountId: owner.accountId,
			status: 'disabled',
		});
		expect(disable.status).toBe(404);
		const remove = await callUsers(auth, '/api/users/remove', 'POST', other, {
			accountId: owner.accountId,
		});
		expect(remove.status).toBe(404);
		const list = (await (
			await callUsers(auth, '/api/users', 'GET', other)
		).json()) as MemberPage;
		expect(list.items.map((user) => user.email)).toEqual(['other@example.com']);
	});

	it('resets a member password and forces a change at the next sign-in', async () => {
		const auth = await authRuntime();
		const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
		const created = await callUsers(auth, '/api/users', 'POST', owner, {
			email: 'member@example.com',
			password: 'steady tangerine harbor',
			displayName: 'Mem Ber',
			role: 'member',
		});
		const member = ((await created.json()) as { user: { accountId: string } })
			.user;
		const reset = await callUsers(
			auth,
			'/api/users/password-reset',
			'POST',
			owner,
			{ accountId: member.accountId, temporaryPassword: 'temporary pass 1234' },
		);
		expect(reset.status).toBe(200);
		const resetText = await reset.text();
		expect(JSON.parse(resetText)).toMatchObject({
			user: { passwordChangeRequired: true },
		});
		expect(resetText).not.toContain('temporary pass');
		const session = await (
			await auth.service()
		).signIn({
			email: 'member@example.com',
			password: 'temporary pass 1234',
		});
		expect(session.passwordChangeRequired).toBe(true);
		const removed = await callUsers(auth, '/api/users/remove', 'POST', owner, {
			accountId: member.accountId,
		});
		expect(removed.status).toBe(200);
		expect(
			await (await auth.service()).resolveSession(session.token),
		).toBeNull();
	});

	it('USERS-MEMBERSHIP-STATUS: disables one workspace membership and leaves the account and the other workspace alone', async () => {
		const auth = await authRuntime();
		const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
		await signUp(auth, 'other@example.com', 'workspace-two');
		const created = await callUsers(auth, '/api/users', 'POST', owner, {
			email: 'member@example.com',
			password: 'steady tangerine harbor',
			displayName: 'Mem Ber',
			role: 'member',
		});
		const member = ((await created.json()) as { user: { accountId: string } })
			.user;
		const service = await auth.service();
		const elsewhere = await service.provisionMember({
			workspace: 'workspace-two',
			email: 'member@example.com',
			role: 'member',
			operator: 'tests',
		});
		const session = await service.signIn({
			email: 'member@example.com',
			password: 'steady tangerine harbor',
		});
		const token = await service.issueApiToken({
			tenantId: owner.tenantId,
			accountId: member.accountId,
			label: 'Workspace one automation',
			scopes: ['system.workspace.access'],
			expiresAt: null,
			createdBy: owner.accountId,
		});

		const disabled = await callAuthMutation(
			auth,
			'/api/auth/memberships/status',
			owner,
			{ accountId: member.accountId, status: 'disabled' },
		);
		expect(disabled.status).toBe(200);
		expect(await disabled.json()).toEqual({
			membership: { accountId: member.accountId, status: 'disabled' },
		});
		expect(await service.resolveSession(session.token)).toBeNull();
		expect(await service.resolveApiToken(token.token)).toBeNull();

		const listed = (await (
			await callUsers(auth, '/api/users', 'GET', owner)
		).json()) as MemberPage;
		const row = listed.items.find(
			(user) => user.accountId === member.accountId,
		)!;
		expect(row.membershipStatus).toBe('disabled');
		/* The global block is the operator's and stays where it was. */
		expect(row.status).toBe('active');

		const elsewhereMembers = await service.listTenantMembers(
			elsewhere.workspace.tenantId,
		);
		expect(
			elsewhereMembers.find((user) => user.accountId === member.accountId)
				?.membershipStatus,
		).toBe('active');

		/* Refused outright or resolved to the workspace that still has them; what
		   must never happen again is a session in the workspace that disabled it. */
		const landed = await service
			.signIn({
				email: 'member@example.com',
				password: 'steady tangerine harbor',
			})
			.then((issued) => issued.principal.tenantId)
			.catch(() => null);
		expect(landed).not.toBe(owner.tenantId);

		const enabled = await callAuthMutation(
			auth,
			'/api/auth/memberships/status',
			owner,
			{ accountId: member.accountId, status: 'active' },
		);
		expect(enabled.status).toBe(200);
		const restored = (await (
			await callUsers(auth, '/api/users', 'GET', owner)
		).json()) as MemberPage;
		expect(
			restored.items.find((user) => user.accountId === member.accountId)
				?.membershipStatus,
		).toBe('active');
		await expect(
			service.signIn({
				email: 'member@example.com',
				password: 'steady tangerine harbor',
			}),
		).resolves.toMatchObject({ principal: { tenantId: owner.tenantId } });
		/* Re-enabling restores sign-in, never a revoked token. */
		expect(await service.resolveApiToken(token.token)).toBeNull();
	});

	it('USERS-MEMBERSHIP-STATUS: refuses the acting principal, a foreign account, and an anonymous caller', async () => {
		const auth = await authRuntime();
		const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
		const other = await signUp(auth, 'other@example.com', 'workspace-two');

		const itself = await callAuthMutation(
			auth,
			'/api/auth/memberships/status',
			owner,
			{ accountId: owner.accountId, status: 'disabled' },
		);
		expect(itself.ok).toBe(false);
		expect(await itself.json()).toMatchObject({
			error: { code: 'SELF_TARGET' },
		});

		const foreign = await callAuthMutation(
			auth,
			'/api/auth/memberships/status',
			owner,
			{ accountId: other.accountId, status: 'disabled' },
		);
		expect(foreign.ok).toBe(false);
		expect(await foreign.json()).toMatchObject({
			error: { code: 'ACCOUNT_NOT_FOUND' },
		});

		const anonymous = await callAuthMutation(
			auth,
			'/api/auth/memberships/status',
			null,
			{ accountId: other.accountId, status: 'disabled' },
		);
		expect(anonymous.status).toBe(401);
		const untouched = (await (
			await callUsers(auth, '/api/users', 'GET', other)
		).json()) as MemberPage;
		expect(untouched.items[0]?.membershipStatus).toBe('active');
	});

	it('clears another member MFA factor for a member manager and denies the rest', async () => {
		const auth = await authRuntime();
		const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
		const created = await callUsers(auth, '/api/users', 'POST', owner, {
			email: 'member@example.com',
			password: 'steady tangerine harbor',
			displayName: 'Mem Ber',
			role: 'member',
		});
		const member = ((await created.json()) as { user: { accountId: string } })
			.user;
		const memberSession = await signInMember(
			auth,
			'member@example.com',
			'steady tangerine harbor',
		);

		const allowed = await callAuthMutation(auth, '/api/auth/mfa/reset', owner, {
			accountId: member.accountId,
		});
		const denied = await callAuthMutation(
			auth,
			'/api/auth/mfa/reset',
			memberSession,
			{ accountId: owner.accountId },
		);
		const anonymous = await callAuthMutation(
			auth,
			'/api/auth/mfa/reset',
			null,
			{
				accountId: member.accountId,
			},
		);

		expect(allowed.status).toBe(200);
		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
		expect(anonymous.status).toBe(401);
	});
});
