import { createServer } from 'node:http';
import { once } from 'node:events';
import dns from 'node:dns';
import { expect, it, vi } from 'vitest';
import { DEFAULT_CONFIGURATION } from '../src/server/config.ts';
import { PlatformClient } from '../src/server/platform-client.ts';

it('connects using the default hostname when Vite listens on IPv6 loopback', async () => {
	const server = createServer((_request, response) => {
		response.setHeader('content-type', 'application/json');
		response.end(
			JSON.stringify({ authority: { granted: false, reason: 'test' } }),
		);
	});
	server.listen(0, '::1');
	await once(server, 'listening');
	/* BuildKit has IPv6 loopback but no external IPv6 interface. Node's
	   ADDRCONFIG lookup hint discards ::1 there. Keep real localhost resolution,
	   without that interface-dependent filter, for this IPv6-specific fixture. */
	const lookup = dns.lookup;
	const resolveAll = (
		hostname: string,
		options: dns.LookupAllOptions,
		callback: (
			error: NodeJS.ErrnoException | null,
			addresses: dns.LookupAddress[],
		) => void,
	) => {
		expect(options.all).toBe(true);
		lookup(hostname, { ...options, hints: 0 }, callback);
	};
	// Fetch uses the all-addresses overload; Vitest infers the last overload.
	const resolver = vi
		.spyOn(dns, 'lookup')
		.mockImplementation(resolveAll as typeof dns.lookup);
	try {
		const address = server.address();
		if (!address || typeof address === 'string')
			throw new Error('Missing test listener');
		const url = new URL(DEFAULT_CONFIGURATION.platformUrl);
		url.port = String(address.port);
		const client = new PlatformClient({
			platformUrl: url.origin,
			token: 'test-token',
		});
		expect((await client.authority()).authority.granted).toBe(false);
	} finally {
		resolver.mockRestore();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
