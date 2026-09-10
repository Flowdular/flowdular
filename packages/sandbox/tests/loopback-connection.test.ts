import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
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
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
