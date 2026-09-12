import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStoragePort } from '../src/port.ts';
import { StorageError } from '../src/contracts.ts';
import {
	collect,
	keyring,
	localConfig,
	MODULE,
	pdf,
	png,
	TENANT,
	workspace,
} from './fixtures.ts';

describe('local storage adapter', () => {
	let space: Awaited<ReturnType<typeof workspace>>;

	beforeEach(async () => {
		space = await workspace();
	});
	afterEach(async () => {
		await space.cleanup();
	});

	const port = (ring = keyring()) =>
		createStoragePort(localConfig(space.directory), { keyring: ring });

	it('round trips an object and keeps the plaintext off the disk', async () => {
		const storage = port();
		const body = pdf('invoice 2026-09');

		const stored = await storage.put({
			tenantId: TENANT,
			moduleId: MODULE,
			objectId: 'receipt-1',
			contentType: 'application/pdf',
			body,
		});
		const read = await storage.get({
			tenantId: TENANT,
			moduleId: MODULE,
			objectId: 'receipt-1',
		});

		expect(stored.key).toBe(`${TENANT}/${MODULE}/receipt-1`);
		expect(stored.bytes).toBe(body.byteLength);
		expect(stored.contentType).toBe('application/pdf');
		expect(stored.scan).toBe('unscanned');
		expect(stored.keyId).toBe(keyring().keyId);
		expect(read).not.toBeNull();
		expect(await collect(read!.body)).toEqual(Buffer.from(body));

		const frame = await readFile(
			join(space.directory, TENANT, MODULE, 'receipt-1'),
		);
		expect(frame.includes(Buffer.from('invoice 2026-09'))).toBe(false);
		expect(frame.subarray(0, 4).toString()).toBe('FDS1');
		expect(frame.toString('utf8')).toContain(`"keyId":"${stored.keyId}"`);
		await storage.dispose();
	});

	it('lays the key out under the tenant before the module', async () => {
		const storage = port();

		await storage.put({
			tenantId: TENANT,
			moduleId: MODULE,
			objectId: 'a',
			contentType: 'image/png',
			body: png(),
		});

		expect(await readdir(space.directory)).toEqual([TENANT]);
		expect(await readdir(join(space.directory, TENANT))).toEqual([MODULE]);
		await storage.dispose();
	});

	it('refuses a reference that would escape its tenant prefix', async () => {
		const storage = port();
		const attempts = [
			{ tenantId: '../other', moduleId: MODULE, objectId: 'a' },
			{ tenantId: TENANT, moduleId: 'a/b', objectId: 'a' },
			{ tenantId: TENANT, moduleId: MODULE, objectId: '../../escape' },
			{ tenantId: TENANT, moduleId: MODULE, objectId: '' },
		];

		for (const attempt of attempts) {
			await expect(
				storage.put({ ...attempt, contentType: 'image/png', body: png() }),
			).rejects.toMatchObject({ code: 'OBJECT_REFERENCE_INVALID' });
			await expect(storage.stat(attempt)).rejects.toBeInstanceOf(StorageError);
		}
		await storage.dispose();
	});

	it('reads metadata without the body and reports an absent object as null', async () => {
		const storage = port();
		const reference = { tenantId: TENANT, moduleId: MODULE, objectId: 'only' };

		expect(await storage.stat(reference)).toBeNull();
		expect(await storage.get(reference)).toBeNull();
		const stored = await storage.put({
			...reference,
			contentType: 'application/pdf',
			body: pdf(),
		});

		expect(await storage.stat(reference)).toEqual(stored);
		await storage.dispose();
	});

	it('deletes once and stays idempotent', async () => {
		const storage = port();
		const reference = { tenantId: TENANT, moduleId: MODULE, objectId: 'gone' };
		await storage.put({
			...reference,
			contentType: 'application/pdf',
			body: pdf(),
		});

		expect(await storage.delete(reference)).toBe(true);
		expect(await storage.delete(reference)).toBe(false);
		expect(await storage.get(reference)).toBeNull();
		await storage.dispose();
	});

	it('opens an object written before a rotation and seals new ones under the current key', async () => {
		const before = keyring(1);
		const after = keyring(2, [1]);
		const reference = { tenantId: TENANT, moduleId: MODULE, objectId: 'old' };
		const old = port(before);
		const stored = await old.put({
			...reference,
			contentType: 'application/pdf',
			body: pdf('before rotation'),
		});
		await old.dispose();

		const rotated = port(after);
		const read = await rotated.get(reference);
		const fresh = await rotated.put({
			...reference,
			objectId: 'new',
			contentType: 'application/pdf',
			body: pdf('after rotation'),
		});

		expect(stored.keyId).toBe(before.keyId);
		expect(await collect(read!.body)).toEqual(
			Buffer.from(pdf('before rotation')),
		);
		expect(fresh.keyId).toBe(after.keyId);
		expect(fresh.keyId).not.toBe(before.keyId);
		await rotated.dispose();
	});

	it('refuses an object a retired key no longer covers', async () => {
		const reference = { tenantId: TENANT, moduleId: MODULE, objectId: 'lost' };
		const written = port(keyring(1));
		await written.put({
			...reference,
			contentType: 'application/pdf',
			body: pdf(),
		});
		await written.dispose();

		const stranger = port(keyring(9));

		await expect(stranger.get(reference)).rejects.toMatchObject({
			code: 'OBJECT_CORRUPT',
		});
		await stranger.dispose();
	});

	it('refuses to open an object moved into another tenant prefix', async () => {
		const storage = port();
		await storage.put({
			tenantId: TENANT,
			moduleId: MODULE,
			objectId: 'moved',
			contentType: 'application/pdf',
			body: pdf(),
		});
		const frame = await readFile(
			join(space.directory, TENANT, MODULE, 'moved'),
		);
		const { createLocalObjectStore } = await import('../src/local.ts');
		await createLocalObjectStore(space.directory).write(
			`tenant-b/${MODULE}/moved`,
			frame,
		);

		await expect(
			storage.get({
				tenantId: 'tenant-b',
				moduleId: MODULE,
				objectId: 'moved',
			}),
		).rejects.toMatchObject({ code: 'OBJECT_CORRUPT' });
		await storage.dispose();
	});

	it('refuses every operation after disposal', async () => {
		const storage = port();
		await storage.dispose();
		await storage.dispose();

		await expect(
			storage.stat({ tenantId: TENANT, moduleId: MODULE, objectId: 'a' }),
		).rejects.toMatchObject({ code: 'STORAGE_DISPOSED' });
	});
});
