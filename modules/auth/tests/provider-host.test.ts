import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverOidcProvider } from '../src/server/oidc.ts';
import {
	assertProviderHostAllowed,
	providerHostAllowlist,
} from '../src/server/provider-host.ts';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function refusal(value: string, allowlist: readonly string[] = []): unknown {
	try {
		assertProviderHostAllowed(value, allowlist, 'issuer');
	} catch (error) {
		return error;
	}
	throw new Error(`Expected ${value} to be refused.`);
}

describe('AUTH-PROVIDER-TENANT-CRUD provider host guard', () => {
	it('refuses loopback names and private, link-local and public literal addresses', () => {
		for (const value of [
			'https://localhost/issuer',
			'https://identity.local/issuer',
			'https://identity.internal/issuer',
			'https://127.0.0.1/issuer',
			'https://10.1.2.3/issuer',
			'https://172.16.4.5/issuer',
			'https://192.168.0.7/issuer',
			'https://169.254.169.254/issuer',
			'https://[::1]/issuer',
			'https://[fd00::1]/issuer',
			'https://[fe80::1]/issuer',
			'https://93.184.216.34/issuer',
			'http://identity.example/issuer',
			'https://user:secret@identity.example/issuer',
		]) {
			expect(refusal(value)).toMatchObject({
				code: 'PROVIDER_HOST_BLOCKED',
				status: 400,
			});
		}
	});

	it('accepts a public name and, with an allowlist configured, only the hosts it names', () => {
		expect(() =>
			assertProviderHostAllowed('https://identity.example', [], 'issuer'),
		).not.toThrow();

		const allowlist = providerHostAllowlist(
			' Identity.Example , other.example ',
		);
		expect(allowlist).toEqual(['identity.example', 'other.example']);
		expect(() =>
			assertProviderHostAllowed(
				'https://identity.example/issuer',
				allowlist,
				'issuer',
			),
		).not.toThrow();
		expect(
			refusal('https://elsewhere.example/issuer', allowlist),
		).toMatchObject({ code: 'PROVIDER_HOST_NOT_ALLOWLISTED', status: 400 });
	});

	it('refuses a private or non-allowlisted issuer before any request leaves', async () => {
		const fetchMock = vi.fn(async () => Response.json({}));
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			discoverOidcProvider('https://169.254.169.254'),
		).rejects.toMatchObject({ code: 'PROVIDER_HOST_BLOCKED' });
		await expect(
			discoverOidcProvider('https://elsewhere.example', ['identity.example']),
		).rejects.toMatchObject({ code: 'PROVIDER_HOST_NOT_ALLOWLISTED' });

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('refuses a discovery document that publishes an endpoint on a blocked host', async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				issuer: 'https://identity.example',
				authorization_endpoint: 'https://identity.example/authorize',
				/* A hostile or misconfigured issuer answering with an internal
				   address would otherwise become the row every sign-in fetches. */
				token_endpoint: 'https://169.254.169.254/token',
				userinfo_endpoint: 'https://identity.example/userinfo',
			}),
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			discoverOidcProvider('https://identity.example'),
		).rejects.toMatchObject({ code: 'PROVIDER_HOST_BLOCKED' });
	});

	it('stores the endpoints of a document that stays on allowed hosts', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json({
					issuer: 'https://identity.example',
					authorization_endpoint: 'https://identity.example/authorize',
					token_endpoint: 'https://identity.example/token',
					userinfo_endpoint: 'https://identity.example/userinfo',
				}),
			),
		);

		await expect(
			discoverOidcProvider('https://identity.example', ['identity.example']),
		).resolves.toEqual({
			authorizationEndpoint: 'https://identity.example/authorize',
			tokenEndpoint: 'https://identity.example/token',
			userInfoEndpoint: 'https://identity.example/userinfo',
		});
	});
});
