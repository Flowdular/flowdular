import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type EgressErrorCode =
	| 'WEBHOOK_URL_INVALID'
	| 'WEBHOOK_URL_BLOCKED'
	| 'WEBHOOK_HOST_NOT_ALLOWLISTED'
	| 'WEBHOOK_HOST_UNRESOLVED'
	| 'WEBHOOK_HOST_RESOLVES_PRIVATE';

export class WebhookEgressError extends Error {
	constructor(
		readonly code: EgressErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'WebhookEgressError';
	}
}

function blockedIpv4(value: string): boolean {
	const parts = value.split('.').map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
		return true;
	}
	const [a, b] = parts as [number, number, number, number];
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127) ||
		a >= 224
	);
}

/** True for loopback, link-local, private, multicast and reserved addresses. */
export function blockedAddress(value: string): boolean {
	if (isIP(value) === 4) return blockedIpv4(value);
	if (isIP(value) !== 6) return true;
	const normalized = value.toLowerCase();
	if (normalized.startsWith('::ffff:')) {
		const mapped = normalized.slice('::ffff:'.length);
		return isIP(mapped) === 4 ? blockedIpv4(mapped) : true;
	}
	return (
		normalized === '::' ||
		normalized === '::1' ||
		normalized.startsWith('fc') ||
		normalized.startsWith('fd') ||
		normalized.startsWith('fe8') ||
		normalized.startsWith('fe9') ||
		normalized.startsWith('fea') ||
		normalized.startsWith('feb') ||
		normalized.startsWith('ff')
	);
}

export function webhookHostAllowlist(
	value: string | undefined,
): ReadonlySet<string> {
	return new Set(
		(value ?? '')
			.split(',')
			.map((host) => host.trim().toLowerCase())
			.filter(Boolean),
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
 * How a hostname becomes addresses. The default asks the system resolver; a test
 * injects its own so a local server can be reached without an environment flag
 * ever weakening the check in a deployment.
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

export interface WebhookEgressPolicy {
	readonly allowlist: ReadonlySet<string>;
	/** Save-time check: scheme, shape and allowlist. Throws on refusal. */
	assertUrl(value: string): URL;
	/**
	 * Resolution check, repeated before every delivery. Throws on refusal, and
	 * answers the addresses it accepted so the connection can be pinned to
	 * exactly them.
	 */
	assertResolvable(hostname: string): Promise<readonly ResolvedAddress[]>;
}

export interface WebhookEgressPolicyOptions {
	readonly allowlist?: ReadonlySet<string> | undefined;
	readonly resolve?: HostAddressResolver | undefined;
}

export function createWebhookEgressPolicy(
	options: WebhookEgressPolicyOptions = {},
): WebhookEgressPolicy {
	const allowlist = options.allowlist ?? new Set<string>();
	const resolve = options.resolve ?? systemHostResolver;
	return {
		allowlist,
		assertUrl(value) {
			let url: URL;
			try {
				url = new URL(value);
			} catch {
				throw new WebhookEgressError(
					'WEBHOOK_URL_INVALID',
					'The webhook URL is not a valid absolute URL.',
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
				throw new WebhookEgressError(
					'WEBHOOK_URL_BLOCKED',
					'A webhook URL must be an https URL to a public host name.',
				);
			}
			if (allowlist.size > 0 && !allowlist.has(hostname)) {
				throw new WebhookEgressError(
					'WEBHOOK_HOST_NOT_ALLOWLISTED',
					`Host ${hostname} is not on the notifications egress allowlist.`,
				);
			}
			return url;
		},
		async assertResolvable(hostname) {
			const normalized = normalizeHost(hostname);
			if (allowlist.size > 0 && !allowlist.has(normalized)) {
				throw new WebhookEgressError(
					'WEBHOOK_HOST_NOT_ALLOWLISTED',
					`Host ${normalized} is not on the notifications egress allowlist.`,
				);
			}
			let addresses: readonly ResolvedAddress[];
			try {
				addresses = await resolve(normalized);
			} catch {
				/* A name that no longer resolves is a different operational fact from
				   one that resolves into a blocked range; the ledger keeps them apart. */
				throw new WebhookEgressError(
					'WEBHOOK_HOST_UNRESOLVED',
					`Host ${normalized} could not be resolved.`,
				);
			}
			/* Every returned address is checked, not just the first: a host that
			   answers with one public and one loopback address is still refused. */
			if (
				addresses.length === 0 ||
				addresses.some((entry) => blockedAddress(entry.address))
			) {
				throw new WebhookEgressError(
					'WEBHOOK_HOST_RESOLVES_PRIVATE',
					`Host ${normalized} resolves to a blocked network address.`,
				);
			}
			return addresses;
		},
	};
}
