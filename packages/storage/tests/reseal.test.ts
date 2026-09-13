import { readFile, writeFile } from 'node:fs/promises';
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
	TENANT,
	workspace,
} from './fixtures.ts';

describe('re-sealing stored objects', () => {
	let space: Awaited<ReturnType<typeof workspace>>;

	beforeEach(async () => {
		space = await workspace();
	});
	afterEach(async () => {
		await space.cleanup();
	});

	const port = (ring = keyring()) =>
		createStoragePort(localConfig(space.directory), { keyring: ring });
	const reference = (objectId: string) => ({
		tenantId: TENANT,
		moduleId: MODULE,
		objectId,
	});
	const path = (objectId: string) =>
		join(space.directory, TENANT, MODULE, objectId);

	async function putUnder(seed: number, objectId: string, text: string) {
		const writer = port(keyring(seed));
		const stored = await writer.put({
			...reference(objectId),
			contentType: 'application/pdf',
			body: pdf(text),
		});
		await writer.dispose();
		return stored;
	}

	it('re-seals a frame under the previous key and reads it back under the current one', async () => {
		const before = await putUnder(1, 'old', 'written under key 1');
		const rotated = port(keyring(2, [1]));

		const dry = await rotated.reseal([reference('old')], { apply: false });
		expect(dry).toEqual({
			currentKeyId: keyring(2).keyId,
			counts: [{ keyId: keyring(1).keyId, objects: 1 }],
			stale: 1,
			resealed: 0,
			unknown: 0,
			refused: 0,
			missing: 0,
		});
		expect((await rotated.stat(reference('old')))?.keyId).toBe(
			keyring(1).keyId,
		);

		const applied = await rotated.reseal([reference('old')], { apply: true });
		expect(applied).toMatchObject({ stale: 1, resealed: 1 });
		await rotated.dispose();

		const current = port(keyring(2));
		const stat = await current.stat(reference('old'));
		expect(stat).toMatchObject({
			keyId: keyring(2).keyId,
			bytes: before.bytes,
			checksum: before.checksum,
			contentType: before.contentType,
			scan: before.scan,
			createdAt: before.createdAt,
		});
		const read = await current.get(reference('old'));
		expect(await collect(read!.body)).toEqual(
			Buffer.from(pdf('written under key 1')),
		);
		await current.dispose();
	});

	it('skips a frame already under the current key', async () => {
		await putUnder(2, 'fresh', 'written under key 2');
		const frame = await readFile(path('fresh'));
		const rotated = port(keyring(2, [1]));

		const report = await rotated.reseal([reference('fresh')], { apply: true });

		expect(report).toMatchObject({
			counts: [{ keyId: keyring(2).keyId, objects: 1 }],
			stale: 0,
			resealed: 0,
		});
		expect(await readFile(path('fresh'))).toEqual(frame);
		await rotated.dispose();
	});

	it('refuses a tampered frame and leaves it as it is', async () => {
		await putUnder(1, 'tampered', 'written under key 1');
		const frame = await readFile(path('tampered'));
		const last = frame.byteLength - 1;
		frame[last] = (frame[last] ?? 0) ^ 0x01;
		await writeFile(path('tampered'), frame);
		const rotated = port(keyring(2, [1]));

		const report = await rotated.reseal([reference('tampered')], {
			apply: true,
		});

		expect(report).toMatchObject({ stale: 1, resealed: 0, refused: 1 });
		expect(await readFile(path('tampered'))).toEqual(frame);
		await expect(rotated.get(reference('tampered'))).rejects.toMatchObject({
			code: 'OBJECT_CORRUPT',
		} satisfies Partial<StorageError>);
		await rotated.dispose();
	});

	it('refuses a frame whose header does not parse and goes on with the batch', async () => {
		await putUnder(1, 'broken', 'written under key 1');
		await putUnder(1, 'intact', 'written under key 1');
		const broken = Buffer.concat([
			Buffer.from('FDS1'),
			Buffer.of(0, 0, 0, 8),
			Buffer.from('not json'),
		]);
		await writeFile(path('broken'), broken);
		const rotated = port(keyring(2, [1]));

		const report = await rotated.reseal(
			[reference('broken'), reference('intact')],
			{ apply: true },
		);

		expect(report).toMatchObject({ stale: 1, resealed: 1, refused: 1 });
		expect(await readFile(path('broken'))).toEqual(broken);
		expect((await rotated.stat(reference('intact')))?.keyId).toBe(
			keyring(2).keyId,
		);
		await rotated.dispose();
	});

	it('counts an object under a key the ring does not hold and a missing one, and touches neither', async () => {
		await putUnder(3, 'foreign', 'written under key 3');
		const frame = await readFile(path('foreign'));
		const rotated = port(keyring(2, [1]));

		const report = await rotated.reseal(
			[reference('foreign'), reference('gone')],
			{ apply: true },
		);

		expect(report).toEqual({
			currentKeyId: keyring(2).keyId,
			counts: [{ keyId: keyring(3).keyId, objects: 1 }],
			stale: 0,
			resealed: 0,
			unknown: 1,
			refused: 0,
			missing: 1,
		});
		expect(await readFile(path('foreign'))).toEqual(frame);
		await rotated.dispose();
	});
});
