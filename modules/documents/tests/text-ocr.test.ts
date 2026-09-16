import { createServer, type Server } from 'node:https';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDocumentTextRunner } from '../src/services/text-runner.ts';
import {
	createDocumentOcr,
	documentOcrConfig,
	httpsOcrTransport,
	type ConnectorEgress,
	type DocumentOcr,
	type EgressLookup,
} from '../src/services/text/ocr.ts';
import { DocumentTextService } from '../src/services/text-service.ts';
import {
	openDocumentsTestContext,
	type DocumentsTestContext,
} from './support/database.ts';
import { pngBytes } from './support/files.ts';
import { pdfDocument } from './support/text-fixtures.ts';
import { TEST_CERTIFICATE, TEST_PRIVATE_KEY } from './support/tls.ts';

const OCR_URL = 'https://ocr.example.test/v1/read';
const TOKEN = 'ocr-token-0001';
const OWNER = 'directory.core';
const RECORD = 'party-4711';

interface Received {
	readonly method: string;
	readonly path: string;
	readonly contentType: string;
	readonly authorization: string;
	readonly body: Buffer;
}

let context: DocumentsTestContext;
let server: Server;
let port = 0;
let answer: { status: number; body: string } = { status: 200, body: '{}' };
const received: Received[] = [];

beforeAll(async () => {
	context = await openDocumentsTestContext();
	server = createServer(
		{ cert: TEST_CERTIFICATE, key: TEST_PRIVATE_KEY },
		(request, response) => {
			const chunks: Buffer[] = [];
			request.on('data', (chunk: Buffer) => chunks.push(chunk));
			request.on('end', () => {
				received.push({
					method: request.method ?? '',
					path: request.url ?? '',
					contentType: request.headers['content-type'] ?? '',
					authorization: request.headers.authorization ?? '',
					body: Buffer.concat(chunks),
				});
				response
					.writeHead(answer.status, { 'content-type': 'application/json' })
					.end(answer.body);
			});
		},
	);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	port = typeof address === 'object' && address ? address.port : 0;
});

afterEach(async () => {
	await context.reset();
	received.length = 0;
	answer = { status: 200, body: '{}' };
});

afterAll(async () => {
	server?.closeAllConnections?.();
	await new Promise<void>((resolve) => server?.close(() => resolve()));
	await context?.dispose();
});

function pinned(hostname: string, address: string): EgressLookup {
	return (asked, options, callback) => {
		if (asked !== hostname) {
			callback(new Error(`No verified address is pinned for ${asked}.`), '', 0);
			return;
		}
		if (options.all === true) callback(null, [{ address, family: 4 }]);
		else callback(null, address, 4);
	};
}

/* The policy verified the public-looking OCR host and pinned it to the loopback
   address the stub listens on; the transport dials nothing else. */
const egress: ConnectorEgress = {
	async check(value) {
		const url = new URL(value);
		return {
			ok: true,
			url: url.toString(),
			addresses: ['127.0.0.1'],
			lookup: pinned(url.hostname, '127.0.0.1'),
		};
	},
};

function ocr(check: ConnectorEgress = egress): DocumentOcr {
	return createDocumentOcr({
		config: { url: OCR_URL, token: TOKEN },
		egress: () => check,
		transport: httpsOcrTransport({ port, ca: TEST_CERTIFICATE }),
	});
}

function service(withOcr: DocumentOcr | null): DocumentTextService {
	return context.textService({ ocr: withOcr });
}

function upload(contentType: string, body: Uint8Array, recordRef = RECORD) {
	return context.service().upload('tenant-a', 'account-ada', {
		ownerModule: OWNER,
		recordRef,
		filename: 'scan',
		contentType,
		body,
	});
}

describe('documents OCR configuration', () => {
	it('DOCUMENTS-TEXT-OCR accepts only an https URL on port 443 to a public host name', () => {
		expect(documentOcrConfig({})).toBeNull();
		expect(documentOcrConfig({ FD_DOCUMENTS_OCR_URL: '  ' })).toBeNull();
		expect(
			documentOcrConfig({
				FD_DOCUMENTS_OCR_URL: 'https://ocr.example.com/read#part',
				FD_DOCUMENTS_OCR_TOKEN: TOKEN,
			}),
		).toEqual({ url: 'https://ocr.example.com/read', token: TOKEN });
		for (const url of [
			'http://ocr.example.com/read',
			'https://127.0.0.1/read',
			'https://[::1]/read',
			'https://localhost/read',
			'https://ocr.local/read',
			'https://ocr.example.com:8443/read',
			'https://user:secret@ocr.example.com/read',
			'not a url',
		]) {
			expect(() => documentOcrConfig({ FD_DOCUMENTS_OCR_URL: url })).toThrow(
				/FD_DOCUMENTS_OCR_URL/,
			);
		}
		expect(() =>
			documentOcrConfig({
				FD_DOCUMENTS_OCR_URL: 'https://ocr.example.com/read',
				FD_DOCUMENTS_OCR_TOKEN: 'two words',
			}),
		).toThrow(/FD_DOCUMENTS_OCR_TOKEN/);
	});

	it('DOCUMENTS-TEXT-OCR is unavailable without a URL or without the egress capability', () => {
		expect(
			createDocumentOcr({ config: null, egress: () => egress }).available(),
		).toBe(false);
		expect(
			createDocumentOcr({
				config: { url: OCR_URL, token: null },
				egress: () => undefined,
			}).available(),
		).toBe(false);
		expect(ocr().available()).toBe(true);
	});
});

describe('documents OCR seam', () => {
	it('DOCUMENTS-TEXT-OCR answers unscanned without OCR, then reads the text a stub OCR service answers', async () => {
		const scan = await upload('application/pdf', pdfDocument([null, null]));
		const image = await upload('image/png', pngBytes(), 'party-0002');
		const without = service(null);

		expect(
			await without.extract('tenant-a', OWNER, RECORD, scan.id),
		).toMatchObject({
			status: 'unscanned',
			reason: 'DOCUMENT_OCR_UNCONFIGURED',
			pages: 2,
		});
		expect(await without.read('tenant-a', image.id)).toMatchObject({
			status: 'unscanned',
			reason: 'DOCUMENT_OCR_UNCONFIGURED',
			ocrAvailable: false,
		});
		await expect(without.retry('tenant-a', scan.id)).rejects.toMatchObject({
			code: 'DOCUMENT_TEXT_NOT_RETRYABLE',
			status: 409,
		});
		expect(received).toEqual([]);

		const withOcr = service(ocr());
		expect(await withOcr.retry('tenant-a', scan.id)).toMatchObject({
			status: 'pending',
			ocrAvailable: true,
		});
		answer = {
			status: 200,
			body: JSON.stringify({ pages: ['Scanned one', 'Scanned two'] }),
		};
		const jobs = createDocumentTextRunner({
			repository: () => Promise.resolve(context.repository),
			service: () => Promise.resolve(withOcr),
			pollIntervalMs: 60_000,
			onEvent: () => undefined,
		});
		await jobs.tick();
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({
			method: 'POST',
			path: '/v1/read',
			contentType: 'application/pdf',
			authorization: `Bearer ${TOKEN}`,
		});
		expect(received[0]!.body).toEqual(Buffer.from(pdfDocument([null, null])));
		expect(
			await withOcr.extract('tenant-a', OWNER, RECORD, scan.id),
		).toMatchObject({
			status: 'ok',
			text: 'Scanned one\fScanned two',
			pages: 2,
		});

		answer = { status: 500, body: '{}' };
		await withOcr.retry('tenant-a', image.id);
		await jobs.tick();
		expect(await withOcr.read('tenant-a', image.id)).toMatchObject({
			status: 'unscanned',
			reason: 'DOCUMENT_OCR_FAILED',
		});
		await expect(withOcr.retry('tenant-a', scan.id)).rejects.toMatchObject({
			code: 'DOCUMENT_TEXT_NOT_RETRYABLE',
		});
		await jobs.dispose();
	});

	it('DOCUMENTS-TEXT-OCR leaves a first read that needs OCR pending while OCR is available', async () => {
		const image = await upload('image/png', pngBytes());
		let woken = 0;
		const withOcr = context.textService({
			ocr: ocr(),
			wake: () => {
				woken += 1;
			},
		});
		expect(await withOcr.read('tenant-a', image.id)).toMatchObject({
			status: 'pending',
		});
		expect(woken).toBe(1);
		expect(received).toEqual([]);
	});

	it('DOCUMENTS-TEXT-OCR reads bytes that are not stored through OCR within the call and refuses what the egress policy refuses', async () => {
		answer = { status: 200, body: JSON.stringify({ text: 'Page A\fPage B' }) };
		expect(
			await service(ocr()).extractBytes({
				contentType: 'application/pdf',
				bytes: pdfDocument([null]),
			}),
		).toMatchObject({ status: 'ok', text: 'Page A\fPage B', pages: 2 });

		/* The refusal still names a reachable address, so only honouring `ok`
		   keeps the stub from being called. */
		const refusing: ConnectorEgress = {
			check: async (value) =>
				({
					ok: false,
					reason: 'CONNECTOR_HOST_RESOLVES_PRIVATE',
					url: value,
					lookup: pinned(new URL(value).hostname, '127.0.0.1'),
				}) as Awaited<ReturnType<ConnectorEgress['check']>>,
		};
		received.length = 0;
		expect(
			await service(ocr(refusing)).extractBytes({
				contentType: 'image/png',
				bytes: pngBytes(),
			}),
		).toMatchObject({ status: 'unscanned', reason: 'DOCUMENT_OCR_FAILED' });
		expect(received).toEqual([]);

		answer = { status: 200, body: JSON.stringify({ words: [] }) };
		expect(
			await service(ocr()).extractBytes({
				contentType: 'image/png',
				bytes: pngBytes(),
			}),
		).toMatchObject({ status: 'unscanned', reason: 'DOCUMENT_OCR_FAILED' });
	});
});
