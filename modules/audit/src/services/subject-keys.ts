import { createHash, randomBytes } from 'node:crypto';
import { createKeyring, KeyringError } from '@flowdular/kernel';

/**
 * The envelope a sealed audit event carries, as one stored string. A per-subject
 * data key seals it; destroying that key is the erasure, so the material lives
 * beside the ciphertext on purpose. It buys crypto-shredding, not confidentiality
 * at rest, which the deployment provides for the volume and the backup.
 */
export const SUBJECT_KEY_BYTES = 32;

export function generateSubjectKey(): Buffer {
	return randomBytes(SUBJECT_KEY_BYTES);
}

export function encodeSubjectKey(key: Buffer): string {
	return key.toString('base64');
}

export function decodeSubjectKey(value: string): Buffer {
	const key = Buffer.from(value, 'base64');
	if (key.byteLength !== SUBJECT_KEY_BYTES) {
		key.fill(0);
		throw new Error('A stored audit subject key is not 32 bytes.');
	}
	return key;
}

/**
 * The name a subject keeps once its key is gone. The key row, the erasure run
 * and the certificate file all carry it, so a destroyed key is still findable
 * without storing the account it belonged to: a subject whose key was destroyed
 * must never be given a new one, and the marker is what proves it had one.
 */
export function erasureSubjectMarker(
	tenantId: string,
	subject: string,
): string {
	return createHash('sha256')
		.update(`${tenantId}:${subject}`)
		.digest('hex')
		.slice(0, 12);
}

/**
 * The additional data every sealed event is bound to. It is part of the stored
 * envelope, so it can never change for a row that already exists.
 */
export function subjectSealContext(tenantId: string, eventId: string): string {
	return `${tenantId}:${eventId}:audit-event`;
}

/** `iv.tag.ciphertext`, base64 each, so one column holds the whole envelope. */
export function sealSubjectPayload(
	key: Buffer,
	context: string,
	plaintext: string,
): string {
	const sealed = createKeyring({ current: key }).seal(plaintext, context);
	return [
		sealed.iv.toString('base64'),
		sealed.tag.toString('base64'),
		sealed.ciphertext.toString('base64'),
	].join('.');
}

/** Null for an envelope this key cannot open, which a destroyed key never can. */
export function openSubjectPayload(
	key: Buffer,
	context: string,
	payload: string,
): string | null {
	const parts = payload.split('.');
	if (parts.length !== 3) return null;
	try {
		return createKeyring({ current: key })
			.open(
				{
					iv: Buffer.from(parts[0]!, 'base64'),
					tag: Buffer.from(parts[1]!, 'base64'),
					ciphertext: Buffer.from(parts[2]!, 'base64'),
				},
				context,
			)
			.toString('utf8');
	} catch (error) {
		if (error instanceof KeyringError) return null;
		throw error;
	}
}
