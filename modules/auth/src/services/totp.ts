import {
	createCipheriv,
	createDecipheriv,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from 'node:crypto';
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

function encryptionKey(value: string | undefined): Buffer {
	if (!value) {
		throw new AuthServiceError(
			'MFA_NOT_CONFIGURED',
			'Multi-factor authentication is not configured for this deployment.',
			503,
		);
	}
	const key = Buffer.from(
		value,
		/^[0-9a-f]{64}$/i.test(value) ? 'hex' : 'base64url',
	);
	if (key.byteLength !== 32) {
		throw new AuthServiceError(
			'MFA_NOT_CONFIGURED',
			'Multi-factor authentication is not configured for this deployment.',
			503,
		);
	}
	return key;
}

export function encryptMfaSecret(
	secret: string,
	keyValue: string | undefined,
): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', encryptionKey(keyValue), iv);
	const ciphertext = Buffer.concat([
		cipher.update(secret, 'utf8'),
		cipher.final(),
	]);
	return `${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

export function decryptMfaSecret(
	value: string,
	keyValue: string | undefined,
): string {
	const [ivValue, ciphertextValue, tagValue] = value.split('.');
	if (!ivValue || !ciphertextValue || !tagValue)
		throw new AuthServiceError(
			'MFA_CONFIGURATION_INVALID',
			'The MFA configuration is invalid.',
			500,
		);
	try {
		const decipher = createDecipheriv(
			'aes-256-gcm',
			encryptionKey(keyValue),
			Buffer.from(ivValue, 'base64url'),
		);
		decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
		return Buffer.concat([
			decipher.update(Buffer.from(ciphertextValue, 'base64url')),
			decipher.final(),
		]).toString('utf8');
	} catch (error) {
		if (error instanceof AuthServiceError) throw error;
		throw new AuthServiceError(
			'MFA_CONFIGURATION_INVALID',
			'The MFA configuration is invalid.',
			500,
		);
	}
}
