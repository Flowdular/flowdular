import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
	keyFingerprint,
	KEYRING_MAX_PREVIOUS_KEYS,
	parsePreviousKeys,
} from '@flowdular/kernel';
import { flowdularLocalDataPath } from '@flowdular/kernel/legacy-local-state';
import { AuditServiceError } from './service-error.ts';

/**
 * The key an anchor signature is made under. An anchor proves that a segment of
 * the chain was closed by this deployment and not by whoever holds the file, so
 * the key never leaves the environment and never reaches an archive.
 */
export const AUDIT_ANCHOR_KEY_VARIABLE = 'FD_AUDIT_ANCHOR_KEY';
export const AUDIT_ANCHOR_KEY_PREVIOUS_VARIABLE =
	'FD_AUDIT_ANCHOR_KEY_PREVIOUS';

const KEY_BYTES = 32;

/**
 * Signs and verifies anchor hashes. Every key in the ring verifies, the current
 * one signs, so a rotation can run while the retired key still answers for the
 * anchors it wrote.
 */
export interface AnchorSigner {
	readonly keyId: string;
	readonly previousKeyIds: readonly string[];
	sign(anchorHash: string): string;
	verify(anchorHash: string, signature: string, keyId: string): boolean;
	knows(keyId: string): boolean;
}

function decodeKey(value: string, variable: string): Buffer {
	const key = Buffer.from(value.trim(), 'base64');
	if (key.byteLength !== KEY_BYTES) {
		key.fill(0);
		throw new AuditServiceError(
			'ANCHOR_KEY_INVALID',
			`${variable} must be a base64-encoded ${KEY_BYTES}-byte key.`,
			412,
		);
	}
	return key;
}

export function createAnchorSigner(
	current: Buffer,
	previous: readonly Buffer[] = [],
): AnchorSigner {
	/* The same bound the kernel keyring enforces. An anchor names the key that
	   signed it, so verification is a lookup rather than a search, but a ring
	   this long means a rotation was never finished and every retired key is
	   still able to vouch for a segment. */
	if (previous.length > KEYRING_MAX_PREVIOUS_KEYS) {
		throw new AuditServiceError(
			'ANCHOR_KEY_RING_TOO_LONG',
			`${AUDIT_ANCHOR_KEY_PREVIOUS_VARIABLE} holds at most ${KEYRING_MAX_PREVIOUS_KEYS} retired keys; ${previous.length} were given. Finish the rotation with "flowdular audit secrets-rotate --apply" and drop the keys it retired.`,
			412,
		);
	}
	const keys = new Map<string, Buffer>([[keyFingerprint(current), current]]);
	for (const key of previous) keys.set(keyFingerprint(key), key);
	const currentKeyId = keyFingerprint(current);
	const mac = (key: Buffer, anchorHash: string) =>
		createHmac('sha256', key).update(anchorHash, 'utf8').digest();
	return {
		keyId: currentKeyId,
		previousKeyIds: [...keys.keys()].filter((id) => id !== currentKeyId),
		knows: (keyId) => keys.has(keyId),
		sign: (anchorHash) => mac(current, anchorHash).toString('hex'),
		verify(anchorHash, signature, keyId) {
			const key = keys.get(keyId);
			if (!key) return false;
			const given = Buffer.from(signature, 'hex');
			const expected = mac(key, anchorHash);
			/* Equal lengths first: timingSafeEqual throws on a mismatch, and a
			   truncated signature must answer false rather than an exception. */
			return (
				given.byteLength === expected.byteLength &&
				timingSafeEqual(given, expected)
			);
		},
	};
}

function developmentKey(path: string): Buffer {
	try {
		return decodeKey(readFileSync(path, 'utf8'), AUDIT_ANCHOR_KEY_VARIABLE);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const descriptor = openSync(path, 'wx', 0o600);
	try {
		const encoded = randomBytes(KEY_BYTES).toString('base64');
		writeFileSync(descriptor, encoded, { encoding: 'utf8' });
		return decodeKey(encoded, AUDIT_ANCHOR_KEY_VARIABLE);
	} finally {
		closeSync(descriptor);
	}
}

export function anchorSignerFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): AnchorSigner {
	const previous = parsePreviousKeys(
		environment[AUDIT_ANCHOR_KEY_PREVIOUS_VARIABLE],
		(entry) => decodeKey(entry, AUDIT_ANCHOR_KEY_PREVIOUS_VARIABLE),
	);
	const configured = environment[AUDIT_ANCHOR_KEY_VARIABLE];
	if (configured) {
		return createAnchorSigner(
			decodeKey(configured, AUDIT_ANCHOR_KEY_VARIABLE),
			previous,
		);
	}
	if (environment.NODE_ENV === 'production') {
		throw new AuditServiceError(
			'ANCHOR_KEY_REQUIRED',
			`${AUDIT_ANCHOR_KEY_VARIABLE} is required in production.`,
			412,
		);
	}
	/* A test signs under a fixed key so a fixture can assert a signature; a
	   workstation keeps one generated key so anchors sealed yesterday verify. */
	if (environment.NODE_ENV === 'test') {
		return createAnchorSigner(Buffer.alloc(KEY_BYTES, 0x41), previous);
	}
	return createAnchorSigner(
		developmentKey(flowdularLocalDataPath(workspaceRoot, 'audit-anchor.key')),
		previous,
	);
}
