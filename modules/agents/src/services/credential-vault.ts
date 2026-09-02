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

export interface EncryptedCredential {
	readonly keyId: string;
	readonly iv: string;
	readonly tag: string;
	readonly ciphertext: string;
}

export interface CredentialVault {
	encrypt(credential: string, context: string): EncryptedCredential;
	decrypt(envelope: EncryptedCredential, context: string): string;
}

function encryptionKey(value: string): Buffer {
	const key = Buffer.from(value.trim(), 'base64');
	if (key.byteLength !== 32) {
		key.fill(0);
		throw new Error(
			'CL_AGENT_CREDENTIAL_KEY must be a base64-encoded 32-byte key.',
		);
	}
	return key;
}

function keyId(key: Buffer): string {
	return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export class AesGcmCredentialVault implements CredentialVault {
	readonly #key: Buffer;
	readonly #keyId: string;

	constructor(key: Buffer) {
		if (key.byteLength !== 32) {
			throw new Error('Credential encryption requires a 32-byte key.');
		}
		this.#key = Buffer.from(key);
		this.#keyId = keyId(key);
	}

	encrypt(credential: string, context: string): EncryptedCredential {
		const normalized = credential.trim();
		if (normalized.length < 8 || normalized.length > 16_384) {
			throw new Error(
				'Provider credential must contain 8 to 16384 characters.',
			);
		}
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
		cipher.setAAD(Buffer.from(context, 'utf8'));
		const ciphertext = Buffer.concat([
			cipher.update(normalized, 'utf8'),
			cipher.final(),
		]);
		const tag = cipher.getAuthTag();
		return {
			keyId: this.#keyId,
			iv: iv.toString('base64'),
			tag: tag.toString('base64'),
			ciphertext: ciphertext.toString('base64'),
		};
	}

	decrypt(envelope: EncryptedCredential, context: string): string {
		if (envelope.keyId !== this.#keyId) {
			throw new Error('The credential encryption key is unavailable.');
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

function readOrCreateDevelopmentKey(path: string): Buffer {
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
	const configured = environment.CL_AGENT_CREDENTIAL_KEY;
	if (configured) return new AesGcmCredentialVault(encryptionKey(configured));
	if (environment.NODE_ENV === 'production') {
		throw new Error(
			'CL_AGENT_CREDENTIAL_KEY is required in production before provider credentials can be used.',
		);
	}
	if (environment.NODE_ENV === 'test') {
		return new AesGcmCredentialVault(Buffer.alloc(32, 0x43));
	}
	return new AesGcmCredentialVault(
		readOrCreateDevelopmentKey(
			coreloomLocalDataPath(workspaceRoot, 'agent-credential.key'),
		),
	);
}
