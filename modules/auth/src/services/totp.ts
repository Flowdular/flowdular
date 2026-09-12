import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createKeyring, parsePreviousKeys } from '@flowdular/kernel';
import { AuthServiceError } from './auth-service-error.ts';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function createTotpSecret(): string {
	let result = '';
	for (const byte of randomBytes(20)) result += BASE32[byte & 31]!;
	return result;
}

function decodeBase32(value: string): Buffer {
	const normalized = value.replace(/[\s-]/g, '').toUpperCase();
	if (!/^[A-Z2-7]{16,128}$/.test(normalized)) {
		throw new AuthServiceError(
			'MFA_CONFIGURATION_INVALID',
			'The MFA configuration is invalid.',
			500,
		);
	}
	let bits = 0;
	let carry = 0;
	const output: number[] = [];
	for (const character of normalized) {
		carry = (carry << 5) | BASE32.indexOf(character);
		bits += 5;
		if (bits >= 8) {
			output.push((carry >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(output);
}

function codeAt(secret: string, timestamp: number): string {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(timestamp / 30_000)));
	const digest = createHmac('sha1', decodeBase32(secret))
		.update(counter)
		.digest();
	const offset = digest[digest.length - 1]! & 15;
	const integer =
		((digest[offset]! & 127) << 24) |
		(digest[offset + 1]! << 16) |
		(digest[offset + 2]! << 8) |
		digest[offset + 3]!;
	return String(integer % 1_000_000).padStart(6, '0');
}

export function verifyTotp(
	secret: string,
	submitted: string,
	now: number,
): boolean {
	if (!/^\d{6}$/.test(submitted)) return false;
	const value = Buffer.from(submitted, 'utf8');
	for (const offset of [-30_000, 0, 30_000]) {
		const expected = Buffer.from(codeAt(secret, now + offset), 'utf8');
		if (timingSafeEqual(value, expected)) return true;
	}
	return false;
}

/** The envelope columns of one enrolled factor. */
export interface SealedMfaSecret {
	readonly keyId: string;
	readonly ciphertext: string;
}

export interface MfaSecretVault {
	/** Key id every new envelope is written with; stored rows may carry older ones. */
	readonly keyId: string;
	seal(secret: string): SealedMfaSecret;
	/** `keyId` is absent on a row written before the key id column existed. */
	open(ciphertext: string, keyId?: string | null): string;
}

function notConfigured(): AuthServiceError {
	return new AuthServiceError(
		'MFA_NOT_CONFIGURED',
		'Multi-factor authentication is not configured for this deployment.',
		503,
	);
}

function configurationInvalid(cause?: unknown): AuthServiceError {
	return new AuthServiceError(
		'MFA_CONFIGURATION_INVALID',
		'The MFA configuration is invalid.',
		500,
		cause === undefined ? undefined : { cause },
	);
}

function encryptionKey(value: string | undefined): Buffer {
	if (!value) throw notConfigured();
	const key = Buffer.from(
		value,
		/^[0-9a-f]{64}$/i.test(value) ? 'hex' : 'base64url',
	);
	if (key.byteLength !== 32) throw notConfigured();
	return key;
}

/**
 * The key set that protects enrolled TOTP secrets at rest: one current key that
 * seals every new envelope, and the keys kept only to open the rows a rotation
 * has not re-sealed yet. The stored envelope stays `iv.ciphertext.tag` in
 * base64url exactly as rows written before the key id existed; only the id of
 * the key moved, into its own column, so a row that carries none is opened by
 * trying the ring in order.
 */
export function createMfaSecretVault(
	current: string | undefined,
	previous: readonly string[] = [],
): MfaSecretVault {
	const keyring = createKeyring({
		current: encryptionKey(current),
		previous: previous.map((entry) => encryptionKey(entry)),
	});
	return {
		keyId: keyring.keyId,
		seal(secret) {
			const sealed = keyring.seal(secret);
			return {
				keyId: sealed.keyId,
				ciphertext: `${sealed.iv.toString('base64url')}.${sealed.ciphertext.toString('base64url')}.${sealed.tag.toString('base64url')}`,
			};
		},
		open(ciphertext, keyId) {
			const [ivValue, ciphertextValue, tagValue] = ciphertext.split('.');
			if (!ivValue || !ciphertextValue || !tagValue) {
				throw configurationInvalid();
			}
			try {
				return keyring
					.open({
						keyId: keyId ?? undefined,
						iv: Buffer.from(ivValue, 'base64url'),
						tag: Buffer.from(tagValue, 'base64url'),
						ciphertext: Buffer.from(ciphertextValue, 'base64url'),
					})
					.toString('utf8');
			} catch (error) {
				/* The kernel code reaches a caller on the cause: a key that is simply
				   absent from the ring and a corrupt row are the same refusal here. */
				throw configurationInvalid(error);
			}
		},
	};
}

export function mfaSecretVaultFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): MfaSecretVault {
	return createMfaSecretVault(
		environment.FD_AUTH_MFA_KEY,
		parsePreviousKeys(environment.FD_AUTH_MFA_KEY_PREVIOUS, (entry) => entry),
	);
}
