import { Agent, request as httpsRequest } from 'node:https';
import { RESEARCH_USER_AGENT } from '../domain/types.ts';
import type { EgressLookup } from './capabilities.ts';

export interface PageRequest {
	readonly url: URL;
	/** Answers only the addresses the egress policy verified for this host. */
	readonly lookup: EgressLookup;
	readonly maxBytes: number;
	readonly signal: AbortSignal;
}

export interface PageResponse {
	readonly status: number;
	readonly contentType: string;
	readonly location: string | null;
	/** At most `maxBytes`; `exceeded` says the sender had more. */
	readonly body: Buffer;
	readonly exceeded: boolean;
}

export type PageTransport = (request: PageRequest) => Promise<PageResponse>;

/**
 * Test seam for the socket, never reachable from configuration: a test dials
 * its own port and trusts its own certificate while the address rules stay the
 * ones a deployment runs. `ca` only widens trust.
 */
export interface PageTransportSeam {
	readonly port?: number | undefined;
	readonly ca?: string | undefined;
}

/**
 * One GET over TLS. The agent is built per request and destroyed with it, so
 * no pooled socket outlives the address check that admitted it; a redirect is
 * answered to the caller rather than followed.
 */
export function httpsPageTransport(
	seam: PageTransportSeam = {},
): PageTransport {
	return (request) => {
		const agent = new Agent({
			keepAlive: false,
			maxSockets: 1,
			lookup: request.lookup as never,
			...(seam.ca === undefined ? {} : { ca: seam.ca }),
		});
		return new Promise<PageResponse>((resolve, reject) => {
			const outgoing = httpsRequest(request.url, {
				method: 'GET',
				agent,
				signal: request.signal,
				...(seam.port === undefined ? {} : { port: seam.port }),
				headers: {
					'user-agent': RESEARCH_USER_AGENT,
					accept:
						'text/html, application/xhtml+xml, text/plain;q=0.9, */*;q=0.1',
					'accept-encoding': 'identity',
				},
			});
			outgoing.on('error', reject);
			outgoing.on('response', (incoming) => {
				const chunks: Buffer[] = [];
				let bytes = 0;
				let exceeded = false;
				const header = (name: string): string | null => {
					const value = incoming.headers[name];
					return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
				};
				const finish = () =>
					resolve({
						status: incoming.statusCode ?? 0,
						contentType: header('content-type') ?? '',
						location: header('location'),
						body: Buffer.concat(chunks),
						exceeded,
					});
				incoming.on('data', (chunk: Buffer) => {
					if (exceeded) return;
					const room = request.maxBytes - bytes;
					if (chunk.byteLength > room) {
						chunks.push(chunk.subarray(0, Math.max(0, room)));
						bytes = request.maxBytes;
						exceeded = true;
						/* The socket goes down with the first byte past the cap, so a
						   sender that keeps streaming cannot hold the fetch open. */
						incoming.destroy();
						finish();
						return;
					}
					bytes += chunk.byteLength;
					chunks.push(chunk);
				});
				incoming.on('end', finish);
				incoming.on('error', (error) => {
					if (!exceeded) reject(error);
				});
			});
			outgoing.end();
		}).finally(() => agent.destroy());
	};
}
