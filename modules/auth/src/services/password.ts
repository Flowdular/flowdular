import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export interface PasswordHashOptions {
	readonly cost: number;
	readonly blockSize: number;
	readonly parallelization: number;
	readonly keyLength: number;
	readonly maxMemory: number;
}

export const DEFAULT_PASSWORD_HASH_OPTIONS: PasswordHashOptions = {
	cost: 2 ** 17,
	blockSize: 8,
	parallelization: 1,
	keyLength: 64,
	maxMemory: 192 * 1024 * 1024,
};

/**
 * Stored where an account holds no password at all. `hashPassword` only ever
 * produces a `scrypt$...` encoding, so no password can hash to this, and
 * `verifyPassword` refuses it before deriving anything. The account is reached
 * through the reset flow, an administrative temporary password, or an external
 * identity; nothing about it is guessable, because there is nothing to guess.
 */
export const UNUSABLE_PASSWORD_HASH = 'none$unusable';

/** False only for an account created without a password and never given one. */
export function passwordIsSet(encoded: string): boolean {
	return encoded !== UNUSABLE_PASSWORD_HASH;
}

function derive(
	password: string,
	salt: Buffer,
	options: PasswordHashOptions,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(
			password,
			salt,
			options.keyLength,
			{
				cost: options.cost,
				blockSize: options.blockSize,
				parallelization: options.parallelization,
				maxmem: options.maxMemory,
			},
			(error, key) => {
				if (error) reject(error);
				else resolve(key as Buffer);
			},
		);
	});
}

export async function hashPassword(
	password: string,
	options: PasswordHashOptions = DEFAULT_PASSWORD_HASH_OPTIONS,
): Promise<string> {
	const salt = randomBytes(16);
	const key = await derive(password, salt, options);
	return [
		'scrypt',
		String(options.cost),
		String(options.blockSize),
		String(options.parallelization),
		salt.toString('base64url'),
		key.toString('base64url'),
	].join('$');
}

export async function verifyPassword(
	password: string,
	encoded: string,
): Promise<boolean> {
	const [
		algorithm,
		costValue,
		blockSizeValue,
		parallelizationValue,
		saltValue,
		keyValue,
	] = encoded.split('$');
	if (
		algorithm !== 'scrypt' ||
		!costValue ||
		!blockSizeValue ||
		!parallelizationValue ||
		!saltValue ||
		!keyValue
	) {
		return false;
	}

	const expected = Buffer.from(keyValue, 'base64url');
	const options: PasswordHashOptions = {
		cost: Number(costValue),
		blockSize: Number(blockSizeValue),
		parallelization: Number(parallelizationValue),
		keyLength: expected.byteLength,
		maxMemory: Math.max(192 * 1024 * 1024, 256 * Number(costValue)),
	};
	if (
		!Number.isSafeInteger(options.cost) ||
		!Number.isSafeInteger(options.blockSize) ||
		!Number.isSafeInteger(options.parallelization) ||
		options.cost < 2 ||
		options.blockSize < 1 ||
		options.parallelization < 1 ||
		expected.byteLength < 32
	) {
		return false;
	}

	try {
		const actual = await derive(
			password,
			Buffer.from(saltValue, 'base64url'),
			options,
		);
		return (
			actual.byteLength === expected.byteLength &&
			timingSafeEqual(actual, expected)
		);
	} catch {
		return false;
	}
}
