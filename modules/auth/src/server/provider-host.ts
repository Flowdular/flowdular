import { isIP } from 'node:net';
import { AuthServiceError } from '../services/auth-service-error.ts';

/* auth.core leaves the deployment for an identity provider on two paths: the
   discovery request a workspace makes when it saves a provider, and the token
   and userinfo requests a sign-in makes against the endpoints that discovery
   stored. Both carry a URL a workspace administrator chose, so both are guarded
   the way agents.core guards an OpenAI-compatible base URL: HTTPS without
   credentials, never a loopback name, never a literal address, and inside
   FD_AUTH_PROVIDER_HOST_ALLOWLIST when a deployment configures one.

   Refusing every literal address covers the private and link-local ranges a
   deployment must never be pointed at (10/8, 172.16/12, 192.168/16, 127/8,
   169.254/16, fc00::/7, fe80::/10 and the rest) without resolving anything: an
   identity provider is a name, and a name is what a discovery document and an
   `iss` claim can be verified against. A name that resolves into one of those
   ranges is still reachable; the allowlist is what closes that, which is why a
   deployment that talks to workspace-configured providers should set one. */

const LOOPBACK_SUFFIXES = ['.local', '.localhost', '.internal'] as const;

/** Parses the comma-separated deployment allowlist; empty means unrestricted. */
export function providerHostAllowlist(
	value: string | undefined,
): readonly string[] {
	return [
		...new Set(
			(value ?? '')
				.split(',')
				.map((host) => host.trim().toLowerCase())
				.filter(Boolean),
		),
	];
}

function blocked(message: string): AuthServiceError {
	return new AuthServiceError('PROVIDER_HOST_BLOCKED', message, 400);
}

/**
 * Refuses a provider URL before any request is made. Returns the parsed URL so
 * a caller can use the host it just approved rather than parsing twice.
 */
export function assertProviderHostAllowed(
	value: string,
	allowlist: readonly string[],
	field: string,
): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw blocked(`${field} must be an absolute HTTPS URL.`);
	}
	const hostname = url.hostname.toLowerCase();
	/* A URL keeps an IPv6 host in its brackets, and isIP does not read them. */
	const literal = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		hostname === '' ||
		hostname === 'localhost' ||
		LOOPBACK_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
		isIP(literal) !== 0
	) {
		throw blocked(`${field} must name a public HTTPS host.`);
	}
	if (allowlist.length > 0 && !allowlist.includes(hostname)) {
		throw new AuthServiceError(
			'PROVIDER_HOST_NOT_ALLOWLISTED',
			`${field} host ${hostname} is not present in FD_AUTH_PROVIDER_HOST_ALLOWLIST.`,
			400,
		);
	}
	return url;
}
