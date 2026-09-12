import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from 'node:crypto';

export const KEYRING_KEY_BYTES = 32;
export const KEYRING_IV_BYTES = 12;
export const KEYRING_TAG_BYTES = 16;
/* An open of an envelope without a key id tries every key in turn, so the ring
   is bounded. A chain longer than this means a rotation was never finished. */
export const KEYRING_MAX_PREVIOUS_KEYS = 8;

export type KeyringErrorCode = 'KEY_UNKNOWN' | 'ENVELOPE_INVALID';

/** A failure to open an envelope, with the code a caller may branch on. */
export class KeyringError extends Error {
	readonly code: KeyringErrorCode;

	constructor(code: KeyringErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'KeyringError';
		this.code = code;
	}
}

/** An envelope this ring produced. `keyId` names the key that sealed it. */
export interface SealedEnvelope {
	readonly keyId: string;
	readonly iv: Buffer;
	readonly tag: Buffer;
	readonly ciphertext: Buffer;
}

/**
 * An envelope read back from storage. `keyId` is absent for rows written by an
 * envelope format that never recorded one; those are opened by trying the
 * current key and then each previous key.
 */
export interface StoredEnvelope {
	readonly keyId?: string | undefined;
	readonly iv: Uint8Array;
	readonly tag: Uint8Array;
	readonly ciphertext: Uint8Array;
}

export interface Keyring {
	/** Fingerprint of the key every `seal` uses. */
	readonly keyId: string;
	readonly previousKeyIds: readonly string[];
	knows(keyId: string): boolean;
	seal(
		plaintext: Uint8Array | string,
		aad?: Uint8Array | string,
	): SealedEnvelope;
	open(envelope: StoredEnvelope, aad?: Uint8Array | string): Buffer;
}

export interface KeyringOptions {
	readonly current: Uint8Array;
	readonly previous?: readonly Uint8Array[] | undefined;
}

/**
 * The key id the module envelope formats already store: the first 16 hex
 * characters of the SHA-256 of the key material. Changing it would orphan every
 * stored row, so it is fixed.
 */
export function keyFingerprint(key: Uint8Array): string {
	return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function assertKeyLength(key: Uint8Array, position: string): void {
	if (key.byteLength !== KEYRING_KEY_BYTES) {
		throw new Error(
			`A keyring ${position} key must be exactly ${KEYRING_KEY_BYTES} bytes.`,
		);
	}
}

/* The cipher reads the bytes inside the call, so a payload that already is
   bytes is passed through rather than copied. */
function bytes(value: Uint8Array | string): Uint8Array {
	return typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
}

/**
 * An AES-256-GCM key set: one current key that seals every new envelope, and
 * the keys kept only to open envelopes written before the last rotation. An
 * envelope carries the fingerprint of the key that sealed it, so opening is a
 * lookup rather than a search, and a deployment can run with both keys while
 * the stored rows are re-sealed.
 */
export function createKeyring(options: KeyringOptions): Keyring {
	assertKeyLength(options.current, 'current');
	const previous = options.previous ?? [];
	if (previous.length > KEYRING_MAX_PREVIOUS_KEYS) {
		throw new Error(
			`A keyring accepts at most ${KEYRING_MAX_PREVIOUS_KEYS} previous keys; ${previous.length} were given.`,
		);
	}
	const current = Buffer.from(options.current);
	const currentKeyId = keyFingerprint(current);
	const keys = new Map<string, Buffer>([[currentKeyId, current]]);
	const order: Buffer[] = [current];
	for (const key of previous) {
		assertKeyLength(key, 'previous');
		const id = keyFingerprint(key);
		/* A key listed twice, or a previous list still naming the key that was
		   promoted to current, is the same key under the same id. */
		if (keys.has(id)) continue;
		const copy = Buffer.from(key);
		keys.set(id, copy);
		order.push(copy);
	}
	const previousKeyIds = order.slice(1).map((key) => keyFingerprint(key));

	const decrypt = (
		key: Buffer,
		envelope: StoredEnvelope,
		aad: Uint8Array | undefined,
	): Buffer => {
		const decipher = createDecipheriv('aes-256-gcm', key, envelope.iv);
		if (aad) decipher.setAAD(aad);
		decipher.setAuthTag(envelope.tag);
		return Buffer.concat([
			decipher.update(envelope.ciphertext),
			decipher.final(),
		]);
	};

	return {
		keyId: currentKeyId,
		previousKeyIds,
		knows: (keyId) => keys.has(keyId),
		seal(plaintext, aad) {
			const iv = randomBytes(KEYRING_IV_BYTES);
			const cipher = createCipheriv('aes-256-gcm', current, iv);
			if (aad !== undefined) cipher.setAAD(bytes(aad));
			const ciphertext = Buffer.concat([
				cipher.update(bytes(plaintext)),
				cipher.final(),
			]);
			return { keyId: currentKeyId, iv, tag: cipher.getAuthTag(), ciphertext };
		},
		open(envelope, aad) {
			if (
				envelope.iv.byteLength !== KEYRING_IV_BYTES ||
				envelope.tag.byteLength !== KEYRING_TAG_BYTES
			) {
				throw new KeyringError(
					'ENVELOPE_INVALID',
					'The envelope does not carry a 12-byte nonce and a 16-byte authentication tag.',
				);
			}
			const additional = aad === undefined ? undefined : bytes(aad);
			if (envelope.keyId !== undefined) {
				const key = keys.get(envelope.keyId);
				if (!key) {
					throw new KeyringError(
						'KEY_UNKNOWN',
						`No key in this ring has the id ${envelope.keyId}.`,
					);
				}
				try {
					return decrypt(key, envelope, additional);
				} catch (error) {
					throw new KeyringError(
						'ENVELOPE_INVALID',
						'The envelope failed authentication under the key it names.',
						{ cause: error },
					);
				}
			}
			/* No key id was stored, so the writer cannot be identified. Nothing
			   distinguishes a missing key from a corrupt row here, and the code
			   says so: KEY_UNKNOWN covers both. */
			for (const key of order) {
				try {
					return decrypt(key, envelope, additional);
				} catch {
					continue;
				}
			}
			throw new KeyringError(
				'KEY_UNKNOWN',
				'No key in this ring opens an envelope that carries no key id.',
			);
		},
	};
}

/**
 * Reads a comma-separated list of previous keys from one environment variable.
 * Empty entries are dropped, so a trailing comma is not a configuration error.
 */
export function parsePreviousKeys<T>(
	value: string | undefined,
	decode: (entry: string) => T,
): readonly T[] {
	if (!value) return [];
	return value
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.map(decode);
}
