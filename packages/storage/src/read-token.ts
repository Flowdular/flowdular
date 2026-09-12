import { KeyringError, type Keyring } from '@flowdular/kernel';
import {
	StorageError,
	STORAGE_READ_ROUTE_PREFIX,
	STORAGE_READ_URL_MAX_SECONDS,
	type StorageObjectRef,
} from './contracts.ts';

/* The read token is the capability: it names the object, carries its own
   expiry, and needs no session. It is sealed rather than signed, so the tenant
   id never travels in a URL a proxy or a browser history would keep, and the
   GCM tag is what makes a forged token impossible rather than merely unlikely.

     version(1) | keyId(16 ascii) | iv(12) | tag(16) | ciphertext

   The additional data is a constant unique to this use, so an object envelope
   can never be replayed as a token and vice versa. */

const TOKEN_VERSION = 1;
const KEY_ID_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + KEY_ID_BYTES + IV_BYTES + TAG_BYTES;
const TOKEN_AAD = 'flowdular-storage-read-token:v1';
/* A payload is a fixed handful of ids; anything longer is not one, and parsing
   stops before the decode rather than after it. */
const TOKEN_CHARACTER_LIMIT = 1024;

interface TokenPayload {
	readonly t: string;
	readonly m: string;
	readonly o: string;
	readonly e: number;
}

export interface StorageReadToken extends StorageObjectRef {
	readonly expiresAt: Date;
}

export function mintStorageReadToken(
	keyring: Keyring,
	input: StorageObjectRef & {
		readonly expiresInSeconds: number;
		readonly now: Date;
	},
): string {
	if (
		!Number.isInteger(input.expiresInSeconds) ||
		input.expiresInSeconds < 1 ||
		input.expiresInSeconds > STORAGE_READ_URL_MAX_SECONDS
	) {
		throw new StorageError(
			'EXPIRY_INVALID',
			`A read URL expires in 1 to ${STORAGE_READ_URL_MAX_SECONDS} seconds.`,
		);
	}
	const payload: TokenPayload = {
		t: input.tenantId,
		m: input.moduleId,
		o: input.objectId,
		e:
			Math.floor(input.now.getTime() / 1000) +
			Math.trunc(input.expiresInSeconds),
	};
	const sealed = keyring.seal(JSON.stringify(payload), TOKEN_AAD);
	const keyId = Buffer.from(sealed.keyId.padEnd(KEY_ID_BYTES, '0'), 'latin1');
	return Buffer.concat([
		Buffer.of(TOKEN_VERSION),
		keyId.subarray(0, KEY_ID_BYTES),
		sealed.iv,
		sealed.tag,
		sealed.ciphertext,
	]).toString('base64url');
}

/**
 * The token's object reference, or null for anything a caller must not be able
 * to tell apart: a malformed token, a key this ring does not hold, a forged tag
 * and an expired capability all answer the same way.
 */
export function openStorageReadToken(
	keyring: Keyring,
	token: string,
	now: Date,
): StorageReadToken | null {
	if (token.length === 0 || token.length > TOKEN_CHARACTER_LIMIT) return null;
	const raw = Buffer.from(token, 'base64url');
	if (raw.byteLength <= HEADER_BYTES || raw[0] !== TOKEN_VERSION) return null;
	let opened: Buffer;
	try {
		opened = keyring.open(
			{
				keyId: raw.subarray(1, 1 + KEY_ID_BYTES).toString('latin1'),
				iv: raw.subarray(1 + KEY_ID_BYTES, 1 + KEY_ID_BYTES + IV_BYTES),
				tag: raw.subarray(1 + KEY_ID_BYTES + IV_BYTES, HEADER_BYTES),
				ciphertext: raw.subarray(HEADER_BYTES),
			},
			TOKEN_AAD,
		);
	} catch (error) {
		if (error instanceof KeyringError) return null;
		throw error;
	}
	let payload: TokenPayload;
	try {
		payload = JSON.parse(opened.toString('utf8')) as TokenPayload;
	} catch {
		return null;
	}
	if (
		typeof payload.t !== 'string' ||
		typeof payload.m !== 'string' ||
		typeof payload.o !== 'string' ||
		!Number.isSafeInteger(payload.e)
	) {
		return null;
	}
	const expiresAt = new Date(payload.e * 1000);
	if (expiresAt.getTime() <= now.getTime()) return null;
	return {
		tenantId: payload.t,
		moduleId: payload.m,
		objectId: payload.o,
		expiresAt,
	};
}

export function storageReadUrl(token: string): string {
	return `${STORAGE_READ_ROUTE_PREFIX}${token}`;
}
