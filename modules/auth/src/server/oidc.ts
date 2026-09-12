import {
	createPublicKey,
	timingSafeEqual,
	verify,
	type JsonWebKey,
} from 'node:crypto';
import { AuthServiceError } from '../services/auth-service-error.ts';
import { assertProviderHostAllowed } from './provider-host.ts';
import type { OidcProvider } from './runtime.ts';

export const OIDC_REQUEST_TIMEOUT_MS = 10_000;
export const OIDC_RESPONSE_MAX_BYTES = 64 * 1024;
/* Discovery and the key set are refetched on this interval. A provider that
   rotates keys stays verifiable within it without a request per sign-in. */
const PROVIDER_KEY_TTL_MS = 10 * 60 * 1000;
/* An unknown kid may be a rotation that happened inside the window above. One
   refetch per provider per minute follows it without letting a forged kid turn
   into an outbound request per attempt. */
const KEY_REFRESH_INTERVAL_MS = 60_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_ID_TOKEN_BYTES = 8 * 1024;
const MAX_SUBJECT_LENGTH = 128;
const SUPPORTED_ALGORITHMS: ReadonlySet<string> = new Set(['RS256', 'ES256']);

/* A workspace may add providers of its own, so the number of distinct providers
   this cache can see is no longer the eight the environment configures. It is
   bounded here instead: the oldest entry goes when a new one arrives above the
   limit, and an evicted provider only pays for one more discovery. */
const PROVIDER_KEY_CACHE_LIMIT = 256;

export function oidcFailure(): AuthServiceError {
	return new AuthServiceError(
		'OIDC_AUTHENTICATION_FAILED',
		'External sign-in could not be completed.',
		401,
	);
}

/** What an administrator sees when an issuer does not verify at save time. */
export function oidcIssuerUnverified(): AuthServiceError {
	return new AuthServiceError(
		'PROVIDER_ISSUER_UNVERIFIED',
		'The issuer did not answer a discovery document naming itself.',
		400,
	);
}

/** The endpoints an issuer publishes for itself. */
export interface OidcDiscovery {
	readonly authorizationEndpoint: string;
	readonly tokenEndpoint: string;
	readonly userInfoEndpoint: string;
}

/**
 * Verifies an issuer the way every ID token is verified against it: the
 * document has to be served under the issuer and name the same issuer back.
 * The endpoints it publishes are what a tenant-owned provider is saved with,
 * so a sign-in costs no discovery request of its own.
 *
 * The issuer is host-guarded before the request leaves, and so is every
 * endpoint the document publishes: those are stored and fetched again at every
 * sign-in, so a document that answers with a loopback or literal address must
 * never become a stored row.
 */
export async function discoverOidcProvider(
	issuer: string,
	allowlist: readonly string[] = [],
): Promise<OidcDiscovery> {
	assertProviderHostAllowed(issuer, allowlist, 'issuer');
	let document: {
		readonly issuer?: unknown;
		readonly authorization_endpoint?: unknown;
		readonly token_endpoint?: unknown;
		readonly userinfo_endpoint?: unknown;
	};
	try {
		document = (await fetchJson(
			`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
		)) as typeof document;
	} catch {
		throw oidcIssuerUnverified();
	}
	if (typeof document.issuer !== 'string' || !equals(document.issuer, issuer)) {
		throw oidcIssuerUnverified();
	}
	let endpoints: OidcDiscovery;
	try {
		endpoints = {
			authorizationEndpoint: httpsUrl(document.authorization_endpoint),
			tokenEndpoint: httpsUrl(document.token_endpoint),
			userInfoEndpoint: httpsUrl(document.userinfo_endpoint),
		};
	} catch {
		throw oidcIssuerUnverified();
	}
	assertProviderHostAllowed(
		endpoints.authorizationEndpoint,
		allowlist,
		'authorizationEndpoint',
	);
	assertProviderHostAllowed(
		endpoints.tokenEndpoint,
		allowlist,
		'tokenEndpoint',
	);
	assertProviderHostAllowed(
		endpoints.userInfoEndpoint,
		allowlist,
		'userInfoEndpoint',
	);
	return endpoints;
}

/* A provider response is foreign input on the identity path: it is read with a
   declared and a streamed ceiling, so a hostile or broken endpoint cannot make
   the server hold an unbounded body. */
export async function readOidcJson(response: Response): Promise<unknown> {
	const declared = Number(response.headers.get('content-length') ?? 0);
	if (
		(Number.isFinite(declared) && declared > OIDC_RESPONSE_MAX_BYTES) ||
		!response.body
	)
		throw oidcFailure();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			total += chunk.value.byteLength;
			if (total > OIDC_RESPONSE_MAX_BYTES) {
				await reader.cancel();
				throw oidcFailure();
			}
			chunks.push(chunk.value);
		}
		return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown;
	} catch (error) {
		if (error instanceof AuthServiceError) throw error;
		throw oidcFailure();
	}
}

export interface VerifiedIdToken {
	/** The provider `sub`; the stable identity the account is linked to. */
	readonly subject: string;
}

export interface OidcVerifier {
	/** Verifies signature, issuer, audience, freshness and nonce, or throws. */
	verifyIdToken(
		provider: OidcProvider,
		idToken: string,
		nonce: string,
	): Promise<VerifiedIdToken>;
	/**
	 * Drops every key set cached for a provider id, so an updated or deleted
	 * workspace provider leaves none behind. Scanning the cache is what keeps
	 * the cached entry addressable by issuer; it is bounded by
	 * `PROVIDER_KEY_CACHE_LIMIT` and runs only when a provider row changes.
	 */
	forget(providerId: string): void;
}

interface ProviderKeys {
	readonly keys: readonly JsonWebKey[];
	readonly fetchedAt: number;
}

interface JwtHeader {
	readonly alg?: unknown;
	readonly kid?: unknown;
}

interface IdTokenClaims {
	readonly iss?: unknown;
	readonly aud?: unknown;
	readonly azp?: unknown;
	readonly exp?: unknown;
	readonly iat?: unknown;
	readonly nonce?: unknown;
	readonly sub?: unknown;
}

function equals(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left, 'utf8');
	const rightBuffer = Buffer.from(right, 'utf8');
	return (
		leftBuffer.byteLength === rightBuffer.byteLength &&
		timingSafeEqual(leftBuffer, rightBuffer)
	);
}

function decodeSegment(value: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
	} catch {
		throw oidcFailure();
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
		throw oidcFailure();
	return parsed as Record<string, unknown>;
}

function seconds(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) throw oidcFailure();
	return value * 1000;
}

async function fetchJson(url: string): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(OIDC_REQUEST_TIMEOUT_MS),
		});
	} catch {
		throw oidcFailure();
	}
	if (!response.ok) throw oidcFailure();
	return readOidcJson(response);
}

function httpsUrl(value: unknown): string {
	if (typeof value !== 'string' || value.length > 2_048) throw oidcFailure();
	try {
		if (new URL(value).protocol !== 'https:') throw new Error();
	} catch {
		throw oidcFailure();
	}
	return value;
}

/**
 * Verifies provider ID tokens against the key set the provider publishes. The
 * cache holds one entry per provider it has seen, capped at
 * `PROVIDER_KEY_CACHE_LIMIT` entries, so workspaces adding providers of their
 * own bound it by configuration rather than by traffic.
 */
export function createOidcVerifier(now: () => number = Date.now): OidcVerifier {
	const cached = new Map<string, ProviderKeys>();

	/* The issuer is part of the key: a workspace that repoints a provider at
	   another issuer must not keep verifying tokens against the key set the old
	   one published, whatever the entry's age. */
	const cacheKey = (provider: OidcProvider): string =>
		`${provider.id}\0${provider.issuer}`;

	const load = async (provider: OidcProvider): Promise<ProviderKeys> => {
		const discovery = (await fetchJson(
			`${provider.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
		)) as { readonly issuer?: unknown; readonly jwks_uri?: unknown };
		/* The document has to name the same issuer it was fetched for, or a
		   redirect could hand this server another provider's key set. */
		if (
			typeof discovery.issuer !== 'string' ||
			!equals(discovery.issuer, provider.issuer)
		)
			throw oidcFailure();
		const document = (await fetchJson(httpsUrl(discovery.jwks_uri))) as {
			readonly keys?: unknown;
		};
		if (!Array.isArray(document.keys) || document.keys.length > 32)
			throw oidcFailure();
		const keys = document.keys.filter(
			(key): key is JsonWebKey =>
				!!key && typeof key === 'object' && !Array.isArray(key),
		);
		const entry: ProviderKeys = { keys, fetchedAt: now() };
		const key = cacheKey(provider);
		cached.delete(key);
		if (cached.size >= PROVIDER_KEY_CACHE_LIMIT) {
			const oldest = cached.keys().next().value;
			if (oldest !== undefined) cached.delete(oldest);
		}
		cached.set(key, entry);
		return entry;
	};

	const keysFor = async (provider: OidcProvider): Promise<ProviderKeys> => {
		const entry = cached.get(cacheKey(provider));
		return entry && now() - entry.fetchedAt < PROVIDER_KEY_TTL_MS
			? entry
			: load(provider);
	};

	const selectKey = (
		entry: ProviderKeys,
		kid: string | null,
	): JsonWebKey | null => {
		if (kid === null) return entry.keys.length === 1 ? entry.keys[0]! : null;
		return entry.keys.find((key) => key.kid === kid) ?? null;
	};

	return {
		forget(providerId) {
			const prefix = `${providerId}\0`;
			for (const key of cached.keys()) {
				if (key.startsWith(prefix)) cached.delete(key);
			}
		},
		async verifyIdToken(provider, idToken, nonce) {
			if (
				typeof idToken !== 'string' ||
				Buffer.byteLength(idToken, 'utf8') > MAX_ID_TOKEN_BYTES
			)
				throw oidcFailure();
			const parts = idToken.split('.');
			if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2])
				throw oidcFailure();
			const header = decodeSegment(parts[0]) as JwtHeader;
			if (
				typeof header.alg !== 'string' ||
				!SUPPORTED_ALGORITHMS.has(header.alg)
			)
				throw oidcFailure();
			const kid = typeof header.kid === 'string' ? header.kid : null;
			let entry = await keysFor(provider);
			let jwk = selectKey(entry, kid);
			if (!jwk && now() - entry.fetchedAt >= KEY_REFRESH_INTERVAL_MS) {
				entry = await load(provider);
				jwk = selectKey(entry, kid);
			}
			if (!jwk) throw oidcFailure();
			/* The key has to be of the kind the header claims, so a published key
			   can never be read under another algorithm's rules. */
			if (jwk.kty !== (header.alg === 'RS256' ? 'RSA' : 'EC'))
				throw oidcFailure();
			if (header.alg === 'ES256' && jwk.crv !== 'P-256') throw oidcFailure();
			let verified = false;
			try {
				verified = verify(
					'sha256',
					Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'),
					{
						key: createPublicKey({ key: jwk, format: 'jwk' }),
						/* ES256 signatures are the raw r||s pair; RSA ignores this. */
						dsaEncoding: 'ieee-p1363',
					},
					Buffer.from(parts[2], 'base64url'),
				);
			} catch {
				throw oidcFailure();
			}
			if (!verified) throw oidcFailure();

			const claims = decodeSegment(parts[1]) as IdTokenClaims;
			if (
				typeof claims.iss !== 'string' ||
				!equals(claims.iss, provider.issuer)
			)
				throw oidcFailure();
			const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
			if (
				audiences.length > 8 ||
				!audiences.some(
					(audience) =>
						typeof audience === 'string' && equals(audience, provider.clientId),
				)
			)
				throw oidcFailure();
			/* More than one audience means the token was minted for another party
			   as well; only the authorized party may present it here. */
			if (
				audiences.length > 1 &&
				(typeof claims.azp !== 'string' ||
					!equals(claims.azp, provider.clientId))
			)
				throw oidcFailure();
			const current = now();
			if (seconds(claims.exp) + MAX_CLOCK_SKEW_MS <= current)
				throw oidcFailure();
			if (Math.abs(current - seconds(claims.iat)) > MAX_CLOCK_SKEW_MS)
				throw oidcFailure();
			if (typeof claims.nonce !== 'string' || !equals(claims.nonce, nonce))
				throw oidcFailure();
			if (
				typeof claims.sub !== 'string' ||
				claims.sub.length === 0 ||
				claims.sub.length > MAX_SUBJECT_LENGTH
			)
				throw oidcFailure();
			return { subject: claims.sub };
		},
	};
}
