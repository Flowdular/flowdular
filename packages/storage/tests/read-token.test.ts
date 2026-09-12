import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STORAGE_READ_ROUTE_PREFIX } from '../src/contracts.ts';
import { createStoragePort } from '../src/port.ts';
import {
	mintStorageReadToken,
	openStorageReadToken,
} from '../src/read-token.ts';
import { keyring, localConfig, MODULE, TENANT, workspace } from './fixtures.ts';

const reference = { tenantId: TENANT, moduleId: MODULE, objectId: 'receipt-1' };

describe('storage read token', () => {
	it('round trips the object reference and its expiry', () => {
		const ring = keyring();
		const now = new Date('2026-09-11T10:00:00.000Z');

		const token = mintStorageReadToken(ring, {
			...reference,
			expiresInSeconds: 300,
			now,
		});
		const opened = openStorageReadToken(ring, token, now);

		expect(opened).toEqual({
			...reference,
			expiresAt: new Date('2026-09-11T10:05:00.000Z'),
		});
	});

	it('keeps the tenant out of the token text', () => {
		const token = mintStorageReadToken(keyring(), {
			...reference,
			expiresInSeconds: 60,
			now: new Date(),
		});

		expect(token).not.toContain(TENANT);
		expect(token).not.toContain('receipt-1');
	});

	it('stops answering once the expiry has passed', () => {
		const ring = keyring();
		const now = new Date('2026-09-11T10:00:00.000Z');
		const token = mintStorageReadToken(ring, {
			...reference,
			expiresInSeconds: 60,
			now,
		});

		expect(
			openStorageReadToken(ring, token, new Date(now.getTime() + 59_000)),
		).not.toBeNull();
		expect(
			openStorageReadToken(ring, token, new Date(now.getTime() + 60_000)),
		).toBeNull();
		expect(
			openStorageReadToken(ring, token, new Date(now.getTime() + 61_000)),
		).toBeNull();
	});

	it('answers null for a forged, truncated or foreign token', () => {
		const ring = keyring();
		const now = new Date();
		const token = mintStorageReadToken(ring, {
			...reference,
			expiresInSeconds: 60,
			now,
		});
		const raw = Buffer.from(token, 'base64url');
		const flipped = Buffer.from(raw);
		flipped[flipped.length - 1] = (flipped.at(-1) ?? 0) ^ 0xff;

		expect(
			openStorageReadToken(ring, flipped.toString('base64url'), now),
		).toBeNull();
		expect(
			openStorageReadToken(
				ring,
				raw.subarray(0, 20).toString('base64url'),
				now,
			),
		).toBeNull();
		expect(openStorageReadToken(keyring(7), token, now)).toBeNull();
		expect(openStorageReadToken(ring, '', now)).toBeNull();
		expect(openStorageReadToken(ring, 'x'.repeat(5000), now)).toBeNull();
	});

	it('opens a token minted before a rotation', () => {
		const before = keyring(1);
		const after = keyring(2, [1]);
		const now = new Date();

		const token = mintStorageReadToken(before, {
			...reference,
			expiresInSeconds: 60,
			now,
		});

		expect(openStorageReadToken(after, token, now)).toMatchObject(reference);
	});

	it('refuses an expiry outside the supported window', () => {
		const ring = keyring();
		const now = new Date();

		for (const expiresInSeconds of [0, -1, 3601, 1.5]) {
			expect(() =>
				mintStorageReadToken(ring, { ...reference, expiresInSeconds, now }),
			).toThrow(/EXPIRY|expires/i);
		}
	});
});

describe('readUrl', () => {
	let space: Awaited<ReturnType<typeof workspace>>;

	beforeEach(async () => {
		space = await workspace();
	});
	afterEach(async () => {
		await space.cleanup();
	});

	it('returns a platform route whose token names the object', async () => {
		const ring = keyring();
		const storage = createStoragePort(localConfig(space.directory), {
			keyring: ring,
		});

		const url = await storage.readUrl({ ...reference, expiresInSeconds: 120 });

		expect(url.startsWith(STORAGE_READ_ROUTE_PREFIX)).toBe(true);
		expect(
			openStorageReadToken(
				ring,
				url.slice(STORAGE_READ_ROUTE_PREFIX.length),
				new Date(),
			),
		).toMatchObject(reference);
		await storage.dispose();
	});
});
