import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { DEFAULT_APPLICATION_BRANDING } from '@flowdular/contracts';
import { installApplicationBranding } from '@flowdular/server';
import {
	authed,
	call,
	closeAuthTestDatabases,
	jsonRequest,
	signUpOwner,
	testRuntime,
	type TestRuntime,
} from './helpers.ts';
import { authTestProvider } from './support/database.ts';

const open = new Set<TestRuntime>();

beforeAll(async () => {
	await authTestProvider();
}, 60_000);

afterEach(async () => {
	installApplicationBranding(null);
	await Promise.all([...open].map((runtime) => runtime.dispose()));
	open.clear();
});

afterAll(closeAuthTestDatabases);

async function enrol(body: Record<string, unknown>): Promise<string> {
	const runtime = await testRuntime({ mfaEncryptionKey: 'f'.repeat(64) });
	open.add(runtime);
	const owner = await signUpOwner(runtime);
	const response = await call(
		runtime,
		'/api/auth/mfa/enroll',
		jsonRequest('/api/auth/mfa/enroll', body, authed(owner)),
	);
	expect(response.status).toBe(200);
	const payload = (await response.json()) as { readonly otpauthUrl: string };
	return payload.otpauthUrl;
}

/* AUTH-MFA-ENROLL: an authenticator lists the account under the deployment's
   own name, so a rebranded workspace does not enrol its members under the
   product's. */
it('labels an enrolment with the deployment name', async () => {
	installApplicationBranding(() => ({
		...DEFAULT_APPLICATION_BRANDING,
		appName: 'Acme Operations',
	}));
	const url = await enrol({});
	expect(url).toContain('issuer=Acme%20Operations');
	expect(url).toContain('otpauth://totp/Acme%20Operations%3A');
});

/* The label is the server's answer: a caller cannot name the workspace its
   members see in their authenticator. */
it('ignores an issuer the request supplies', async () => {
	installApplicationBranding(() => ({
		...DEFAULT_APPLICATION_BRANDING,
		appName: 'Acme Operations',
	}));
	const url = await enrol({ issuer: 'Attacker Bank' });
	expect(url).not.toContain('Attacker');
	expect(url).toContain('issuer=Acme%20Operations');
});

it('falls back to the product name with no branding installed', async () => {
	const url = await enrol({});
	expect(url).toContain(
		'issuer=' + encodeURIComponent(DEFAULT_APPLICATION_BRANDING.appName),
	);
});
