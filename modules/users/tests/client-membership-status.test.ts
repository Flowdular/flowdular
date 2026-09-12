import { createContext } from '@octanejs/app-core';
import type { DatabaseProvider } from '@flowdular/database';
import { createPgliteTestProvider } from '@flowdular/database-testing';
import type { AuthActor } from '@flowdular/module-auth';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	AuthServiceError,
	createAuthRoutes,
	createAuthRuntime,
} from '@flowdular/module-auth/server';
import {
	registerModuleTranslations,
	setActiveLocale,
} from '@flowdular/client/i18n';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError, setMembershipStatus } from '../src/client/api.ts';
import { membershipStatusMessage } from '../src/client/state.ts';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';

const ORIGIN = 'https://erp.example';
const PASSWORD = 'correct horse battery staple';

interface Session {
	readonly cookie: string;
	readonly csrfToken: string;
	readonly accountId: string;
	readonly tenantId: string;
}

const opened: { runtime: AuthRuntime; databases: DatabaseProvider }[] = [];

beforeAll(() => {
	registerModuleTranslations([
		{
			moduleId: 'users.core',
			translations: { en: translationsEn, pl: translationsPl },
		},
	]);
});

afterEach(async () => {
	setActiveLocale('en');
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	for (const entry of opened.splice(0)) {
		await entry.runtime.dispose();
		await entry.databases.dispose();
	}
});

/* The auth runtime is composed from its public server entry, the same way the
   platform composes it, so every code this screen maps comes from the route
   users.core actually calls rather than from a literal in the test. */
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

function authRoute(auth: AuthRuntime, path: string) {
	const route = createAuthRoutes(auth).find(
		(candidate) =>
			candidate.path === path && candidate.methods.includes('POST'),
	);
	if (!route) throw new Error(`auth.core exposes no POST ${path}.`);
	return route;
}

async function signUp(
	auth: AuthRuntime,
	email: string,
	slug: string,
): Promise<Session> {
	const response = await authRoute(auth, '/api/auth/sign-up').handler(
		createContext(
			new Request(`${ORIGIN}/api/auth/sign-up`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: ORIGIN },
				body: JSON.stringify({
					email,
					password: PASSWORD,
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

/** The exact request the client sends, answered by the real auth route. */
async function membershipStatusResponse(
	auth: AuthRuntime,
	session: Session,
	body: unknown,
): Promise<Response> {
	const route = authRoute(auth, '/api/auth/memberships/status');
	const context = createContext(
		new Request(`${ORIGIN}/api/auth/memberships/status`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: ORIGIN,
				cookie: session.cookie,
				'x-csrf-token': session.csrfToken,
			},
			body: JSON.stringify(body),
		}),
		{},
	);
	return (await auth.middleware(context, () =>
		Promise.resolve(route.handler(context)),
	)) as Response;
}

function stubFetch(body: unknown, status = 200) {
	const fetchMock = vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			Response.json(body, { status }),
	);
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

/** Feeds a served response through the client fetch the drawer calls. */
async function clientError(served: Response): Promise<ApiError> {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => served.clone()),
	);
	return setMembershipStatus('account-1', 'disabled', 'csrf-value').then(
		() => {
			throw new Error('Expected the membership change to reject.');
		},
		(error: unknown) => error as ApiError,
	);
}

async function ownerActor(
	auth: AuthRuntime,
	session: Session,
	email: string,
): Promise<AuthActor> {
	return {
		accountId: session.accountId,
		tenantId: session.tenantId,
		email,
		role: 'owner',
		scopes: [
			...(await (await auth.service()).listGrantableScopes(session.tenantId)),
		],
	};
}

describe('USERS-MEMBERSHIP-STATUS membership status client', () => {
	it('posts the membership change to the auth administration route', async () => {
		const fetchMock = stubFetch({
			membership: { accountId: 'account-1', status: 'disabled' },
		});
		await expect(
			setMembershipStatus('account-1', 'disabled', 'csrf-value'),
		).resolves.toEqual({ accountId: 'account-1', status: 'disabled' });
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/auth/memberships/status',
			expect.objectContaining({
				method: 'POST',
				credentials: 'same-origin',
				body: JSON.stringify({
					accountId: 'account-1',
					status: 'disabled',
				}),
			}),
		);
		const options = fetchMock.mock.calls[0]![1] as RequestInit;
		const headers = new Headers(options.headers);
		expect(headers.get('x-csrf-token')).toBe('csrf-value');
		expect(headers.get('content-type')).toBe('application/json');
	});

	it('re-enables through the same route without a second call shape', async () => {
		const fetchMock = stubFetch({
			membership: { accountId: 'account-1', status: 'active' },
		});
		await expect(
			setMembershipStatus('account-1', 'active', 'csrf-value'),
		).resolves.toEqual({ accountId: 'account-1', status: 'active' });
		expect(fetchMock.mock.calls[0]![0]).toBe('/api/auth/memberships/status');
		expect((fetchMock.mock.calls[0]![1] as RequestInit).body).toBe(
			JSON.stringify({ accountId: 'account-1', status: 'active' }),
		);
	});

	it('names what to do for every code the route answers with, in both locales', async () => {
		const auth = await authRuntime();
		const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
		const service = await auth.service();
		const actor = await ownerActor(auth, owner, 'owner@example.com');
		const member = await service.createTenantMember(
			{
				tenantId: owner.tenantId,
				email: 'member@example.com',
				password: PASSWORD,
				displayName: 'Mo Member',
				role: 'member',
			},
			actor,
		);
		await service.createRole(actor, {
			tenantId: owner.tenantId,
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
		await service.assignMemberRole(actor, member.accountId, 'manager');
		const manager = await service.signIn({
			email: 'member@example.com',
			password: PASSWORD,
		});
		if ('mfaRequired' in manager) throw new Error('unexpected challenge');
		const managerSession: Session = {
			cookie: `coreloom_session_dev=${manager.token}`,
			csrfToken: manager.csrfToken,
			accountId: manager.principal.accountId,
			tenantId: manager.principal.tenantId,
		};

		/* An owner cannot change its own access to the workspace. */
		const self = await membershipStatusResponse(auth, owner, {
			accountId: owner.accountId,
			status: 'disabled',
		});
		expect(self.status).toBe(400);

		/* A manager holds users.members.manage and is still not an owner. */
		const notOwner = await membershipStatusResponse(auth, managerSession, {
			accountId: owner.accountId,
			status: 'disabled',
		});
		expect(notOwner.status).toBe(403);

		const missing = await membershipStatusResponse(auth, owner, {
			accountId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
			status: 'disabled',
		});
		expect(missing.status).toBe(404);

		/* LAST_OWNER is this call's own refusal: the workspace is down to one
		   active owner and the target is that owner. A live session of the actor
		   cannot produce it, because a signed-in owner is counted too, so the
		   actor here is the owner an operator has since blocked. */
		const second = await service.createTenantMember(
			{
				tenantId: owner.tenantId,
				email: 'second@example.com',
				password: PASSWORD,
				displayName: 'Second Owner',
				role: 'owner',
			},
			actor,
		);
		const secondActor = {
			...actor,
			accountId: second.accountId,
			email: 'second@example.com',
		};
		await service.setMemberStatus(secondActor, owner.accountId, 'disabled');
		const lastOwner = await service
			.setMembershipStatus(actor, second.accountId, 'disabled')
			.then(
				() => {
					throw new Error('Expected the last owner to be protected.');
				},
				(error: unknown) => error as AuthServiceError,
			);
		expect(lastOwner.code).toBe('LAST_OWNER');

		const mapped = {
			self: membershipStatusMessage(await clientError(self)),
			notOwner: membershipStatusMessage(await clientError(notOwner)),
			missing: membershipStatusMessage(await clientError(missing)),
			lastOwner: membershipStatusMessage(
				await clientError(
					Response.json(
						{ error: { code: lastOwner.code, message: lastOwner.message } },
						{ status: lastOwner.status },
					),
				),
			),
		};
		expect(mapped).toEqual({
			self: 'You cannot change your own access to this workspace. Ask another owner.',
			notOwner:
				"Only an owner can change another owner's access to this workspace.",
			missing: 'This member is no longer in the workspace. Refresh the list.',
			lastOwner:
				'This is the last active owner of the workspace. Give another member the owner role first.',
		});

		setActiveLocale('pl');
		expect({
			self: membershipStatusMessage(await clientError(self)),
			notOwner: membershipStatusMessage(await clientError(notOwner)),
			missing: membershipStatusMessage(await clientError(missing)),
			lastOwner: membershipStatusMessage(
				await clientError(
					Response.json(
						{ error: { code: lastOwner.code, message: lastOwner.message } },
						{ status: lastOwner.status },
					),
				),
			),
		}).toEqual({
			self: 'Nie możesz zmienić własnego dostępu do tej przestrzeni roboczej. Poproś innego właściciela.',
			notOwner:
				'Tylko właściciel może zmienić dostęp innego właściciela do tej przestrzeni roboczej.',
			missing: 'Tego członka nie ma już w przestrzeni roboczej. Odśwież listę.',
			lastOwner:
				'To ostatni aktywny właściciel przestrzeni roboczej. Najpierw nadaj rolę właściciela innemu członkowi.',
		});
	}, 60_000);

	it('carries the stable server code and status through to the drawer', async () => {
		const auth = await authRuntime();
		const owner = await signUp(auth, 'owner@example.com', 'workspace-one');
		const self = await membershipStatusResponse(auth, owner, {
			accountId: owner.accountId,
			status: 'disabled',
		});

		const error = await clientError(self);
		expect(error).toBeInstanceOf(ApiError);
		expect(error.code).toBe('SELF_TARGET');
		expect(error.status).toBe(400);
	});

	it('keeps the server sentence for an unknown code and never shows an empty one', async () => {
		const unknown = await clientError(
			Response.json(
				{ error: { code: 'SOMETHING_ELSE', message: 'Server sentence.' } },
				{ status: 400 },
			),
		);
		expect(membershipStatusMessage(unknown)).toBe('Server sentence.');
		expect(membershipStatusMessage(new Error(''))).toBe(
			'Workspace access could not be changed.',
		);
	});
});
