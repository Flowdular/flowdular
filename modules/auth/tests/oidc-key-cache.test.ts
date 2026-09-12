import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOidcVerifier } from '../src/server/oidc.ts';
import type { OidcProvider } from '../src/server/runtime.ts';

const PROVIDER_ID = 'tenant-a:workforce';

function provider(issuer: string): OidcProvider {
	return {
		id: PROVIDER_ID,
		issuer,
		authorizationEndpoint: `${issuer}/authorize`,
		tokenEndpoint: `${issuer}/token`,
		userInfoEndpoint: `${issuer}/userinfo`,
		clientId: 'client-id',
		clientSecret: 'client-secret',
	};
}

function segment(value: unknown): string {
	return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/* Enough of a token to reach the key set: a supported algorithm and a kid the
   published set does not carry, so verification ends right after the lookup. */
const TOKEN = `${segment({ alg: 'RS256', kid: 'unpublished' })}.${segment({})}.signature`;

/** Answers discovery and the key set for whichever issuer is asked for. */
function issuerFetch() {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		if (url.pathname === '/.well-known/openid-configuration') {
			return Response.json({
				issuer: url.origin,
				jwks_uri: `${url.origin}/jwks`,
			});
		}
		return Response.json({ keys: [{ kty: 'RSA', kid: 'published' }] });
	});
}

function discoveryCalls(
	fetchMock: ReturnType<typeof issuerFetch>,
): readonly string[] {
	return fetchMock.mock.calls
		.map((call) => String(call[0]))
		.filter((url) => url.endsWith('/.well-known/openid-configuration'));
}

async function verify(
	verifier: ReturnType<typeof createOidcVerifier>,
	issuer: string,
): Promise<void> {
	await expect(
		verifier.verifyIdToken(provider(issuer), TOKEN, 'nonce'),
	).rejects.toMatchObject({ code: 'OIDC_AUTHENTICATION_FAILED' });
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('AUTH-PROVIDER-TENANT-CRUD provider key cache', () => {
	it('refetches when the issuer behind a provider id changes', async () => {
		const fetchMock = issuerFetch();
		vi.stubGlobal('fetch', fetchMock);
		const clock = { now: 1_000_000 };
		const verifier = createOidcVerifier(() => clock.now);

		await verify(verifier, 'https://first.example');
		expect(discoveryCalls(fetchMock)).toEqual([
			'https://first.example/.well-known/openid-configuration',
		]);

		/* Same id, same issuer, inside the ten minute window: the cached set
		   answers and nothing leaves. */
		await verify(verifier, 'https://first.example');
		expect(discoveryCalls(fetchMock)).toHaveLength(1);

		/* Same id, another issuer: the cached set belongs to the issuer that
		   published it, so it cannot answer for this one. */
		await verify(verifier, 'https://second.example');
		expect(discoveryCalls(fetchMock)).toEqual([
			'https://first.example/.well-known/openid-configuration',
			'https://second.example/.well-known/openid-configuration',
		]);
	});

	it('drops every cached key set of a provider id when it is forgotten', async () => {
		const fetchMock = issuerFetch();
		vi.stubGlobal('fetch', fetchMock);
		const clock = { now: 1_000_000 };
		const verifier = createOidcVerifier(() => clock.now);

		await verify(verifier, 'https://first.example');
		await verify(verifier, 'https://first.example');
		expect(discoveryCalls(fetchMock)).toHaveLength(1);

		verifier.forget(PROVIDER_ID);
		await verify(verifier, 'https://first.example');
		expect(discoveryCalls(fetchMock)).toHaveLength(2);

		/* Another provider's entry is untouched by the first one's eviction. */
		verifier.forget('tenant-b:workforce');
		await verify(verifier, 'https://first.example');
		expect(discoveryCalls(fetchMock)).toHaveLength(2);
	});
});
