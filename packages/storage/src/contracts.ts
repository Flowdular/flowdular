/** The verdict a scanner returns. `unscanned` is the default: no scanner ran. */
export type StorageScanVerdict = 'clean' | 'infected' | 'unscanned';

export type StorageErrorCode =
	| 'OBJECT_REFERENCE_INVALID'
	| 'EXPIRY_INVALID'
	| 'CONTENT_TYPE_REFUSED'
	| 'CONTENT_MISMATCH'
	| 'OBJECT_TOO_LARGE'
	| 'OBJECT_INFECTED'
	| 'SCAN_FAILED'
	| 'OBJECT_CORRUPT'
	| 'STORAGE_UNAVAILABLE'
	| 'STORAGE_DISPOSED';

/** A refused or failed storage operation, with the code a caller may branch on. */
export class StorageError extends Error {
	readonly code: StorageErrorCode;

	constructor(code: StorageErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'StorageError';
		this.code = code;
	}
}

/** Metadata of one stored object. The bytes and the checksum are the plaintext's. */
export interface StoredObject {
	readonly key: string;
	readonly bytes: number;
	readonly contentType: string;
	readonly checksum: string;
	readonly keyId: string;
	readonly scan: StorageScanVerdict;
	readonly createdAt: Date;
}

/**
 * Where an object lives. The tenant id is the first key segment and comes from
 * the authenticated principal; a value read out of a request body or a query
 * parameter is a tenancy defect, because no row-level security reaches an
 * object store.
 */
export interface StorageObjectRef {
	readonly tenantId: string;
	readonly moduleId: string;
	readonly objectId: string;
}

export interface StoragePutInput extends StorageObjectRef {
	readonly contentType: string;
	readonly body: ReadableStream<Uint8Array> | Uint8Array;
	/** Refused before a byte is read when it already exceeds the object limit. */
	readonly declaredBytes?: number | undefined;
}

export interface StorageReadUrlInput extends StorageObjectRef {
	readonly expiresInSeconds: number;
}

export interface StorageReadResult {
	readonly object: StoredObject;
	readonly body: ReadableStream<Uint8Array>;
}

export interface StoragePort {
	put(input: StoragePutInput): Promise<StoredObject>;
	get(input: StorageObjectRef): Promise<StorageReadResult | null>;
	delete(input: StorageObjectRef): Promise<boolean>;
	/**
	 * A signed, expiring platform route that streams the decrypted body. Stored
	 * objects are encrypted, so a presigned object-store URL would hand out
	 * ciphertext; both adapters return the same platform route instead. The value
	 * is a path, not an absolute URL: the platform serves it under its own origin
	 * and the package does not know one.
	 */
	readUrl(input: StorageReadUrlInput): Promise<string>;
	/** Metadata without the body. The frame header is read, never decrypted. */
	stat(input: StorageObjectRef): Promise<StoredObject | null>;
	dispose(): Promise<void>;
}

/**
 * A tenant, module or object id. No path separator, no leading dot, so the key
 * layout below cannot be escaped and a local path cannot traverse.
 */
export const STORAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const STORAGE_READ_ROUTE_PREFIX = '/api/storage/objects/';

export const STORAGE_READ_URL_MAX_SECONDS = 3600;

function assertId(value: string, position: string): void {
	if (!STORAGE_ID_PATTERN.test(value)) {
		throw new StorageError(
			'OBJECT_REFERENCE_INVALID',
			`A storage ${position} must match ${STORAGE_ID_PATTERN.source}.`,
		);
	}
}

/**
 * `<tenantId>/<moduleId>/<objectId>`. The tenant prefix is what separates one
 * workspace's objects from another's, so it is built here and never assembled
 * by a caller.
 */
export function storageObjectKey(reference: StorageObjectRef): string {
	assertId(reference.tenantId, 'tenant id');
	assertId(reference.moduleId, 'module id');
	assertId(reference.objectId, 'object id');
	return `${reference.tenantId}/${reference.moduleId}/${reference.objectId}`;
}
