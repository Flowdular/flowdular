import { KeyringError, type Keyring } from '@flowdular/kernel';
import {
	StorageError,
	storageObjectKey,
	type StorageObjectRef,
	type StoragePort,
	type StoragePutInput,
	type StorageReadResult,
	type StorageReadUrlInput,
	type StorageScanVerdict,
	type StoredObject,
} from './contracts.ts';
import {
	contentMatchesType,
	contentTypeAllowed,
	normalizeContentType,
} from './content-type.ts';
import {
	encodeStoredObject,
	openStoredObject,
	readStoredObjectHeader,
	STORAGE_HEADER_PREFIX_BYTES,
} from './envelope.ts';
import { createLocalObjectStore } from './local.ts';
import { createS3ObjectStore } from './s3.ts';
import { mintStorageReadToken, storageReadUrl } from './read-token.ts';
import { unscannedStorageScanner, type StorageScanner } from './scanner.ts';
import type { StorageConfig } from './config.ts';
import type { ObjectStore } from './store.ts';

export interface StoragePortOptions {
	readonly keyring: Keyring;
	readonly scanner?: StorageScanner | undefined;
	readonly clock?: (() => Date) | undefined;
	/** Test seam for the S3 adapter. A deployment never sets it. */
	readonly fetch?: typeof globalThis.fetch | undefined;
}

/**
 * Reads at most `limit` bytes and refuses as soon as one more arrives. The
 * source is cancelled at that point, so an oversized upload is not read to the
 * end and never reaches the object store.
 */
async function readBounded(
	body: ReadableStream<Uint8Array> | Uint8Array,
	limit: number,
): Promise<Uint8Array> {
	if (!(body instanceof ReadableStream)) {
		if (body.byteLength > limit) throw tooLarge(limit);
		return body;
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > limit) {
				await reader.cancel();
				throw tooLarge(limit);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, total);
}

function tooLarge(limit: number): StorageError {
	return new StorageError(
		'OBJECT_TOO_LARGE',
		`An object may not exceed ${limit} bytes.`,
	);
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

async function verdictOf(
	scanner: StorageScanner,
	plaintext: Uint8Array,
): Promise<StorageScanVerdict> {
	/* A scanner is deployment-supplied code. A throw is not a clean verdict and
	   must not be read as one, so the write is refused rather than downgraded. */
	let result;
	try {
		result = await scanner.scan(streamOf(plaintext));
	} catch (error) {
		throw new StorageError(
			'SCAN_FAILED',
			'The configured scanner did not return a verdict.',
			{ cause: error },
		);
	}
	if (result.verdict === 'infected') {
		throw new StorageError(
			'OBJECT_INFECTED',
			'The scanner reported the content as infected.',
		);
	}
	return result.verdict;
}

function objectStoreFor(
	config: StorageConfig,
	options: StoragePortOptions,
): ObjectStore {
	if (config.adapter === 'local') {
		return createLocalObjectStore(config.local.directory);
	}
	return createS3ObjectStore({
		...config.s3,
		fetch: options.fetch,
		clock: options.clock,
	});
}

/**
 * The one place the storage rules live: the tenant-first key layout, the size
 * limit, the content type allowlist with magic byte verification, the scanner
 * verdict and encryption under the keyring. Adapters below it only move frames.
 */
export function createStoragePort(
	config: StorageConfig,
	options: StoragePortOptions,
): StoragePort {
	const store = objectStoreFor(config, options);
	const scanner = options.scanner ?? unscannedStorageScanner;
	const clock = options.clock ?? (() => new Date());
	const keyring = options.keyring;
	let disposed = false;

	const live = (): void => {
		if (disposed) {
			throw new StorageError(
				'STORAGE_DISPOSED',
				'The storage port was disposed.',
			);
		}
	};

	const openFrame = (
		key: string,
		frame: Uint8Array,
	): { readonly object: StoredObject; readonly plaintext: Buffer } => {
		try {
			return openStoredObject(keyring, key, frame);
		} catch (error) {
			if (error instanceof KeyringError) {
				throw new StorageError(
					'OBJECT_CORRUPT',
					`The stored object did not open under this keyring (${error.code}).`,
					{ cause: error },
				);
			}
			throw error;
		}
	};

	return {
		async put(input: StoragePutInput): Promise<StoredObject> {
			live();
			const key = storageObjectKey(input);
			const contentType = normalizeContentType(input.contentType);
			if (!contentType || !contentTypeAllowed(contentType)) {
				throw new StorageError(
					'CONTENT_TYPE_REFUSED',
					`The content type ${input.contentType} is not stored by this platform.`,
				);
			}
			if (
				input.declaredBytes !== undefined &&
				input.declaredBytes > config.maxObjectBytes
			) {
				throw tooLarge(config.maxObjectBytes);
			}
			const plaintext = await readBounded(input.body, config.maxObjectBytes);
			if (!contentMatchesType(contentType, plaintext)) {
				throw new StorageError(
					'CONTENT_MISMATCH',
					`The content does not carry the structure of ${contentType}.`,
				);
			}
			const scan = await verdictOf(scanner, plaintext);
			const { frame, object } = encodeStoredObject(keyring, key, plaintext, {
				contentType,
				scan,
				createdAt: clock(),
			});
			await store.write(key, frame);
			return object;
		},

		async get(input: StorageObjectRef): Promise<StorageReadResult | null> {
			live();
			const key = storageObjectKey(input);
			const frame = await store.read(key);
			if (!frame) return null;
			/* The body is authenticated as a whole, so it is opened before a byte
			   of plaintext leaves: streaming out an unverified prefix would hand a
			   caller content the tag has not covered yet. The object limit bounds
			   what this holds. */
			const { object, plaintext } = openFrame(key, frame);
			return { object, body: streamOf(plaintext) };
		},

		async delete(input: StorageObjectRef): Promise<boolean> {
			live();
			return store.remove(storageObjectKey(input));
		},

		readUrl(input: StorageReadUrlInput): Promise<string> {
			live();
			storageObjectKey(input);
			return Promise.resolve(
				storageReadUrl(
					mintStorageReadToken(keyring, {
						tenantId: input.tenantId,
						moduleId: input.moduleId,
						objectId: input.objectId,
						expiresInSeconds: input.expiresInSeconds,
						now: clock(),
					}),
				),
			);
		},

		async stat(input: StorageObjectRef): Promise<StoredObject | null> {
			live();
			const key = storageObjectKey(input);
			const prefix = await store.read(key, STORAGE_HEADER_PREFIX_BYTES);
			return prefix ? readStoredObjectHeader(key, prefix) : null;
		},

		async dispose(): Promise<void> {
			if (disposed) return;
			disposed = true;
			await store.close();
		},
	};
}
