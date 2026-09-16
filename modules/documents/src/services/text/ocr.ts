import { Agent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { DOCUMENT_TEXT_PAGE_BREAK } from '../../domain/text.ts';

export const CONNECTORS_EGRESS_CAPABILITY = 'connectors.egress.v1';
export const DOCUMENTS_OCR_TIMEOUT_MS = 60_000;
export const DOCUMENTS_OCR_MAX_ANSWER_BYTES = 8 * 1024 * 1024;
const TOKEN_MAX_LENGTH = 4_096;

/** The `lookup` option `node:https` takes, answering only verified addresses. */
export type EgressLookup = (
	hostname: string,
	options: { readonly all?: boolean | undefined },
	callback: (
		error: Error | null,
		address: string | { address: string; family: number }[],
		family?: number,
	) => void,
) => void;

/** The shape of `connectors.egress.v1` this module relies on. */
export interface ConnectorEgress {
	check(url: string): Promise<
		| {
				readonly ok: true;
				readonly url: string;
				readonly addresses: readonly string[];
				readonly lookup: EgressLookup;
		  }
		| { readonly ok: false; readonly reason: string }
	>;
}

export class DocumentOcrConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DocumentOcrConfigError';
	}
}

export class DocumentOcrFailed extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DocumentOcrFailed';
	}
}

export interface DocumentOcrConfig {
	readonly url: string;
	readonly token: string | null;
}

/**
 * The deployment's OCR endpoint, or null when none is set. A value the egress
 * rules would refuse on every call is refused here instead, so a deployment
 * learns at boot rather than from a document that never gets its text.
 */
export function documentOcrConfig(
	environment: NodeJS.ProcessEnv,
): DocumentOcrConfig | null {
	const raw = environment.FD_DOCUMENTS_OCR_URL?.trim() ?? '';
	if (raw === '') return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new DocumentOcrConfigError(
			'FD_DOCUMENTS_OCR_URL must be an absolute https URL.',
		);
	}
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (
		url.protocol !== 'https:' ||
		url.username !== '' ||
		url.password !== '' ||
		(url.port !== '' && url.port !== '443') ||
		host === '' ||
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host.endsWith('.local') ||
		isIP(host) !== 0
	) {
		throw new DocumentOcrConfigError(
			'FD_DOCUMENTS_OCR_URL must be an https URL on port 443 to a public host name without credentials.',
		);
	}
	url.hash = '';
	const token = environment.FD_DOCUMENTS_OCR_TOKEN?.trim() ?? '';
	if (
		token.length > TOKEN_MAX_LENGTH ||
		[...token].some((character) => {
			const code = character.charCodeAt(0);
			return code < 0x21 || code > 0x7e;
		})
	) {
		throw new DocumentOcrConfigError(
			'FD_DOCUMENTS_OCR_TOKEN must be printable ASCII of at most 4096 characters.',
		);
	}
	return { url: url.toString(), token: token === '' ? null : token };
}

export interface OcrRequest {
	readonly url: URL;
	readonly lookup: EgressLookup;
	readonly contentType: string;
	readonly body: Uint8Array;
	readonly token: string | null;
	readonly maxBytes: number;
	readonly signal: AbortSignal;
}

export interface OcrResponse {
	readonly status: number;
	readonly body: Buffer;
	readonly exceeded: boolean;
}

export type OcrTransport = (request: OcrRequest) => Promise<OcrResponse>;

/**
 * Test seam for the socket, never reachable from configuration: a test dials
 * its own port and trusts its own certificate while the address rules stay the
 * ones a deployment runs.
 */
export interface OcrTransportSeam {
	readonly port?: number | undefined;
	readonly ca?: string | undefined;
}

/**
 * One POST over TLS through an agent built for this request alone, dialling only
 * the addresses the egress check pinned. A redirect is an answer, not followed.
 */
export function httpsOcrTransport(seam: OcrTransportSeam = {}): OcrTransport {
	return (request) => {
		const agent = new Agent({
			keepAlive: false,
			maxSockets: 1,
			lookup: request.lookup as never,
			...(seam.ca === undefined ? {} : { ca: seam.ca }),
		});
		return new Promise<OcrResponse>((resolve, reject) => {
			const outgoing = httpsRequest(request.url, {
				method: 'POST',
				agent,
				signal: request.signal,
				...(seam.port === undefined ? {} : { port: seam.port }),
				headers: {
					'content-type': request.contentType,
					'content-length': String(request.body.byteLength),
					accept: 'application/json',
					'accept-encoding': 'identity',
					'user-agent': 'FlowdularDocuments',
					...(request.token === null
						? {}
						: { authorization: `Bearer ${request.token}` }),
				},
			});
			outgoing.on('error', reject);
			outgoing.on('response', (incoming) => {
				const chunks: Buffer[] = [];
				let bytes = 0;
				let exceeded = false;
				const finish = () =>
					resolve({
						status: incoming.statusCode ?? 0,
						body: Buffer.concat(chunks),
						exceeded,
					});
				incoming.on('data', (chunk: Buffer) => {
					if (exceeded) return;
					bytes += chunk.byteLength;
					if (bytes > request.maxBytes) {
						exceeded = true;
						incoming.destroy();
						finish();
						return;
					}
					chunks.push(chunk);
				});
				incoming.on('end', finish);
				incoming.on('error', (error) => {
					if (!exceeded) reject(error);
				});
			});
			outgoing.end(request.body);
		}).finally(() => agent.destroy());
	};
}

export interface DocumentOcr {
	/** True while an endpoint is configured and the egress capability composed. */
	available(): boolean;
	/** The page texts the service answered; throws `DocumentOcrFailed`. */
	read(input: {
		readonly contentType: string;
		readonly bytes: Uint8Array;
		readonly signal?: AbortSignal | undefined;
	}): Promise<readonly string[]>;
}

export interface DocumentOcrOptions {
	readonly config: DocumentOcrConfig | null;
	readonly egress: () => ConnectorEgress | undefined;
	readonly transport?: OcrTransport | undefined;
	readonly timeoutMs?: number | undefined;
}

function answerPages(body: Buffer): readonly string[] {
	let value: unknown;
	try {
		value = JSON.parse(body.toString('utf8'));
	} catch {
		throw new DocumentOcrFailed('The OCR service did not answer JSON.');
	}
	const answer = (value ?? {}) as { pages?: unknown; text?: unknown };
	if (
		Array.isArray(answer.pages) &&
		answer.pages.every((page) => typeof page === 'string')
	) {
		return answer.pages as string[];
	}
	if (typeof answer.text === 'string') {
		return answer.text.split(DOCUMENT_TEXT_PAGE_BREAK);
	}
	throw new DocumentOcrFailed(
		'The OCR service answered neither pages nor text.',
	);
}

export function createDocumentOcr(options: DocumentOcrOptions): DocumentOcr {
	const transport = options.transport ?? httpsOcrTransport();
	const timeoutMs = options.timeoutMs ?? DOCUMENTS_OCR_TIMEOUT_MS;
	return {
		available: () => options.config !== null && options.egress() !== undefined,
		async read(input) {
			const config = options.config;
			const egress = options.egress();
			if (!config || !egress) {
				throw new DocumentOcrFailed('No OCR service is available.');
			}
			const deadline = AbortSignal.timeout(timeoutMs);
			const signal = input.signal
				? AbortSignal.any([input.signal, deadline])
				: deadline;
			const check = await egress.check(config.url);
			if (!check.ok) {
				throw new DocumentOcrFailed(
					`The egress policy refused the OCR host: ${check.reason}.`,
				);
			}
			let response: OcrResponse;
			try {
				response = await transport({
					url: new URL(check.url),
					lookup: check.lookup,
					contentType: input.contentType,
					body: input.bytes,
					token: config.token,
					maxBytes: DOCUMENTS_OCR_MAX_ANSWER_BYTES,
					signal,
				});
			} catch {
				input.signal?.throwIfAborted();
				throw new DocumentOcrFailed(
					deadline.aborted
						? 'The OCR service did not answer in time.'
						: 'The OCR service could not be reached.',
				);
			}
			if (response.exceeded) {
				throw new DocumentOcrFailed('The OCR answer is larger than allowed.');
			}
			if (response.status < 200 || response.status > 299) {
				throw new DocumentOcrFailed(
					`The OCR service answered ${response.status}.`,
				);
			}
			return answerPages(response.body);
		},
	};
}
