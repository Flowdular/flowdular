import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext } from '@octanejs/app-core';
import { createKeyring, type Keyring } from '@flowdular/kernel';
import {
	createStoragePort,
	mintStorageReadToken,
	storageConfigFromEnvironment,
	STORAGE_READ_ROUTE_PREFIX,
	type StoragePort,
} from '@flowdular/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorageRoutes } from './storage.ts';

const TENANT = 'tenant-a';
const MODULE = 'documents.core';
const OBJECT = 'receipt-1';
const reference = { tenantId: TENANT, moduleId: MODULE, objectId: OBJECT };
const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('receipt')]);

function serve(
	routes: ReturnType<typeof createStorageRoutes>,
	token: string,
	headers: Record<string, string> = {},
): Promise<Response> {
	const request = new Request(
		`http://localhost${STORAGE_READ_ROUTE_PREFIX}${encodeURIComponent(token)}`,
		{ headers },
	);
	return Promise.resolve(routes[0]!.handler(createContext(request, { token })));
}

describe('storage read route', () => {
	let directory: string;
	let keyring: Keyring;
	let storage: StoragePort;
	let now: Date;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'flowdular-platform-storage-'));
		keyring = createKeyring({ current: Buffer.alloc(32, 1) });
		now = new Date('2026-09-11T10:00:00.000Z');
		storage = createStoragePort(
			storageConfigFromEnvironment(
				{
					NODE_ENV: 'test',
					FD_STORAGE_ADAPTER: 'local',
					FD_STORAGE_LOCAL_DIRECTORY: directory,
				},
				directory,
			),
			{ keyring },
		);
		await storage.put({
			...reference,
			contentType: 'application/pdf',
			body: pdf,
		});
	});

	afterEach(async () => {
		await storage.dispose();
		await rm(directory, { recursive: true, force: true });
	});

	const routes = () =>
		createStorageRoutes({
			storage,
			keyring,
			environment: {},
			clock: () => now,
		});

	const token = (overrides: Partial<typeof reference> = {}) =>
		mintStorageReadToken(keyring, {
			...reference,
			...overrides,
			expiresInSeconds: 300,
			now,
		});

	it('streams the decrypted body with the stored content type', async () => {
		const response = await serve(routes(), token());

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/pdf');
		expect(response.headers.get('content-disposition')).toBe('attachment');
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(Buffer.from(await response.arrayBuffer())).toEqual(pdf);
	});

	it('needs no session, so it never answers 401', async () => {
		const response = await serve(routes(), token());

		expect(response.status).not.toBe(401);
		expect(response.headers.get('www-authenticate')).toBeNull();
	});

	it('answers 404 once the token has expired', async () => {
		const composed = routes();
		const issued = token();
		now = new Date('2026-09-11T10:05:01.000Z');

		const response = await serve(composed, issued);

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({
			error: { code: 'NOT_FOUND' },
		});
	});

	it('answers 404 for a forged token, a foreign key and an unknown object', async () => {
		const forged = Buffer.from(token(), 'base64url');
		forged[forged.length - 1] = (forged.at(-1) ?? 0) ^ 0xff;
		const foreign = mintStorageReadToken(
			createKeyring({ current: Buffer.alloc(32, 9) }),
			{ ...reference, expiresInSeconds: 300, now },
		);

		for (const value of [
			forged.toString('base64url'),
			foreign,
			token({ objectId: 'never-written' }),
			token({ tenantId: 'tenant-b' }),
			'',
			'not-a-token',
		]) {
			expect((await serve(routes(), value)).status).toBe(404);
		}
	});

	it('refuses more than 600 reads a minute from one caller', async () => {
		const composed = routes();
		const issued = token();

		for (let attempt = 0; attempt < 600; attempt += 1) {
			expect((await serve(composed, issued)).status).toBe(200);
		}
		const limited = await serve(composed, issued);

		expect(limited.status).toBe(429);
		expect(limited.headers.get('retry-after')).toBe('60');
		expect(await limited.json()).toMatchObject({
			error: { code: 'RATE_LIMITED' },
		});
	});

	it('keys the window by the trusted client address when there is one', async () => {
		const composed = createStorageRoutes({
			storage,
			keyring,
			environment: { FD_TRUST_PROXY: 'true' },
			clock: () => now,
		});
		const issued = token();

		for (let attempt = 0; attempt < 600; attempt += 1) {
			await serve(composed, issued, { 'x-forwarded-for': '198.51.100.7' });
		}

		expect(
			(await serve(composed, issued, { 'x-forwarded-for': '198.51.100.7' }))
				.status,
		).toBe(429);
		expect(
			(await serve(composed, issued, { 'x-forwarded-for': '198.51.100.8' }))
				.status,
		).toBe(200);
	});
});
