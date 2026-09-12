import { randomBytes } from 'node:crypto';
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
	createKeyring,
	KeyringError,
	parsePreviousKeys,
	type Keyring,
} from '@flowdular/kernel';
import { flowdularLocalDataPath } from '@flowdular/kernel/legacy-local-state';

export interface EncryptedSecret {
	readonly keyId: string;
	readonly iv: string;
	readonly tag: string;
	readonly ciphertext: string;
}

/**
 * The additional data every trigger secret envelope is bound to. It is part of
 * the stored envelope: re-sealing a row under a new key must rebuild exactly
 * this string, so it lives with the envelope format and not with a service.
 */
export function secretContext(tenantId: string, triggerId: string): string {
	return `${tenantId}:${triggerId}:automation-trigger`;
}

export interface SecretVault {
	/** Key id every new envelope is written with; stored rows may carry older ones. */
	readonly keyId: string;
	encrypt(secret: string, context: string): EncryptedSecret;
	decrypt(envelope: EncryptedSecret, context: string): string;
}

function encryptionKey(
	value: string,
	variable = 'FD_AUTOMATIONS_CREDENTIAL_KEY',
): Buffer {
	const key = Buffer.from(value.trim(), 'base64');
	if (key.byteLength !== 32) {
		key.fill(0);
		throw new Error(`${variable} must be a base64-encoded 32-byte key.`);
	}
	return key;
}

export class AesGcmSecretVault implements SecretVault {
	readonly #keyring: Keyring;

	/* `previous` holds the keys a rotation has not finished retiring: they open
	   stored rows, and nothing is ever written with them. */
	constructor(key: Buffer, previous: readonly Buffer[] = []) {
		if (key.byteLength !== 32) {
			throw new Error('Automation secret encryption requires a 32-byte key.');
		}
		this.#keyring = createKeyring({ current: key, previous });
	}

	get keyId(): string {
		return this.#keyring.keyId;
	}

	encrypt(secret: string, context: string): EncryptedSecret {
		const normalized = secret.trim();
		if (normalized.length < 8 || normalized.length > 16_384) {
			throw new Error('Automation secrets must contain 8 to 16384 characters.');
		}
		const sealed = this.#keyring.seal(normalized, context);
		return {
			keyId: sealed.keyId,
			iv: sealed.iv.toString('base64'),
			tag: sealed.tag.toString('base64'),
			ciphertext: sealed.ciphertext.toString('base64'),
		};
	}

	decrypt(envelope: EncryptedSecret, context: string): string {
		try {
			return this.#keyring
				.open(
					{
						keyId: envelope.keyId,
						iv: Buffer.from(envelope.iv, 'base64'),
						tag: Buffer.from(envelope.tag, 'base64'),
						ciphertext: Buffer.from(envelope.ciphertext, 'base64'),
					},
					context,
				)
				.toString('utf8');
		} catch (error) {
			if (error instanceof KeyringError && error.code === 'KEY_UNKNOWN') {
				throw new Error(
					'The automation secret encryption key is unavailable.',
					{
						cause: error,
					},
				);
			}
			throw error;
		}
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
	const previous = parsePreviousKeys(
		environment.FD_AUTOMATIONS_CREDENTIAL_KEY_PREVIOUS,
		(entry) => encryptionKey(entry, 'FD_AUTOMATIONS_CREDENTIAL_KEY_PREVIOUS'),
	);
	const configured = environment.FD_AUTOMATIONS_CREDENTIAL_KEY;
	if (configured) {
		return new AesGcmSecretVault(encryptionKey(configured), previous);
	}
	if (environment.NODE_ENV === 'production') {
		throw new Error('FD_AUTOMATIONS_CREDENTIAL_KEY is required in production.');
	}
	if (environment.NODE_ENV === 'test') {
		return new AesGcmSecretVault(Buffer.alloc(32, 0x41), previous);
	}
	return new AesGcmSecretVault(
		developmentKey(
			flowdularLocalDataPath(workspaceRoot, 'automations-credential.key'),
		),
		previous,
	);
}
