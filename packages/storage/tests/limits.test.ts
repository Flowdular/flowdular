import { readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStoragePort } from '../src/port.ts';
import type { StorageScanner } from '../src/scanner.ts';
import {
	keyring,
	localConfig,
	MODULE,
	pdf,
	png,
	TENANT,
	workspace,
} from './fixtures.ts';

const CHUNK = 1024 * 1024;
const LIMIT = 4 * CHUNK;

function endlessStream(): {
	readonly stream: ReadableStream<Uint8Array>;
	produced(): number;
	cancelled(): boolean;
} {
	let produced = 0;
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			produced += 1;
			controller.enqueue(new Uint8Array(CHUNK));
		},
		cancel() {
			cancelled = true;
		},
	});
	return { stream, produced: () => produced, cancelled: () => cancelled };
}

describe('storage limits and content rules', () => {
	let space: Awaited<ReturnType<typeof workspace>>;

	beforeEach(async () => {
		space = await workspace();
	});
	afterEach(async () => {
		await space.cleanup();
	});

	const port = (overrides: NodeJS.ProcessEnv = {}, scanner?: StorageScanner) =>
		createStoragePort(localConfig(space.directory, overrides), {
			keyring: keyring(),
			...(scanner ? { scanner } : {}),
		});

	const reference = { tenantId: TENANT, moduleId: MODULE, objectId: 'upload' };

	it('stops reading at the limit instead of buffering the whole stream', async () => {
		const storage = port({ FD_STORAGE_MAX_OBJECT_BYTES: String(LIMIT) });
		const source = endlessStream();

		await expect(
			storage.put({
				...reference,
				contentType: 'application/pdf',
				body: source.stream,
			}),
		).rejects.toMatchObject({ code: 'OBJECT_TOO_LARGE' });

		/* One chunk past the limit is what proves it aborted: a port that read to
		   the end would never stop, because the source never finishes. */
		expect(source.produced()).toBeLessThanOrEqual(LIMIT / CHUNK + 2);
		expect(source.cancelled()).toBe(true);
		expect(await readdir(space.directory).catch(() => [])).toEqual([]);
		await storage.dispose();
	});

	it('refuses a declared size over the limit before a byte is read', async () => {
		const storage = port({ FD_STORAGE_MAX_OBJECT_BYTES: String(LIMIT) });
		const source = endlessStream();

		await expect(
			storage.put({
				...reference,
				contentType: 'application/pdf',
				body: source.stream,
				declaredBytes: LIMIT + 1,
			}),
		).rejects.toMatchObject({ code: 'OBJECT_TOO_LARGE' });

		/* The body was never opened: a declared size over the limit is refused
		   before the port takes a reader, so no upload is consumed at all. */
		expect(source.stream.locked).toBe(false);
		expect(source.cancelled()).toBe(false);
		await storage.dispose();
	});

	it('stores an object exactly at the limit', async () => {
		const storage = port({ FD_STORAGE_MAX_OBJECT_BYTES: '2048' });
		const body = Buffer.concat([
			Buffer.from('%PDF-1.7\n'),
			Buffer.alloc(2039, 32),
		]);

		const stored = await storage.put({
			...reference,
			contentType: 'application/pdf',
			body,
		});

		expect(stored.bytes).toBe(2048);
		await storage.dispose();
	});

	it('refuses a content type that is not on the allowlist', async () => {
		const storage = port();

		for (const contentType of [
			'application/zip',
			'application/x-msdownload',
			'image/svg+xml',
			'not-a-media-type',
		]) {
			await expect(
				storage.put({ ...reference, contentType, body: pdf() }),
			).rejects.toMatchObject({ code: 'CONTENT_TYPE_REFUSED' });
		}
		await storage.dispose();
	});

	it('refuses bytes that do not carry the declared structure', async () => {
		const storage = port();

		await expect(
			storage.put({
				...reference,
				contentType: 'application/pdf',
				body: png(),
			}),
		).rejects.toMatchObject({ code: 'CONTENT_MISMATCH' });
		await expect(
			storage.put({
				...reference,
				contentType: 'text/csv',
				body: Buffer.of(0x69, 0x64, 0x00, 0x0c),
			}),
		).rejects.toMatchObject({ code: 'CONTENT_MISMATCH' });
		await storage.dispose();
	});

	it('refuses a plain archive renamed to a spreadsheet', async () => {
		const storage = port();
		const zipEntry = 'payload.exe';
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(zipEntry.length, 26);
		const archive = Buffer.concat([header, Buffer.from(zipEntry)]);

		await expect(
			storage.put({
				...reference,
				contentType:
					'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
				body: archive,
			}),
		).rejects.toMatchObject({ code: 'CONTENT_MISMATCH' });
		await storage.dispose();
	});

	it('accepts an office document whose first entry is the content type map', async () => {
		const storage = port();
		const entry = '[Content_Types].xml';
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(entry.length, 26);
		const document = Buffer.concat([
			header,
			Buffer.from(entry),
			Buffer.alloc(16),
		]);

		const stored = await storage.put({
			...reference,
			contentType:
				'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			body: document,
		});

		expect(stored.bytes).toBe(document.byteLength);
		await storage.dispose();
	});

	it('refuses content a scanner reports as infected and writes nothing', async () => {
		const storage = port(
			{},
			{ scan: () => ({ verdict: 'infected' as const }) },
		);

		await expect(
			storage.put({
				...reference,
				contentType: 'application/pdf',
				body: pdf(),
			}),
		).rejects.toMatchObject({ code: 'OBJECT_INFECTED' });

		expect(await readdir(space.directory).catch(() => [])).toEqual([]);
		await storage.dispose();
	});

	it('records the clean verdict a scanner returns', async () => {
		const seen: number[] = [];
		const scanner: StorageScanner = {
			async scan(body) {
				const reader = body.getReader();
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					if (value) seen.push(value.byteLength);
				}
				return { verdict: 'clean' };
			},
		};
		const storage = port({}, scanner);

		const stored = await storage.put({
			...reference,
			contentType: 'application/pdf',
			body: pdf('scanned'),
		});

		expect(stored.scan).toBe('clean');
		expect(seen.reduce((total, value) => total + value, 0)).toBe(stored.bytes);
		await storage.dispose();
	});

	it('refuses the write when a scanner fails instead of calling it clean', async () => {
		const storage = port(
			{},
			{
				scan: () => {
					throw new Error('scanner offline');
				},
			},
		);

		await expect(
			storage.put({
				...reference,
				contentType: 'application/pdf',
				body: pdf(),
			}),
		).rejects.toMatchObject({ code: 'SCAN_FAILED' });
		await storage.dispose();
	});
});
