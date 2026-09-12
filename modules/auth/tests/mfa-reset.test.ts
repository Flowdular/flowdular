import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashSessionToken } from '../src/services/auth-service.ts';
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
const MEMBER_PASSWORD = 'steady tangerine harbor';

/* The code hash is the primary key of the recovery table, so two members in
   one case need two codes. */
function recoveryCode(email: string): string {
	return createHash('sha256')
		.update(email)
		.digest('hex')
		.slice(0, 20)
		.toUpperCase();
}

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

async function enrolledMember(
	auth: TestRuntime,
	owner: SignedIn,
	email = 'member@example.com',
): Promise<SignedIn> {
	const service = await auth.service();
	const member = await service.createTenantMember({
		tenantId: owner.tenantId,
		email,
		password: MEMBER_PASSWORD,
		displayName: 'Mem Ber',
		role: 'member',
	});
	/* The session is issued before the factor exists: a confirmed factor turns
	   sign-in into a challenge, and these cases need a live member session. */
	const response = await call(
		auth,
		'/api/auth/sign-in',
		jsonRequest('/api/auth/sign-in', {
			email,
			password: MEMBER_PASSWORD,
		}),
	);
	const body = (await response.json()) as { csrfToken: string };
	await auth.repository.upsertMfaTotp(
		member.accountId,
		{ keyId: 'key-id', ciphertext: 'ciphertext' },
		auth.clock.now,
	);
	await auth.repository.confirmMfaTotp(member.accountId, auth.clock.now);
	await auth.repository.replaceMfaRecoveryCodes(
		member.accountId,
		[hashSessionToken(recoveryCode(email))],
		auth.clock.now,
	);
	return {
		cookie: response.headers.get('set-cookie')!.split(';')[0]!,
		csrfToken: body.csrfToken,
		accountId: member.accountId,
		tenantId: owner.tenantId,
	};
}

function reset(
	auth: TestRuntime,
	headers: Record<string, string>,
	accountId: unknown,
): Promise<Response> {
	return call(
		auth,
		'/api/auth/mfa/reset',
		jsonRequest('/api/auth/mfa/reset', { accountId }, headers),
	);
}

describe('administrative MFA reset', () => {
	it('clears the factor and every recovery code and records the actor', async () => {
		const auth = await fixture();
		const owner = await signUpOwner(auth);
		const member = await enrolledMember(auth, owner);

		const response = await reset(auth, authed(owner), member.accountId);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ reset: true });
		expect(await auth.repository.findMfaTotp(member.accountId)).toBeNull();
		expect(
			await auth.repository.consumeMfaRecoveryCode(
				member.accountId,
				hashSessionToken(recoveryCode('member@example.com')),
			),
		).toBe(false);
		const trail = await auth.authService.queryAudit({
			tenantId: owner.tenantId,
			action: 'auth.mfa.reset',
			limit: 10,
		});
		expect(trail.events).toHaveLength(1);
		expect(trail.events[0]).toMatchObject({
			action: 'auth.mfa.reset',
			actorAccountId: owner.accountId,
			subjectType: 'account',
			subjectId: member.accountId,
		});
	});

	it('lets the member enrol again after the reset', async () => {
		const auth = await fixture();
		const owner = await signUpOwner(auth);
		const member = await enrolledMember(auth, owner);
		await reset(auth, authed(owner), member.accountId);

		const enrolment = await call(
			auth,
			'/api/auth/mfa/enroll',
			jsonRequest('/api/auth/mfa/enroll', {}, authed(member)),
		);

		expect(enrolment.status).toBe(200);
	});

	it('denies a member that does not manage members', async () => {
		const auth = await fixture();
		const owner = await signUpOwner(auth);
		const member = await enrolledMember(auth, owner);
		const other = await enrolledMember(auth, owner, 'other@example.com');

		const denied = await reset(auth, authed(member), other.accountId);

		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({
			error: { code: 'FORBIDDEN' },
		});
		expect(await auth.repository.findMfaTotp(other.accountId)).not.toBeNull();
	});

	it('denies a request without a session and without a CSRF proof', async () => {
		const auth = await fixture();
		const owner = await signUpOwner(auth);
		const member = await enrolledMember(auth, owner);

		const anonymous = await reset(auth, {}, member.accountId);
		const forged = await reset(
			auth,
			{ cookie: owner.cookie, 'x-csrf-token': 'not-the-token' },
			member.accountId,
		);

		expect(anonymous.status).toBe(401);
		expect(forged.status).toBe(403);
		expect(await forged.json()).toMatchObject({
			error: { code: 'CSRF_REJECTED' },
		});
		expect(await auth.repository.findMfaTotp(member.accountId)).not.toBeNull();
	});

	it('answers for an account of another workspace exactly as for an unknown one', async () => {
		const auth = await fixture();
		const owner = await signUpOwner(auth);
		const member = await enrolledMember(auth, owner);
		const outsider = await signUpOwner(
			auth,
			'outsider@example.com',
			'outsider-workspace',
		);

		const foreign = await reset(auth, authed(outsider), member.accountId);
		const unknown = await reset(
			auth,
			authed(outsider),
			'00000000-0000-4000-8000-000000000000',
		);

		expect(foreign.status).toBe(404);
		expect(await foreign.json()).toEqual(await unknown.json());
		expect(unknown.status).toBe(404);
		expect(await auth.repository.findMfaTotp(member.accountId)).not.toBeNull();
	});

	it('refuses the acting account as its own target', async () => {
		const auth = await fixture();
		const owner = await signUpOwner(auth);

		const denied = await reset(auth, authed(owner), owner.accountId);

		expect(denied.status).toBe(400);
		expect(await denied.json()).toMatchObject({
			error: { code: 'SELF_TARGET' },
		});
	});

	it('bounds the account identifier', async () => {
		const auth = await fixture();
		const owner = await signUpOwner(auth);

		const empty = await reset(auth, authed(owner), '');
		const oversized = await reset(auth, authed(owner), 'x'.repeat(129));
		const wrongType = await reset(auth, authed(owner), 42);

		for (const response of [empty, oversized, wrongType]) {
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: { code: 'INVALID_INPUT' },
			});
		}
	});
});
