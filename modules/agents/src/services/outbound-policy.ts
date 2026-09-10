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

function blockedIp(value: string): boolean {
	if (isIP(value) === 4) return blockedIpv4(value);
	if (isIP(value) !== 6) return true;
	const normalized = value.toLowerCase();
	return (
		normalized === '::' ||
		normalized === '::1' ||
		normalized.startsWith('fc') ||
		normalized.startsWith('fd') ||
		normalized.startsWith('fe8') ||
		normalized.startsWith('fe9') ||
		normalized.startsWith('fea') ||
		normalized.startsWith('feb') ||
		normalized.startsWith('ff') ||
		normalized.startsWith('::ffff:127.') ||
		normalized.startsWith('::ffff:10.') ||
		normalized.startsWith('::ffff:192.168.')
	);
}

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
		addresses.some((item) => blockedIp(item.address))
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
