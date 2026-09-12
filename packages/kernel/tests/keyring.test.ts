import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	createKeyring,
	keyFingerprint,
	KeyringError,
	KEYRING_MAX_PREVIOUS_KEYS,
	parsePreviousKeys,
	type SealedEnvelope,
} from '../src/keyring.ts';

const KEY_A = Buffer.alloc(32, 0x41);
const KEY_B = Buffer.alloc(32, 0x42);
const KEY_C = Buffer.alloc(32, 0x43);

function withoutKeyId(envelope: SealedEnvelope) {
	return {
		iv: envelope.iv,
		tag: envelope.tag,
		ciphertext: envelope.ciphertext,
	};
}

describe('key fingerprints', () => {
	/* agents.core and automations.core store this string in every row and
	   workflows.core stores it behind a `sha256:` prefix. A different scheme
	   would orphan every stored envelope. */
	it('is the first 16 hex characters of the sha-256 of the key material', () => {
		expect(keyFingerprint(KEY_A)).toBe(
			createHash('sha256').update(KEY_A).digest('hex').slice(0, 16),
		);
		expect(keyFingerprint(KEY_A)).toHaveLength(16);
		expect(keyFingerprint(KEY_A)).not.toBe(keyFingerprint(KEY_B));
	});

	it('names the current key of a ring', () => {
		expect(createKeyring({ current: KEY_A }).keyId).toBe(keyFingerprint(KEY_A));
	});
});

describe('sealing', () => {
	it('opens what it sealed, with and without additional data', () => {
		const ring = createKeyring({ current: KEY_A });
		const plain = ring.open(ring.seal('provider-token'));
		expect(plain.toString('utf8')).toBe('provider-token');
		const bound = ring.seal('provider-token', 'tenant-a:1:openai');
		expect(ring.open(bound, 'tenant-a:1:openai').toString('utf8')).toBe(
			'provider-token',
		);
	});

	it('seals under the current key and never under a previous one', () => {
		const ring = createKeyring({ current: KEY_B, previous: [KEY_A] });
		expect(ring.seal('x').keyId).toBe(keyFingerprint(KEY_B));
	});

	it('uses a fresh nonce for every envelope', () => {
		const ring = createKeyring({ current: KEY_A });
		const nonces = new Set(
			Array.from({ length: 32 }, () => ring.seal('same').iv.toString('hex')),
		);
		expect(nonces.size).toBe(32);
	});

	it('carries binary payloads unchanged', () => {
		const ring = createKeyring({ current: KEY_A });
		const payload = randomBytes(1024);
		expect(ring.open(ring.seal(payload)).equals(payload)).toBe(true);
	});
});

describe('rotation', () => {
	it('opens an envelope sealed by the key that is now previous', () => {
		const before = createKeyring({ current: KEY_A });
		const sealed = before.seal('secret', 'aad');
		const after = createKeyring({ current: KEY_B, previous: [KEY_A] });
		expect(after.open(sealed, 'aad').toString('utf8')).toBe('secret');
		expect(after.keyId).toBe(keyFingerprint(KEY_B));
		expect(after.previousKeyIds).toEqual([keyFingerprint(KEY_A)]);
	});

	it('refuses an envelope whose key left the ring', () => {
		const sealed = createKeyring({ current: KEY_A }).seal('secret');
		const ring = createKeyring({ current: KEY_B, previous: [KEY_C] });
		expect(() => ring.open(sealed)).toThrowError(
			expect.objectContaining({ code: 'KEY_UNKNOWN' }),
		);
		expect(ring.knows(sealed.keyId)).toBe(false);
	});

	it('ignores a previous key that repeats the current one', () => {
		const ring = createKeyring({
			current: KEY_A,
			previous: [KEY_A, KEY_B, KEY_B],
		});
		expect(ring.previousKeyIds).toEqual([keyFingerprint(KEY_B)]);
	});

	it('bounds the ring so an open without a key id stays cheap', () => {
		const previous = Array.from({ length: KEYRING_MAX_PREVIOUS_KEYS + 1 }, () =>
			randomBytes(32),
		);
		expect(() => createKeyring({ current: KEY_A, previous })).toThrowError(
			/at most 8 previous keys/,
		);
	});

	it('refuses key material that is not 32 bytes', () => {
		expect(() => createKeyring({ current: Buffer.alloc(31) })).toThrowError(
			/current key must be exactly 32 bytes/,
		);
		expect(() =>
			createKeyring({ current: KEY_A, previous: [Buffer.alloc(33)] }),
		).toThrowError(/previous key must be exactly 32 bytes/);
	});

	it('keeps its own copy of the key material', () => {
		const key = Buffer.alloc(32, 0x51);
		const ring = createKeyring({ current: key });
		const sealed = ring.seal('secret');
		key.fill(0);
		expect(ring.open(sealed).toString('utf8')).toBe('secret');
	});
});

describe('envelopes without a key id', () => {
	it('falls back across the ring in order', () => {
		const sealed = createKeyring({ current: KEY_C }).seal('legacy', 'aad');
		const ring = createKeyring({ current: KEY_A, previous: [KEY_B, KEY_C] });
		expect(ring.open(withoutKeyId(sealed), 'aad').toString('utf8')).toBe(
			'legacy',
		);
	});

	it('reports KEY_UNKNOWN when no key in the ring opens it', () => {
		const sealed = createKeyring({ current: KEY_C }).seal('legacy');
		const ring = createKeyring({ current: KEY_A, previous: [KEY_B] });
		expect(() => ring.open(withoutKeyId(sealed))).toThrowError(
			expect.objectContaining({ code: 'KEY_UNKNOWN' }),
		);
	});
});

describe('invalid envelopes', () => {
	const ring = createKeyring({ current: KEY_A });

	it('rejects a tampered ciphertext under a known key', () => {
		const sealed = ring.seal('secret');
		sealed.ciphertext[0] = 0xff ^ (sealed.ciphertext[0] ?? 0);
		expect(() => ring.open(sealed)).toThrowError(
			expect.objectContaining({ code: 'ENVELOPE_INVALID' }),
		);
	});

	it('rejects the wrong additional data', () => {
		const sealed = ring.seal('secret', 'tenant-a');
		try {
			ring.open(sealed, 'tenant-b');
			expect.unreachable('opening under the wrong aad must fail');
		} catch (error) {
			expect(error).toBeInstanceOf(KeyringError);
			expect((error as KeyringError).code).toBe('ENVELOPE_INVALID');
			expect((error as KeyringError).cause).toBeDefined();
		}
	});

	it('rejects a nonce or tag of the wrong length before trying a key', () => {
		const sealed = ring.seal('secret');
		for (const broken of [
			{ ...sealed, iv: sealed.iv.subarray(0, 11) },
			{ ...sealed, tag: Buffer.alloc(0) },
		]) {
			expect(() => ring.open(broken)).toThrowError(
				expect.objectContaining({ code: 'ENVELOPE_INVALID' }),
			);
		}
	});
});

describe('previous key lists', () => {
	it('reads a comma-separated list and drops empty entries', () => {
		expect(parsePreviousKeys(' a , b ,,c, ', (entry) => entry)).toEqual([
			'a',
			'b',
			'c',
		]);
	});

	it('is empty when the variable is unset or blank', () => {
		expect(parsePreviousKeys(undefined, (entry) => entry)).toEqual([]);
		expect(parsePreviousKeys('', (entry) => entry)).toEqual([]);
		expect(parsePreviousKeys('  ,  ', (entry) => entry)).toEqual([]);
	});

	it('reports a bad entry through the decoder of the caller', () => {
		expect(() =>
			parsePreviousKeys('not-a-key', () => {
				throw new Error('FD_TEST_KEY_PREVIOUS must be base64.');
			}),
		).toThrowError(/must be base64/);
	});
});
