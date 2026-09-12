import { createContext } from '@octanejs/app-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_SCOPES, MEMBER_SCOPES } from '../src/acl/scopes.ts';
import { mfaEnrolmentSatisfied } from '../src/server/mfa-enforcement.ts';
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

const open = new Set<TestRuntime>();

beforeAll(async () => {
	await authTestProvider();
}, 60_000);

afterEach(async () => {
	await Promise.all([...open].map((runtime) => runtime.dispose()));
	open.clear();
});

afterAll(closeAuthTestDatabases);

async function fixture(): Promise<TestRuntime> {
	const runtime = await testRuntime({ mfaEncryptionKey: 'f'.repeat(64) });
	open.add(runtime);
	return runtime;
}

/* A deployment that configured no MFA key: enrolment has nothing to seal a
   secret with, so nothing can satisfy the requirement. */
async function keylessFixture(): Promise<TestRuntime> {
	const runtime = await testRuntime();
	open.add(runtime);
	return runtime;
}

/* Any served path, run through the middleware chain a served request runs
   through. The stub stands in for the endpoint the gate let past, so a reply
   other than 403 means the gate did not hold the request. */
function gated(
	auth: TestRuntime,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const context = createContext(new Request(`${ORIGIN}${path}`, init), {});
	return auth.middleware(context, () =>
		Promise.resolve(new Response(null, { status: 204 })),
	) as Promise<Response>;
}

function requireMfa(auth: TestRuntime, tenantId: string, value: boolean): void {
	auth.moduleSettings.set(tenantId, 'auth.core', 'requireMfa', value, 'test');
}

/* A settings write exactly as the settings screen sends it: session cookie,
   CSRF proof, and the JSON body naming the setting it targets. */
function settingsWrite(
	auth: TestRuntime,
	owner: SignedIn,
	body: Record<string, unknown>,
): Promise<Response> {
	return gated(auth, '/api/settings/update', {
		method: 'POST',
		headers: { ...authed(owner), 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}

/* A workspace API that is not part of the enrolment exchange. The audit read is
   one of auth.core's own, which is the strongest case: even the module that
   owns the gate answers nothing until enrolment is done. */
function workspaceApi(auth: TestRuntime, session: SignedIn): Promise<Response> {
	return call(
		auth,
		'/api/auth/audit',
		new Request(`${ORIGIN}/api/auth/audit`, {
			headers: { cookie: session.cookie },
		}),
	);
}

async function confirmFactor(
	auth: TestRuntime,
	accountId: string,
): Promise<void> {
	await auth.repository.upsertMfaTotp(
		accountId,
		{ keyId: 'key-id', ciphertext: 'ciphertext' },
		auth.clock.now,
	);
	await auth.repository.confirmMfaTotp(accountId, auth.clock.now);
}

describe('tenant MFA enrolment enforcement', () => {
	it('answers a workspace API while the workspace does not require enrolment', async () => {
		const auth = await fixture();
		const owner = await signUpOwner(auth);

		expect((await workspaceApi(auth, owner)).status).toBe(200);
	});

	it('holds an unenrolled member at enrolment with a stable problem', async () => {
		const auth = await fixture();
		const owner = await signUpOwner(auth);
		requireMfa(auth, owner.tenantId, true);

		const denied = await workspaceApi(auth, owner);

		expect(denied.status).toBe(403);
		expect(await denied.json()).toEqual({
			error: {
				code: 'MFA_ENROLMENT_REQUIRED',
				message:
					'This workspace requires multi-factor authentication. Enrol an authenticator to continue.',
			},
		});
	});

	it('keeps the routes that complete enrolment reachable', async () => {
		const auth = await fixture();
		const owner = await signUpOwner(auth);
		requireMfa(auth, owner.tenantId, true);

		const session = await call(
			auth,
			'/api/auth/session',
			new Request(`${ORIGIN}/api/auth/session`, {
				headers: { cookie: owner.cookie },
			}),
		);
		const status = await call(
			auth,
			'/api/auth/mfa/status',
			new Request(`${ORIGIN}/api/auth/mfa/status`, {
				headers: { cookie: owner.cookie },
			}),
		);
		const enrolment = await call(
			auth,
			'/api/auth/mfa/enroll',
			jsonRequest('/api/auth/mfa/enroll', {}, authed(owner)),
		);

		expect(session.status).toBe(200);
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({
			required: true,
			enrolled: false,
		});
		expect(enrolment.status).toBe(200);
	});

	it('answers the workspace API again once a factor is confirmed', async () => {
		const auth = await fixture();
		const owner = await signUpOwner(auth);
		requireMfa(auth, owner.tenantId, true);
		expect((await workspaceApi(auth, owner)).status).toBe(403);

		await confirmFactor(auth, owner.accountId);

		expect((await workspaceApi(auth, owner)).status).toBe(200);
	});

	it('holds only the workspace whose setting requires enrolment', async () => {
		const auth = await fixture();
		const held = await signUpOwner(auth, 'held@example.com', 'held-workspace');
		const other = await signUpOwner(auth, 'free@example.com', 'free-workspace');
		requireMfa(auth, held.tenantId, true);

		expect((await workspaceApi(auth, held)).status).toBe(403);
		expect((await workspaceApi(auth, other)).status).toBe(200);
	});

	/* The shell offers an account menu entry only when the principal holds its
	   scope, and only an offered entry is a reachable view. The account security
	   contribution is gated on this scope, so losing it here would leave a held
	   member with no way to enrol. */
	it('grants every member the scope the account security view is gated on', () => {
		expect(MEMBER_SCOPES).toContain(AUTH_SCOPES.sessionManage);
	});

	/* Turning the requirement on closes the workspace API to everyone who has
	   not enrolled, and the settings screen is the only way back off. Holding
	   the read and the reversal would leave the workspace with no way back;
	   opening the write by path would hand a held owner every other setting. */
	it('keeps the settings read and the reversal reachable and holds every other write', async () => {
		const auth = await fixture();
		const owner = await signUpOwner(auth);
		requireMfa(auth, owner.tenantId, true);

		const read = await gated(auth, '/api/settings', {
			headers: { cookie: owner.cookie },
		});
		const reversal = await settingsWrite(auth, owner, {
			moduleId: 'auth.core',
			key: 'requireMfa',
			value: false,
		});
		const otherSetting = await settingsWrite(auth, owner, {
			moduleId: 'auth.core',
			key: 'allowSignUp',
			value: false,
		});
		const other = await gated(auth, '/api/system/modules', {
			headers: { cookie: owner.cookie },
		});

		expect([read.status, reversal.status]).toEqual([204, 204]);
		expect(otherSetting.status).toBe(403);
		expect(await otherSetting.json()).toMatchObject({
			error: { code: 'MFA_ENROLMENT_REQUIRED' },
		});
		expect(other.status).toBe(403);
	});

	/* The gate reads the body to decide, so the endpoint behind it still has to
	   find an unconsumed request, and a body the gate cannot read targets
	   nothing and stays held. */
	it('leaves the write body readable behind the gate and holds an unreadable one', async () => {
		const auth = await fixture();
		const owner = await signUpOwner(auth);
		requireMfa(auth, owner.tenantId, true);
		const context = createContext(
			new Request(`${ORIGIN}/api/settings/update`, {
				method: 'POST',
				headers: { ...authed(owner), 'content-type': 'application/json' },
				body: JSON.stringify({
					moduleId: 'auth.core',
					key: 'requireMfa',
					value: false,
				}),
			}),
			{},
		);

		const echoed = (await auth.middleware(context, async () =>
			Response.json(await context.request.json()),
		)) as Response;
		const malformed = await gated(auth, '/api/settings/update', {
			method: 'POST',
			headers: { ...authed(owner), 'content-type': 'application/json' },
			body: 'not json',
		});

		expect(await echoed.json()).toMatchObject({
			moduleId: 'auth.core',
			key: 'requireMfa',
			value: false,
		});
		expect(malformed.status).toBe(403);
	});

	/* A service account has no browser and cannot enrol anything, and its
	   authority is already bounded by the live membership. Holding it would
	   close the workspace to every integration with no way out. */
	it('answers an API token in a workspace that requires enrolment', async () => {
		const auth = await fixture();
		const owner = await signUpOwner(auth);
		requireMfa(auth, owner.tenantId, true);
		const issued = await auth.authService.issueApiToken({
			tenantId: owner.tenantId,
			accountId: owner.accountId,
			label: 'Reporting job',
			scopes: [AUTH_SCOPES.auditRead],
			expiresAt: null,
			createdBy: owner.accountId,
		});

		const machine = await gated(auth, '/api/users/members', {
			headers: { authorization: `Bearer ${issued.token}` },
		});
		const browser = await gated(auth, '/api/users/members', {
			headers: { cookie: owner.cookie },
		});

		expect(machine.status).toBe(204);
		expect(browser.status).toBe(403);
	});

	it('leaves an anonymous request to the endpoint it addressed', async () => {
		const auth = await fixture();
		const owner = await signUpOwner(auth);
		requireMfa(auth, owner.tenantId, true);

		const anonymous = await call(
			auth,
			'/api/auth/audit',
			new Request(`${ORIGIN}/api/auth/audit`),
		);

		expect(anonymous.status).toBe(401);
	});
});

/* Without a deployment key enrolment answers 503, so a workspace that turned
   the requirement on would answer nothing to anyone and could never satisfy
   it. The write is refused where the setting is stored, the way email
   confirmation is refused without a composed mail transport. */
describe('requireMfa without a deployment MFA key', () => {
	it('refuses the setting and leaves the workspace answering', async () => {
		const auth = await keylessFixture();
		const owner = await signUpOwner(auth);

		expect(() => requireMfa(auth, owner.tenantId, true)).toThrow(
			expect.objectContaining({ code: 'MFA_KEY_REQUIRED', status: 409 }),
		);
		expect(
			auth.moduleSettings.get<boolean>(
				owner.tenantId,
				'auth.core',
				'requireMfa',
			),
		).toBe(false);
		expect((await workspaceApi(auth, owner)).status).toBe(200);
	});

	it('still accepts turning the requirement off and every other setting', async () => {
		const auth = await keylessFixture();
		const owner = await signUpOwner(auth);

		expect(() => requireMfa(auth, owner.tenantId, false)).not.toThrow();
		expect(() =>
			auth.moduleSettings.set(
				owner.tenantId,
				'auth.core',
				'requireMfa',
				null,
				'test',
			),
		).not.toThrow();
		expect(() =>
			auth.moduleSettings.set(
				owner.tenantId,
				'auth.core',
				'defaultLocale',
				'pl',
				'test',
			),
		).not.toThrow();
	});

	it('accepts the setting once a key is configured', async () => {
		const auth = await fixture();
		const owner = await signUpOwner(auth);

		expect(() => requireMfa(auth, owner.tenantId, true)).not.toThrow();
		expect((await workspaceApi(auth, owner)).status).toBe(403);
	});
});

describe('mfaEnrolmentSatisfied', () => {
	it('answers for the surfaces that resolve an identity of their own', async () => {
		const auth = await fixture();
		const owner = await signUpOwner(auth);
		const principal = {
			accountId: owner.accountId,
			tenantId: owner.tenantId,
		} as Parameters<typeof mfaEnrolmentSatisfied>[1];

		expect(await mfaEnrolmentSatisfied(auth, principal)).toBe(true);
		requireMfa(auth, owner.tenantId, true);
		expect(await mfaEnrolmentSatisfied(auth, principal)).toBe(false);
		await confirmFactor(auth, owner.accountId);
		expect(await mfaEnrolmentSatisfied(auth, principal)).toBe(true);
	});

	/* A workspace that requires nothing must not pay a factor lookup per page. */
	it('asks the service nothing while the workspace requires no enrolment', async () => {
		const satisfied = await mfaEnrolmentSatisfied(
			{
				tenantSettings: () => Promise.resolve({ requireMfa: false }),
				service: () => Promise.reject(new Error('must not be opened')),
			},
			{ accountId: 'account', tenantId: 'tenant' } as Parameters<
				typeof mfaEnrolmentSatisfied
			>[1],
		);

		expect(satisfied).toBe(true);
	});
});
