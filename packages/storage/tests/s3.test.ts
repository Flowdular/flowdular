import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storageConfigFromEnvironment } from '../src/config.ts';
import { createStoragePort } from '../src/port.ts';
import { collect, keyring, MODULE, pdf, TENANT } from './fixtures.ts';

const BUCKET = 'flowdular-objects';
const REGION = 'eu-central-1';
const ACCESS_KEY_ID = 'AKIAFAKEEXAMPLE';
const SECRET_ACCESS_KEY = 'wJalrXUtnFEMI-K7MDENG-bPxRfiCYEXAMPLEKEY';

/* Verification written from the SigV4 specification rather than by calling the
   signer under test, so a mistake in the signer fails here instead of matching
   itself. */
function signature(
	request: IncomingMessage,
	body: Buffer,
): { readonly expected: string; readonly presented: string | null } {
	const authorization = request.headers.authorization ?? '';
	const presented = /Signature=([0-9a-f]{64})/.exec(authorization)?.[1] ?? null;
	const signedHeaders =
		/SignedHeaders=([^,]+)/.exec(authorization)?.[1]?.split(';') ?? [];
	const credential = /Credential=([^,]+)/.exec(authorization)?.[1] ?? '';
	const [, date = '', region = '', service = ''] = credential.split('/');
	const timestamp = String(request.headers['x-amz-date'] ?? '');
	const payloadHash = String(request.headers['x-amz-content-sha256'] ?? '');
	const canonicalHeaders = signedHeaders
		.map((name) => `${name}:${String(request.headers[name] ?? '').trim()}\n`)
		.join('');
	const canonicalRequest = [
		request.method ?? '',
		(request.url ?? '').split('?')[0] ?? '',
		'',
		canonicalHeaders,
		signedHeaders.join(';'),
		payloadHash,
	].join('\n');
	const scope = `${date}/${region}/${service}/aws4_request`;
	const stringToSign = [
		'AWS4-HMAC-SHA256',
		timestamp,
		scope,
		createHash('sha256').update(canonicalRequest).digest('hex'),
	].join('\n');
	const hmac = (key: Buffer | string, value: string) =>
		createHmac('sha256', key).update(value).digest();
	const signingKey = hmac(
		hmac(hmac(hmac(`AWS4${SECRET_ACCESS_KEY}`, date), region), service),
		'aws4_request',
	);
	const expected = hmac(signingKey, stringToSign).toString('hex');
	const bodyHash = createHash('sha256').update(body).digest('hex');
	return {
		expected: payloadHash === bodyHash ? expected : 'payload-hash-mismatch',
		presented,
	};
}

function fakeS3(objects: Map<string, Buffer>): Promise<{
	readonly server: Server;
	readonly endpoint: string;
	readonly signed: readonly string[];
}> {
	const signed: string[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', () => {
			const body = Buffer.concat(chunks);
			const { expected, presented } = signature(request, body);
			if (!presented || presented !== expected) {
				response.writeHead(403, { 'content-type': 'application/xml' });
				response.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
				return;
			}
			signed.push(`${request.method} ${request.url}`);
			const path = request.url ?? '';
			if (!path.startsWith(`/${BUCKET}/`)) {
				response.writeHead(404).end('<Error><Code>NoSuchBucket</Code></Error>');
				return;
			}
			const key = decodeURIComponent(path.slice(BUCKET.length + 2));
			if (request.method === 'PUT') {
				objects.set(key, body);
				response.writeHead(200).end();
				return;
			}
			const stored = objects.get(key);
			if (!stored) {
				response.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
				return;
			}
			if (request.method === 'DELETE') {
				objects.delete(key);
				response.writeHead(204).end();
				return;
			}
			if (request.method === 'HEAD') {
				response.writeHead(200, {
					'content-length': String(stored.byteLength),
				});
				response.end();
				return;
			}
			const range = /^bytes=0-(\d+)$/.exec(String(request.headers.range ?? ''));
			if (range) {
				const end = Math.min(Number(range[1]) + 1, stored.byteLength);
				response.writeHead(206).end(stored.subarray(0, end));
				return;
			}
			response.writeHead(200).end(stored);
		});
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const address = server.address() as AddressInfo;
			resolve({
				server,
				endpoint: `http://127.0.0.1:${address.port}`,
				get signed() {
					return signed;
				},
			});
		});
	});
}

describe('S3-compatible storage adapter', () => {
	const objects = new Map<string, Buffer>();
	let fake: Awaited<ReturnType<typeof fakeS3>>;

	beforeAll(async () => {
		fake = await fakeS3(objects);
	});
	afterAll(async () => {
		await new Promise<void>((resolve) => fake.server.close(() => resolve()));
	});

	const port = () =>
		createStoragePort(
			storageConfigFromEnvironment(
				{
					FD_STORAGE_ADAPTER: 's3',
					FD_STORAGE_S3_BUCKET: BUCKET,
					FD_STORAGE_S3_REGION: REGION,
					FD_STORAGE_S3_ENDPOINT: fake.endpoint,
					FD_STORAGE_S3_ACCESS_KEY_ID: ACCESS_KEY_ID,
					FD_STORAGE_S3_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
					FD_STORAGE_S3_FORCE_PATH_STYLE: 'true',
				},
				'/workspace',
			),
			{ keyring: keyring() },
		);

	const reference = {
		tenantId: TENANT,
		moduleId: MODULE,
		objectId: 'remote-1',
	};

	it('signs every request and round trips an encrypted object', async () => {
		const storage = port();
		const body = pdf('remote invoice');

		const stored = await storage.put({
			...reference,
			contentType: 'application/pdf',
			body,
		});
		const read = await storage.get(reference);

		expect(stored.key).toBe(`${TENANT}/${MODULE}/remote-1`);
		expect(await collect(read!.body)).toEqual(Buffer.from(body));
		const frame = objects.get(stored.key)!;
		expect(frame.subarray(0, 4).toString()).toBe('FDS1');
		expect(frame.includes(Buffer.from('remote invoice'))).toBe(false);
		expect(fake.signed).toContain(
			`PUT /${BUCKET}/${TENANT}/${MODULE}/remote-1`,
		);
		await storage.dispose();
	});

	it('reads metadata with a ranged request and answers null for a missing key', async () => {
		const storage = port();
		const absent = { tenantId: TENANT, moduleId: MODULE, objectId: 'absent' };

		const stored = await storage.put({
			...reference,
			objectId: 'remote-2',
			contentType: 'application/pdf',
			body: pdf('metadata'),
		});
		const described = await storage.stat({
			...reference,
			objectId: 'remote-2',
		});

		expect(described).toEqual(stored);
		expect(await storage.stat(absent)).toBeNull();
		expect(await storage.get(absent)).toBeNull();
		await storage.dispose();
	});

	it('deletes once and reports an absent key as already gone', async () => {
		const storage = port();
		const target = { ...reference, objectId: 'remote-3' };
		await storage.put({
			...target,
			contentType: 'application/pdf',
			body: pdf(),
		});

		expect(await storage.delete(target)).toBe(true);
		expect(await storage.delete(target)).toBe(false);
		await storage.dispose();
	});

	it('reports a refused request instead of returning an empty object', async () => {
		const storage = createStoragePort(
			storageConfigFromEnvironment(
				{
					FD_STORAGE_ADAPTER: 's3',
					FD_STORAGE_S3_BUCKET: BUCKET,
					FD_STORAGE_S3_REGION: REGION,
					FD_STORAGE_S3_ENDPOINT: fake.endpoint,
					FD_STORAGE_S3_ACCESS_KEY_ID: ACCESS_KEY_ID,
					FD_STORAGE_S3_SECRET_ACCESS_KEY: 'the-wrong-secret',
					FD_STORAGE_S3_FORCE_PATH_STYLE: 'true',
				},
				'/workspace',
			),
			{ keyring: keyring() },
		);

		await expect(
			storage.put({
				...reference,
				objectId: 'refused',
				contentType: 'application/pdf',
				body: pdf(),
			}),
		).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
		await storage.dispose();
	});
});
