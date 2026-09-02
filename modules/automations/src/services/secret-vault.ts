import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from 'node:crypto';
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { coreloomLocalDataPath } from '@coreloom/kernel/legacy-local-state';

export interface EncryptedSecret {
	readonly keyId: string;
	readonly iv: string;
	readonly tag: string;
	readonly ciphertext: string;
}

export interface SecretVault {
	encrypt(secret: string, context: string): EncryptedSecret;
	decrypt(envelope: EncryptedSecret, context: string): string;
}

function encryptionKey(value: string): Buffer {
	const key = Buffer.from(value.trim(), 'base64');
	if (key.byteLength !== 32) {
		key.fill(0);
		throw new Error(
			'CL_AUTOMATIONS_CREDENTIAL_KEY must be a base64-encoded 32-byte key.',
		);
	}
	return key;
}

export class AesGcmSecretVault implements SecretVault {
	readonly #key: Buffer;
	readonly #keyId: string;

	constructor(key: Buffer) {
		if (key.byteLength !== 32) {
			throw new Error('Automation secret encryption requires a 32-byte key.');
		}
		this.#key = Buffer.from(key);
		this.#keyId = createHash('sha256').update(key).digest('hex').slice(0, 16);
	}

	encrypt(secret: string, context: string): EncryptedSecret {
		const normalized = secret.trim();
		if (normalized.length < 8 || normalized.length > 16_384) {
			throw new Error('Automation secrets must contain 8 to 16384 characters.');
		}
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
		cipher.setAAD(Buffer.from(context, 'utf8'));
		const ciphertext = Buffer.concat([
			cipher.update(normalized, 'utf8'),
			cipher.final(),
		]);
		return {
			keyId: this.#keyId,
			iv: iv.toString('base64'),
			tag: cipher.getAuthTag().toString('base64'),
			ciphertext: ciphertext.toString('base64'),
		};
	}

	decrypt(envelope: EncryptedSecret, context: string): string {
		if (envelope.keyId !== this.#keyId) {
			throw new Error('The automation secret encryption key is unavailable.');
		}
		const decipher = createDecipheriv(
			'aes-256-gcm',
			this.#key,
			Buffer.from(envelope.iv, 'base64'),
		);
		decipher.setAAD(Buffer.from(context, 'utf8'));
		decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
		return Buffer.concat([
			decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
			decipher.final(),
		]).toString('utf8');
	}
}

function developmentKey(path: string): Buffer {
	try {
		return encryptionKey(readFileSync(path, 'utf8'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const descriptor = openSync(path, 'wx', 0o600);
	try {
		const encoded = randomBytes(32).toString('base64');
		writeFileSync(descriptor, encoded, { encoding: 'utf8' });
		return encryptionKey(encoded);
	} finally {
		closeSync(descriptor);
	}
}

export function secretVaultFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): SecretVault {
	const configured = environment.CL_AUTOMATIONS_CREDENTIAL_KEY;
	if (configured) return new AesGcmSecretVault(encryptionKey(configured));
	if (environment.NODE_ENV === 'production') {
		throw new Error('CL_AUTOMATIONS_CREDENTIAL_KEY is required in production.');
	}
	if (environment.NODE_ENV === 'test') {
		return new AesGcmSecretVault(Buffer.alloc(32, 0x41));
	}
	return new AesGcmSecretVault(
		developmentKey(
			coreloomLocalDataPath(workspaceRoot, 'automations-credential.key'),
		),
	);
}
