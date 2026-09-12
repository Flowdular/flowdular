import { createHash } from 'node:crypto';
import { createKeyring, parsePreviousKeys } from '@flowdular/kernel';
import { AuthServiceError } from './auth-service-error.ts';

/* The tenant provider secret shares the auth keyring with the enrolled TOTP
   factors and is separated from them by this context: an envelope sealed for
   one provider of one workspace cannot be opened as another's, so a stolen row
   is not portable between workspaces. */
const SECRET_CONTEXT = 'flowdular:auth:provider-secret:v1';
const FINGERPRINT_CONTEXT = 'flowdular:auth:provider-fingerprint:v1';
const FINGERPRINT_LENGTH = 32;

/** The row a sealed secret belongs to; it is the additional authenticated data. */
export interface ProviderSecretContext {
	readonly tenantId: string;
	readonly providerId: string;
}

export interface SealedProviderSecret {
	readonly keyId: string;
	readonly ciphertext: string;
}

export interface ProviderSecretVault {
	/** Key id every new envelope is written with; stored rows may carry older ones. */
	readonly keyId: string;
	seal(context: ProviderSecretContext, secret: string): SealedProviderSecret;
	open(
		context: ProviderSecretContext,
		ciphertext: string,
		keyId?: string | null,
	): string;
	fingerprint(secret: string): string;
}

function keyRequired(): AuthServiceError {
	return new AuthServiceError(
		'PROVIDER_KEY_REQUIRED',
		'Workspace identity providers need the deployment authentication encryption key.',
		409,
	);
}

function secretUnreadable(cause?: unknown): AuthServiceError {
	return new AuthServiceError(
		'PROVIDER_SECRET_INVALID',
		'The stored provider secret cannot be opened with the configured keys.',
		500,
		cause === undefined ? undefined : { cause },
	);
}

function encryptionKey(value: string | undefined): Buffer {
	if (!value) throw keyRequired();
	const key = Buffer.from(
		value,
		/^[0-9a-f]{64}$/i.test(value) ? 'hex' : 'base64url',
	);
	if (key.byteLength !== 32) throw keyRequired();
	return key;
}

function additionalData(context: ProviderSecretContext): string {
	return `${SECRET_CONTEXT}\0${context.tenantId}\0${context.providerId}`;
}

/**
 * What an administrator sees instead of a client secret. It is taken over the
 * secret itself rather than over an envelope, so re-sealing the same secret
 * under a new key leaves it unchanged and only a rotated secret moves it. It is
 * taken over workspace secrets only: a deployment secret is shared by every
 * workspace, so no workspace is shown a value derived from it.
 */
export function providerSecretFingerprint(secret: string): string {
	return createHash('sha256')
		.update(FINGERPRINT_CONTEXT, 'utf8')
		.update('\0', 'utf8')
		.update(secret, 'utf8')
		.digest('hex')
		.slice(0, FINGERPRINT_LENGTH);
}

/**
 * The client secrets of tenant-owned providers, sealed with the auth keyring
 * under a provider-specific context. The envelope is `iv.ciphertext.tag` in
 * base64url beside the id of the key that sealed it, exactly the shape the
 * enrolled factors use, so `auth secrets-rotate` re-seals both the same way.
 */
export function createProviderSecretVault(
	current: string | undefined,
	previous: readonly string[] = [],
): ProviderSecretVault {
	const keyring = createKeyring({
		current: encryptionKey(current),
		previous: previous.map((entry) => encryptionKey(entry)),
	});
	return {
		keyId: keyring.keyId,
		seal(context, secret) {
			const sealed = keyring.seal(secret, additionalData(context));
			return {
				keyId: sealed.keyId,
				ciphertext: `${sealed.iv.toString('base64url')}.${sealed.ciphertext.toString('base64url')}.${sealed.tag.toString('base64url')}`,
			};
		},
		open(context, ciphertext, keyId) {
			const [ivValue, ciphertextValue, tagValue] = ciphertext.split('.');
			if (!ivValue || !ciphertextValue || !tagValue) throw secretUnreadable();
			try {
				return keyring
					.open(
						{
							keyId: keyId ?? undefined,
							iv: Buffer.from(ivValue, 'base64url'),
							tag: Buffer.from(tagValue, 'base64url'),
							ciphertext: Buffer.from(ciphertextValue, 'base64url'),
						},
						additionalData(context),
					)
					.toString('utf8');
			} catch (error) {
				throw secretUnreadable(error);
			}
		},
		fingerprint: providerSecretFingerprint,
	};
}

export function providerSecretVaultFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): ProviderSecretVault {
	return createProviderSecretVault(
		environment.FD_AUTH_MFA_KEY,
		parsePreviousKeys(environment.FD_AUTH_MFA_KEY_PREVIOUS, (entry) => entry),
	);
}
