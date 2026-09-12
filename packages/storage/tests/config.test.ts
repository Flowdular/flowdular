import { describe, expect, it } from 'vitest';
import {
	createStorageKeyring,
	DEFAULT_STORAGE_MAX_OBJECT_BYTES,
	storageConfigFromEnvironment,
} from '../src/config.ts';

const S3 = {
	FD_STORAGE_ADAPTER: 's3',
	FD_STORAGE_S3_BUCKET: 'flowdular-objects',
	FD_STORAGE_S3_REGION: 'eu-central-1',
	FD_STORAGE_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
	FD_STORAGE_S3_SECRET_ACCESS_KEY: 'secret',
};

describe('storageConfigFromEnvironment', () => {
	it('defaults to the local adapter outside production', () => {
		const config = storageConfigFromEnvironment({}, '/workspace');

		expect(config.adapter).toBe('local');
		expect(config.production).toBe(false);
		expect(config.maxObjectBytes).toBe(DEFAULT_STORAGE_MAX_OBJECT_BYTES);
		expect(config.local.directory).toBe('/workspace/.flowdular/data/storage');
	});

	it('refuses the local adapter in production', () => {
		expect(() =>
			storageConfigFromEnvironment(
				{
					NODE_ENV: 'production',
					FD_STORAGE_ADAPTER: 'local',
					FD_STORAGE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
				},
				'/workspace',
			),
		).toThrow(/refused in production/);
	});

	it('requires the encryption key in production', () => {
		expect(() =>
			storageConfigFromEnvironment({ NODE_ENV: 'production', ...S3 }, '/w'),
		).toThrow(/FD_STORAGE_ENCRYPTION_KEY is required in production/);
	});

	it('defaults to the S3 adapter in production and keeps its settings', () => {
		const config = storageConfigFromEnvironment(
			{
				NODE_ENV: 'production',
				...S3,
				FD_STORAGE_ADAPTER: '',
				FD_STORAGE_S3_ENDPOINT: 'https://minio.internal:9000',
				FD_STORAGE_S3_FORCE_PATH_STYLE: 'true',
				FD_STORAGE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
			},
			'/workspace',
		);

		expect(config.adapter).toBe('s3');
		expect(config.s3).toEqual({
			bucket: 'flowdular-objects',
			region: 'eu-central-1',
			endpoint: 'https://minio.internal:9000',
			accessKeyId: 'AKIAEXAMPLE',
			secretAccessKey: 'secret',
			forcePathStyle: true,
		});
	});

	it('names the missing S3 setting rather than starting without it', () => {
		for (const missing of [
			'FD_STORAGE_S3_BUCKET',
			'FD_STORAGE_S3_REGION',
			'FD_STORAGE_S3_ACCESS_KEY_ID',
			'FD_STORAGE_S3_SECRET_ACCESS_KEY',
		]) {
			expect(() =>
				storageConfigFromEnvironment({ ...S3, [missing]: '' }, '/w'),
			).toThrow(new RegExp(missing));
		}
	});

	it('refuses an object limit outside the supported range', () => {
		for (const value of ['0', '512', 'many', String(512 * 1024 * 1024)]) {
			expect(() =>
				storageConfigFromEnvironment(
					{ FD_STORAGE_MAX_OBJECT_BYTES: value },
					'/w',
				),
			).toThrow(/FD_STORAGE_MAX_OBJECT_BYTES/);
		}
	});

	it('refuses an adapter it does not implement', () => {
		expect(() =>
			storageConfigFromEnvironment({ FD_STORAGE_ADAPTER: 'gcs' }, '/w'),
		).toThrow(/FD_STORAGE_ADAPTER/);
	});
});

describe('createStorageKeyring', () => {
	it('derives a stable development key per workspace', () => {
		const one = createStorageKeyring({}, '/workspace-a');
		const two = createStorageKeyring({}, '/workspace-a');
		const other = createStorageKeyring({}, '/workspace-b');

		expect(one.keyId).toBe(two.keyId);
		expect(one.keyId).not.toBe(other.keyId);
	});

	it('keeps retired keys readable after a rotation', () => {
		const previous = Buffer.alloc(32, 4).toString('base64');
		const current = Buffer.alloc(32, 5).toString('base64');
		const before = createStorageKeyring(
			{ FD_STORAGE_ENCRYPTION_KEY: previous },
			'/w',
		);
		const after = createStorageKeyring(
			{
				FD_STORAGE_ENCRYPTION_KEY: current,
				FD_STORAGE_ENCRYPTION_KEY_PREVIOUS: previous,
			},
			'/w',
		);

		expect(after.keyId).not.toBe(before.keyId);
		expect(after.knows(before.keyId)).toBe(true);
	});

	it('refuses a key that does not decode to 32 bytes', () => {
		expect(() =>
			createStorageKeyring({ FD_STORAGE_ENCRYPTION_KEY: 'too-short' }, '/w'),
		).toThrow(/32 bytes/);
	});
});
