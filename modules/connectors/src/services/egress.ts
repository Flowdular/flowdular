import { lookup, Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ConnectorEgressCapability } from '../domain/egress.ts';

/*
 * The address classification below, blockedIpv4, blockedAddress and
 * normalizeHost, is byte-for-byte the block notifications.core delivers
 * webhooks under, and so is the pinned lookup further down. The policy around
 * them is this module's own and deliberately differs: a call-time assertHttps
 * for a base URL a workspace saved before the rule, and an allowlist built from
 * the instance's own host list rather than a comma separated environment value.
 * The shared parts are the promotion candidate for packages/server; they stay
 * copied until the platform owns one egress policy both modules call.
 */

export type ConnectorEgressErrorCode =
	| 'CONNECTOR_URL_INVALID'
	| 'CONNECTOR_URL_BLOCKED'
	| 'CONNECTOR_HOST_NOT_ALLOWLISTED'
	| 'CONNECTOR_HOST_UNRESOLVED'
	| 'CONNECTOR_HOST_RESOLVES_PRIVATE';

export class ConnectorEgressError extends Error {
	constructor(
		readonly code: ConnectorEgressErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'ConnectorEgressError';
	}
}

/* ---------------------------------------------------------------------------
 * Address block. blockedIpv4, ipv6Bytes and blockedAddress are byte-for-byte
 * identical in the three modules that refuse private network destinations:
 * connectors.core (connector calls and the egress capability),
 * notifications.core (webhook delivery) and agents.core (OpenAI-compatible
 * provider hosts). Change all three or none, and keep the address-block test
 * cases of each module the same.
 * ------------------------------------------------------------------------- */

function blockedIpv4(value: string): boolean {
	const parts = value.split('.').map(Number);
	if (
		parts.length !== 4 ||
		parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
	) {
		return true;
	}
	const [a, b, c] = parts as [number, number, number, number];
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 192 && b === 0 && (c === 0 || c === 2)) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224
	);
}

/* Sixteen bytes of an IPv6 address, or null when it does not parse. Prefix
   checks run on bytes because the text form has many spellings of one
   address. */
function ipv6Bytes(value: string): number[] | null {
	let text = value;
	let tail: number[] = [];
	const lastColon = text.lastIndexOf(':');
	if (text.slice(lastColon + 1).includes('.')) {
		const v4 = text.slice(lastColon + 1);
		if (isIP(v4) !== 4) return null;
		tail = v4.split('.').map(Number);
		text = `${text.slice(0, lastColon + 1)}0:0`;
	}
	const halves = text.split('::');
	if (halves.length > 2) return null;
	const groups = (half: string) => (half === '' ? [] : half.split(':'));
	const head = groups(halves[0]!);
	const rest = halves.length === 2 ? groups(halves[1]!) : [];
	const missing = 8 - head.length - rest.length;
	if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
	const all = [...head, ...Array<string>(missing).fill('0'), ...rest];
	const bytes: number[] = [];
	for (const group of all) {
		if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
		const word = Number.parseInt(group, 16);
		bytes.push(word >> 8, word & 0xff);
	}
	if (tail.length === 4) bytes.splice(12, 4, ...tail);
	return bytes;
}

/** True for loopback, link-local, private, multicast, reserved and documentation addresses, including IPv4 carried inside IPv6. */
export function blockedAddress(value: string): boolean {
	if (isIP(value) === 4) return blockedIpv4(value);
	if (isIP(value) !== 6) return true;
	const bytes = ipv6Bytes(value.toLowerCase().split('%')[0]!);
	if (!bytes) return true;
	const embedded = (from: number) => bytes.slice(from, from + 4).join('.');
	const zero = (from: number, to: number) =>
		bytes.slice(from, to).every((byte) => byte === 0);
	if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
		return blockedIpv4(embedded(12));
	}
	/* ::/96 holds the unspecified, loopback and IPv4-compatible forms. */
	if (zero(0, 12)) return true;
	/* NAT64 64:ff9b::/96 reaches the embedded IPv4 through a translator;
	   64:ff9b:1::/48 is the local-use NAT64 prefix. */
	if (
		bytes[0] === 0x00 &&
		bytes[1] === 0x64 &&
		bytes[2] === 0xff &&
		bytes[3] === 0x9b
	) {
		return zero(4, 12) ? blockedIpv4(embedded(12)) : true;
	}
	/* 6to4 2002::/16 carries an IPv4 in bytes 2 to 5. */
	if (bytes[0] === 0x20 && bytes[1] === 0x02) return blockedIpv4(embedded(2));
	/* Teredo 2001::/32 and documentation 2001:db8::/32. */
	if (bytes[0] === 0x20 && bytes[1] === 0x01) {
		if (bytes[2] === 0x00 && bytes[3] === 0x00) return true;
		if (bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
	}
	/* Discard-only 100::/64. */
	if (bytes[0] === 0x01 && zero(1, 8)) return true;
	return (
		(bytes[0]! & 0xfe) === 0xfc ||
		(bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) ||
		(bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) ||
		bytes[0] === 0xff
	);
}

/* ------------------------ end of the address block ----------------------- */

export function connectorHostAllowlist(
	hosts: readonly string[],
): ReadonlySet<string> {
	return new Set(
		hosts.map((host) => host.trim().toLowerCase()).filter(Boolean),
	);
}

/* URL.hostname keeps the brackets around an IPv6 literal, and isIP does not
   accept them, so both checks would miss `https://[::1]/` without this. */
export function normalizeHost(hostname: string): string {
	const lowered = hostname.toLowerCase();
	return lowered.startsWith('[') && lowered.endsWith(']')
		? lowered.slice(1, -1)
		: lowered;
}

export interface ResolvedAddress {
	readonly address: string;
}

/**
 * How a hostname becomes addresses. The default asks the system resolver; a
 * test injects its own so a local server can be reached without an environment
 * flag ever weakening the check in a deployment.
 */
export type HostAddressResolver = (
	hostname: string,
) => Promise<readonly ResolvedAddress[]>;

export const systemHostResolver: HostAddressResolver = (hostname) =>
	lookup(hostname, { all: true, verbatim: true });

/* ---------------------------------------------------------------------------
 * Pinned egress. This block is byte-for-byte identical in both modules that
 * own this policy, connectors.core and notifications.core. Change both or
 * neither: they run the same rule, and this block is the first piece to
 * promote into packages/server once the platform owns one egress policy.
 * ------------------------------------------------------------------------- */

/** What `net.connect` asks before it opens a socket. */
export type PinnedLookup = (
	hostname: string,
	options: { readonly all?: boolean | undefined },
	callback: (
		error: Error | null,
		address: string | { address: string; family: number }[],
		family?: number,
	) => void,
) => void;

/**
 * Answers only the addresses the policy already accepted for this host name.
 * A connection opened through it cannot reach an address a second resolution
 * would return, which is what closes the window between the check and the
 * socket: a name answering publicly once and privately a moment later is no
 * longer reachable. The host name is untouched, so the Host header, the TLS
 * server name and certificate verification stay exactly as they were.
 */
export function pinnedLookup(
	hostname: string,
	addresses: readonly ResolvedAddress[],
): PinnedLookup {
	const expected = normalizeHost(hostname);
	const pinned = addresses.map((entry) => ({
		address: entry.address,
		family: isIP(entry.address),
	}));
	return (asked, options, callback) => {
		const first = pinned[0];
		if (!first || normalizeHost(asked) !== expected) {
			callback(new Error(`No verified address is pinned for ${asked}.`), '', 0);
			return;
		}
		if (options.all === true) {
			callback(null, pinned);
			return;
		}
		callback(null, first.address, first.family);
	};
}

/* ------------------------- end of the shared block ----------------------- */

export interface ConnectorEgressPolicy {
	readonly allowlist: ReadonlySet<string>;
	/** Save-time check: scheme, shape and allowlist. Throws on refusal. */
	assertUrl(value: string): URL;
	/**
	 * Call-time scheme check. The save-time rule already refused anything but
	 * https, so this catches a row written before that rule and a caller that
	 * reached the call path without one.
	 */
	assertHttps(url: URL): void;
	/**
	 * Resolution check, repeated before every call. Throws on refusal, and
	 * answers the addresses it accepted so the connection can be pinned to
	 * exactly them.
	 */
	assertResolvable(hostname: string): Promise<readonly ResolvedAddress[]>;
}

export interface ConnectorEgressPolicyOptions {
	readonly allowlist?: ReadonlySet<string> | undefined;
	readonly resolve?: HostAddressResolver | undefined;
}

export function createConnectorEgressPolicy(
	options: ConnectorEgressPolicyOptions = {},
): ConnectorEgressPolicy {
	const allowlist = options.allowlist ?? new Set<string>();
	const resolve = options.resolve ?? systemHostResolver;
	return {
		allowlist,
		assertUrl(value) {
			let url: URL;
			try {
				url = new URL(value);
			} catch {
				throw new ConnectorEgressError(
					'CONNECTOR_URL_INVALID',
					'The connector base URL is not a valid absolute URL.',
				);
			}
			const hostname = normalizeHost(url.hostname);
			if (
				url.protocol !== 'https:' ||
				url.username ||
				url.password ||
				!hostname ||
				hostname === 'localhost' ||
				hostname.endsWith('.local') ||
				hostname.endsWith('.localhost') ||
				isIP(hostname) !== 0
			) {
				throw new ConnectorEgressError(
					'CONNECTOR_URL_BLOCKED',
					'A connector base URL must be an https URL to a public host name.',
				);
			}
			if (allowlist.size > 0 && !allowlist.has(hostname)) {
				throw new ConnectorEgressError(
					'CONNECTOR_HOST_NOT_ALLOWLISTED',
					`Host ${hostname} is not on the connector host allowlist.`,
				);
			}
			return url;
		},
		assertHttps(url) {
			if (url.protocol !== 'https:') {
				throw new ConnectorEgressError(
					'CONNECTOR_URL_BLOCKED',
					'A connector call must be an https request.',
				);
			}
		},
		async assertResolvable(hostname) {
			const normalized = normalizeHost(hostname);
			if (allowlist.size > 0 && !allowlist.has(normalized)) {
				throw new ConnectorEgressError(
					'CONNECTOR_HOST_NOT_ALLOWLISTED',
					`Host ${normalized} is not on the connector host allowlist.`,
				);
			}
			let addresses: readonly ResolvedAddress[];
			try {
				addresses = await resolve(normalized);
			} catch {
				/* A name that no longer resolves is a different operational fact from
				   one that resolves into a blocked range; the call log keeps them apart. */
				throw new ConnectorEgressError(
					'CONNECTOR_HOST_UNRESOLVED',
					`Host ${normalized} could not be resolved.`,
				);
			}
			/* Every returned address is checked, not just the first: a host that
			   answers with one public and one loopback address is still refused. */
			if (
				addresses.length === 0 ||
				addresses.some((entry) => blockedAddress(entry.address))
			) {
				throw new ConnectorEgressError(
					'CONNECTOR_HOST_RESOLVES_PRIVATE',
					`Host ${normalized} resolves to a blocked network address.`,
				);
			}
			return addresses;
		},
	};
}

/**
 * Resolution through c-ares with a bounded timeout. getaddrinfo runs on the
 * libuv threadpool, so a name whose nameserver drops packets would hold
 * threads that password hashing and file reads of every workspace also need;
 * the capability serves callers members and agents can aim at any host.
 */
export function boundedHostResolver(timeoutMs = 2_500): HostAddressResolver {
	const resolver = new Resolver({ timeout: timeoutMs, tries: 2 });
	return async (hostname) => {
		const [v4, v6] = await Promise.allSettled([
			resolver.resolve4(hostname),
			resolver.resolve6(hostname),
		]);
		const addresses = [
			...(v4.status === 'fulfilled' ? v4.value : []),
			...(v6.status === 'fulfilled' ? v6.value : []),
		];
		if (addresses.length === 0) {
			throw new Error(`Host ${hostname} could not be resolved.`);
		}
		return addresses.map((address) => ({ address }));
	};
}

/**
 * The policy as a public capability. There is no allowlist: the caller names
 * one public URL, and its own domain rules apply on top of this one.
 */
export function createConnectorEgressCapability(
	resolve: HostAddressResolver = boundedHostResolver(),
): ConnectorEgressCapability {
	const policy = createConnectorEgressPolicy({ resolve });
	return {
		async check(value) {
			try {
				const url = policy.assertUrl(value);
				if (url.port !== '' && url.port !== '443') {
					return { ok: false, reason: 'CONNECTOR_PORT_REFUSED' };
				}
				const hostname = normalizeHost(url.hostname);
				const addresses = await policy.assertResolvable(hostname);
				return {
					ok: true,
					url: url.toString(),
					addresses: addresses.map((entry) => entry.address),
					lookup: pinnedLookup(hostname, addresses),
				};
			} catch (error) {
				if (error instanceof ConnectorEgressError) {
					return {
						ok: false,
						reason:
							error.code === 'CONNECTOR_HOST_NOT_ALLOWLISTED'
								? 'CONNECTOR_URL_BLOCKED'
								: error.code,
					};
				}
				throw error;
			}
		},
	};
}
