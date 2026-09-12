import { createHmac, randomBytes } from 'node:crypto';
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

export interface SealedCredential {
	readonly keyId: string;
	readonly iv: string;
	readonly tag: string;
	readonly ciphertext: string;
}

/** Characters of the digest an owner compares after a credential change. */
export const CREDENTIAL_FINGERPRINT_LENGTH = 32;

/**
 * Domain separator for the fingerprint key. The sealing key never signs
 * anything directly, so a fingerprint can never be confused with a tag.
 */
const FINGERPRINT_INFO = 'connectors-credential-fingerprint/v1';
/** Plain credential JSON never exceeds this before it is sealed. */
export const MAX_CREDENTIAL_CHARACTERS = 8_192;

/**
 * The additional data every credential envelope is bound to. It is part of the
 * stored envelope: a rotation re-sealing a row under a new key must rebuild
 * exactly this string, so it lives with the envelope format.
 */
export function credentialContext(
	tenantId: string,
	instanceId: string,
): string {
	return `${tenantId}:${instanceId}:connectors-credential`;
}

export interface CredentialVault {
	/** Key id every new envelope is written with; stored rows may carry older ones. */
	readonly keyId: string;
	seal(secret: string, context: string): SealedCredential;
	open(envelope: SealedCredential, context: string): string;
	/**
	 * Shown to owners so a credential change is verifiable without the
	 * credential. It is a keyed digest under this module's own key and is bound
	 * to the same tenant and instance the envelope is: a reader who obtains the
	 * column learns neither the secret nor whether two workspaces hold the same
	 * one. A row written before this keying keeps its old value until its
	 * credential is next replaced, which is a display difference only.
	 */
	fingerprint(secret: string, context: string): string;
}

function encryptionKey(
	value: string,
	variable = 'FD_CONNECTORS_SECRET_KEY',
): Buffer {
	const key = Buffer.from(value.trim(), 'base64');
	if (key.byteLength !== 32) {
		key.fill(0);
		throw new Error(`${variable} must be a base64-encoded 32-byte key.`);
	}
	return key;
}

export class AesGcmCredentialVault implements CredentialVault {
	readonly #keyring: Keyring;
	/* Derived once from the current key, never the key itself, so the value
	   that leaves in a fingerprint is separated from the value that seals. */
	readonly #fingerprintKey: Buffer;

	/* `previous` holds the keys a rotation has not finished retiring: they open
	   stored rows, and nothing is ever written with them. */
	constructor(key: Buffer, previous: readonly Buffer[] = []) {
		if (key.byteLength !== 32) {
			throw new Error('Connector credential sealing requires a 32-byte key.');
		}
		this.#keyring = createKeyring({ current: key, previous });
		this.#fingerprintKey = createHmac('sha256', key)
			.update(FINGERPRINT_INFO, 'utf8')
			.digest();
	}

	get keyId(): string {
		return this.#keyring.keyId;
	}

	fingerprint(secret: string, context: string): string {
		return createHmac('sha256', this.#fingerprintKey)
			.update(context, 'utf8')
			.update('\u0000', 'utf8')
			.update(secret, 'utf8')
			.digest('hex')
			.slice(0, CREDENTIAL_FINGERPRINT_LENGTH);
	}

	seal(secret: string, context: string): SealedCredential {
		if (secret.length === 0 || secret.length > MAX_CREDENTIAL_CHARACTERS) {
			throw new Error(
				`A connector credential must contain 1 to ${MAX_CREDENTIAL_CHARACTERS} characters.`,
			);
		}
		const sealed = this.#keyring.seal(secret, context);
		return {
			keyId: sealed.keyId,
			iv: sealed.iv.toString('base64'),
			tag: sealed.tag.toString('base64'),
			ciphertext: sealed.ciphertext.toString('base64'),
		};
	}

	open(envelope: SealedCredential, context: string): string {
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
					'The connector credential encryption key is unavailable.',
					{ cause: error },
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

export function credentialVaultFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): CredentialVault {
	const previous = parsePreviousKeys(
		environment.FD_CONNECTORS_SECRET_KEY_PREVIOUS,
		(entry) => encryptionKey(entry, 'FD_CONNECTORS_SECRET_KEY_PREVIOUS'),
	);
	const configured = environment.FD_CONNECTORS_SECRET_KEY;
	if (configured) {
		return new AesGcmCredentialVault(encryptionKey(configured), previous);
	}
	if (environment.NODE_ENV === 'production') {
		throw new Error('FD_CONNECTORS_SECRET_KEY is required in production.');
	}
	if (environment.NODE_ENV === 'test') {
		return new AesGcmCredentialVault(Buffer.alloc(32, 0x43), previous);
	}
	return new AesGcmCredentialVault(
		developmentKey(
			flowdularLocalDataPath(workspaceRoot, 'connectors-secret.key'),
		),
		previous,
	);
}
