import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlobAccessError, BlobError, BlobNotFoundError } from '@vercel/blob';
import { storageConfigFromEnvironment } from '../src/config.ts';
import { createStoragePort } from '../src/port.ts';
import { createVercelBlobObjectStore } from '../src/vercel-blob.ts';
import { collect, keyring, MODULE, pdf, TENANT } from './fixtures.ts';

const sdk = vi.hoisted(() => ({
	put: vi.fn(),
	get: vi.fn(),
	head: vi.fn(),
	del: vi.fn(),
}));

vi.mock('@vercel/blob', async (importOriginal) => ({
	...(await importOriginal<typeof import('@vercel/blob')>()),
	...sdk,
}));

const KEY = `${TENANT}/${MODULE}/blob-1`;
const STORE_ID = 'store_abc123';
const TOKEN = 'vercel_blob_rw_abc123_s3cr3t-value';

/* A pull source that records how far it was read and whether it was
   cancelled, so a test can tell a prefix read from a full one. */
function source(chunks: readonly Uint8Array[]): {
	readonly stream: ReadableStream<Uint8Array>;
	readonly pulled: () => number;
	readonly cancelled: () => boolean;
} {
	let next = 0;
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunk = chunks[next];
			next += 1;
			if (chunk) controller.enqueue(chunk);
			else controller.close();
		},
		cancel() {
			cancelled = true;
		},
	});
	return { stream, pulled: () => next, cancelled: () => cancelled };
}

function found(stream: ReadableStream<Uint8Array>) {
	return { statusCode: 200, stream, headers: new Headers(), blob: {} };
}

const store = (options: { storeId?: string; token?: string } = {}) =>
	createVercelBlobObjectStore({
		storeId: STORE_ID,
		...options,
		maxFrameBytes: 64,
	});

describe('Vercel Blob storage adapter', () => {
	beforeEach(() => {
		for (const call of Object.values(sdk)) call.mockReset();
	});

	it('writes a private frame in place without a random suffix and returns no URL', async () => {
		sdk.put.mockResolvedValue({
			url: `https://abc123.private.blob.vercel-storage.com/${KEY}`,
		});
		const frame = Buffer.from('FDS1 frame bytes');

		const written = await store().write(KEY, frame);

		expect(written).toBeUndefined();
		expect(sdk.put).toHaveBeenCalledTimes(1);
		const [pathname, body, options] = sdk.put.mock.calls[0]!;
		expect(pathname).toBe(KEY);
		expect(Buffer.from(body as Uint8Array)).toEqual(frame);
		expect(options).toEqual({
			access: 'private',
			addRandomSuffix: false,
			allowOverwrite: true,
			contentType: 'application/octet-stream',
			abortSignal: expect.any(AbortSignal),
			storeId: STORE_ID,
		});
	});

	it('passes the read-write token only when no store id selects OIDC', async () => {
		sdk.put.mockResolvedValue({});

		await store({ token: TOKEN }).write(KEY, Buffer.from('x'));
		await createVercelBlobObjectStore({
			token: TOKEN,
			maxFrameBytes: 64,
		}).write(KEY, Buffer.from('x'));

		expect(sdk.put.mock.calls[0]![2]).not.toHaveProperty('token');
		expect(sdk.put.mock.calls[0]![2]).toMatchObject({ storeId: STORE_ID });
		expect(sdk.put.mock.calls[1]![2]).toMatchObject({ token: TOKEN });
		expect(sdk.put.mock.calls[1]![2]).not.toHaveProperty('storeId');
	});

	it('reads the whole frame from origin, skipping the cache', async () => {
		const body = source([Buffer.from('FDS1'), Buffer.from('-whole')]);
		sdk.get.mockResolvedValue(found(body.stream));

		const frame = await store().read(KEY);

		expect(Buffer.from(frame!).toString()).toBe('FDS1-whole');
		expect(sdk.get).toHaveBeenCalledWith(KEY, {
			access: 'private',
			useCache: false,
			abortSignal: expect.any(AbortSignal),
			storeId: STORE_ID,
		});
	});

	it('reads only the requested prefix and cancels the rest of the stream', async () => {
		const body = source([
			Buffer.from('abcd'),
			Buffer.from('efgh'),
			Buffer.from('ijkl'),
			Buffer.from('mnop'),
		]);
		sdk.get.mockResolvedValue(found(body.stream));

		const prefix = await store().read(KEY, 6);

		expect(Buffer.from(prefix!).toString()).toBe('abcdef');
		expect(body.cancelled()).toBe(true);
		expect(body.pulled()).toBeLessThan(4);
	});

	it('refuses a frame larger than the bound without reading it to the end', async () => {
		const body = source(
			Array.from({ length: 8 }, (_, index) => Buffer.alloc(40, index)),
		);
		sdk.get.mockResolvedValue(found(body.stream));

		await expect(store().read(KEY)).rejects.toMatchObject({
			code: 'OBJECT_TOO_LARGE',
		});
		expect(body.cancelled()).toBe(true);
		expect(body.pulled()).toBeLessThan(8);
	});

	it('answers null for an absent frame', async () => {
		sdk.get.mockResolvedValue(null);

		expect(await store().read(KEY)).toBeNull();
		expect(await store().read(KEY, 16)).toBeNull();
	});

	it('removes a present frame and reports an absent one as already gone', async () => {
		sdk.head.mockResolvedValueOnce({ pathname: KEY });
		sdk.del.mockResolvedValue(undefined);

		expect(await store().remove(KEY)).toBe(true);
		expect(sdk.del).toHaveBeenCalledWith(KEY, {
			abortSignal: expect.any(AbortSignal),
			storeId: STORE_ID,
		});

		sdk.del.mockClear();
		sdk.head.mockRejectedValueOnce(new BlobNotFoundError());

		expect(await store().remove(KEY)).toBe(false);
		expect(sdk.del).not.toHaveBeenCalled();
	});

	it('reports a refused lookup instead of calling the object absent', async () => {
		sdk.head.mockRejectedValue(new BlobAccessError());

		await expect(store().remove(KEY)).rejects.toMatchObject({
			code: 'STORAGE_UNAVAILABLE',
			message: expect.stringContaining('BlobAccessError'),
		});
		expect(sdk.del).not.toHaveBeenCalled();
	});

	it('keeps whatever the SDK said, credentials included, out of the error', async () => {
		const leaky = new BlobError(`request with Bearer ${TOKEN} failed`);
		sdk.put.mockRejectedValue(leaky);
		sdk.get.mockRejectedValue(new Error(`token=${TOKEN}`));
		sdk.head.mockRejectedValue(leaky);

		const failures = await Promise.all([
			store({ token: TOKEN })
				.write(KEY, Buffer.from('x'))
				.catch((error: unknown) => error),
			store({ token: TOKEN })
				.read(KEY)
				.catch((error: unknown) => error),
			store({ token: TOKEN })
				.remove(KEY)
				.catch((error: unknown) => error),
		]);

		for (const failure of failures) {
			expect(failure).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
			expect(inspect(failure, { depth: 8 })).not.toContain('s3cr3t');
		}
	});

	it('refuses a key the Blob pathname rules do not accept before calling the SDK', async () => {
		for (const key of [
			`${TENANT}//${MODULE}`,
			`/${KEY}`,
			`${TENANT}/../${MODULE}`,
			`${TENANT}/${MODULE}/a?b`,
			`${TENANT}/${'a'.repeat(950)}`,
		]) {
			await expect(store().read(key)).rejects.toMatchObject({
				code: 'OBJECT_REFERENCE_INVALID',
			});
		}
		expect(sdk.get).not.toHaveBeenCalled();
	});

	describe('deadline', () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it('aborts a request that outlives it with an AbortError, which the SDK does not retry', async () => {
			vi.useFakeTimers();
			let signal: AbortSignal | undefined;
			sdk.get.mockImplementation(
				(_pathname: string, options: { abortSignal: AbortSignal }) => {
					signal = options.abortSignal;
					return new Promise((_resolve, reject) => {
						signal!.addEventListener('abort', () => reject(signal!.reason));
					});
				},
			);

			const read = store().read(KEY);
			const outcome = expect(read).rejects.toMatchObject({
				code: 'STORAGE_UNAVAILABLE',
			});
			await vi.advanceTimersByTimeAsync(30_000);

			await outcome;
			expect(signal?.aborted).toBe(true);
			expect((signal?.reason as Error).name).toBe('AbortError');
		});
	});
});

describe('Vercel Blob adapter behind the storage port', () => {
	beforeEach(() => {
		for (const call of Object.values(sdk)) call.mockReset();
	});

	it('round trips an object at the size limit through the configured adapter', async () => {
		const blobs = new Map<string, Buffer>();
		sdk.put.mockImplementation(async (pathname: string, body: Buffer) => {
			blobs.set(pathname, Buffer.from(body));
			return {};
		});
		sdk.get.mockImplementation(async (pathname: string) => {
			const stored = blobs.get(pathname);
			return stored ? found(source([stored]).stream) : null;
		});
		const limit = 1024;
		const storage = createStoragePort(
			storageConfigFromEnvironment(
				{
					FD_STORAGE_ADAPTER: 'vercel-blob',
					FD_STORAGE_MAX_OBJECT_BYTES: String(limit),
					BLOB_STORE_ID: STORE_ID,
				},
				'/workspace',
			),
			{ keyring: keyring() },
		);
		const body = Buffer.concat([
			Buffer.from(pdf()),
			Buffer.alloc(limit - pdf().byteLength, 0x20),
		]);
		const reference = {
			tenantId: TENANT,
			moduleId: MODULE,
			objectId: 'at-limit',
		};

		const stored = await storage.put({
			...reference,
			contentType: 'application/pdf',
			body,
		});
		const read = await storage.get(reference);

		expect(stored.bytes).toBe(limit);
		expect(await collect(read!.body)).toEqual(body);
		expect(await storage.stat(reference)).toEqual(stored);
		await storage.dispose();
	});
});
