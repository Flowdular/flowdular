import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { TEST_HOST } from './harness.ts';
import { TEST_CERTIFICATE, TEST_PRIVATE_KEY } from './tls.ts';

export interface Received {
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

export type EndpointHandler = (
	request: { readonly body: string },
	reply: (status: number, headers?: Record<string, string>) => void,
) => void;

export interface TestEndpoint {
	readonly url: string;
	readonly port: number;
	readonly received: Received[];
	respond(handler: EndpointHandler): void;
	close(): Promise<void>;
}

/* A real TLS socket on 127.0.0.1, reached under the test host name: the address
   block is crossed through the injected resolver and the loopback port through
   the connect seam, so the delivery path under test is exactly the production
   one. */
export async function openEndpoint(path = '/receiver'): Promise<TestEndpoint> {
	const received: Received[] = [];
	let handler: EndpointHandler = (_request, reply) => reply(200);
	const server: Server = createServer(
		{ cert: TEST_CERTIFICATE, key: TEST_PRIVATE_KEY },
		(request, response) => {
			const chunks: Buffer[] = [];
			request.on('data', (chunk: Buffer) => chunks.push(chunk));
			request.on('end', () => {
				const body = Buffer.concat(chunks).toString('utf8');
				received.push({
					headers: Object.fromEntries(
						Object.entries(request.headers).map(([key, value]) => [
							key,
							Array.isArray(value) ? value.join(',') : (value ?? ''),
						]),
					),
					body,
				});
				handler({ body }, (status, headers = {}) => {
					response.writeHead(status, headers);
					response.end();
				});
			});
		},
	);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `https://${TEST_HOST}:${port}${path}`,
		port,
		received,
		respond(next) {
			handler = next;
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}
