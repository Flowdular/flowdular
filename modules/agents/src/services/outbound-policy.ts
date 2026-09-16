import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class ProviderEgressError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'ProviderEgressError';
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

export function providerHostAllowlist(
	value: string | undefined,
): ReadonlySet<string> {
	return new Set(
		(value ?? '')
			.split(',')
			.map((host) => host.trim().toLowerCase())
			.filter(Boolean),
	);
}

export function validateCompatibleBaseUrl(
	value: string,
	allowlist: ReadonlySet<string>,
): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ProviderEgressError(
			'PROVIDER_BASE_URL_INVALID',
			'OpenAI-compatible base URL is invalid.',
		);
	}
	const hostname = url.hostname.toLowerCase();
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!hostname ||
		hostname === 'localhost' ||
		hostname.endsWith('.local') ||
		isIP(hostname) !== 0
	) {
		throw new ProviderEgressError(
			'PROVIDER_BASE_URL_BLOCKED',
			'OpenAI-compatible base URL must use an allowlisted public HTTPS hostname.',
		);
	}
	if (!allowlist.has(hostname)) {
		throw new ProviderEgressError(
			'PROVIDER_HOST_NOT_ALLOWLISTED',
			`Provider hostname ${hostname} is not present in FD_AGENT_PROVIDER_HOST_ALLOWLIST.`,
		);
	}
	return url;
}

export async function assertPublicHost(hostname: string): Promise<void> {
	const addresses = await lookup(hostname, { all: true, verbatim: true });
	if (
		addresses.length === 0 ||
		addresses.some((item) => blockedAddress(item.address))
	) {
		throw new ProviderEgressError(
			'PROVIDER_HOST_RESOLVES_PRIVATE',
			'The provider hostname resolves to a blocked network address.',
		);
	}
}

export function createProviderFetch(baseURL: URL): typeof globalThis.fetch {
	return async (input, init) => {
		const target = new URL(
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: input.url,
		);
		if (
			target.protocol !== 'https:' ||
			target.hostname.toLowerCase() !== baseURL.hostname.toLowerCase()
		) {
			throw new ProviderEgressError(
				'PROVIDER_REQUEST_TARGET_BLOCKED',
				'The provider request attempted to leave its approved origin.',
			);
		}
		await assertPublicHost(target.hostname);
		return fetch(input, { ...init, redirect: 'error' });
	};
}
