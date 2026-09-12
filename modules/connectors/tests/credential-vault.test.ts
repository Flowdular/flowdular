import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	AesGcmCredentialVault,
	credentialContext,
	CREDENTIAL_FINGERPRINT_LENGTH,
} from '../src/services/credential-vault.ts';

const SECRET = JSON.stringify({ kind: 'bearer', token: 'bearer-token-0001' });
const CONTEXT = credentialContext('tenant-a', 'instance-1');

function vault(fill: number): AesGcmCredentialVault {
	return new AesGcmCredentialVault(Buffer.alloc(32, fill));
}

describe('credential fingerprint', () => {
	/* The plain digest of the credential let anyone holding the column confirm a
	   guessed secret offline, and told them when two workspaces shared one. */
	it('is not the digest of the credential itself', () => {
		const plain = createHash('sha256')
			.update(SECRET, 'utf8')
			.digest('hex')
			.slice(0, CREDENTIAL_FINGERPRINT_LENGTH);
		expect(vault(0x43).fingerprint(SECRET, CONTEXT)).not.toBe(plain);
	});

	it('changes with the key, so it cannot be computed without one', () => {
		expect(vault(0x43).fingerprint(SECRET, CONTEXT)).not.toBe(
			vault(0x44).fingerprint(SECRET, CONTEXT),
		);
	});

	it('separates the same credential in two workspaces', () => {
		const keyed = vault(0x43);
		expect(keyed.fingerprint(SECRET, CONTEXT)).not.toBe(
			keyed.fingerprint(SECRET, credentialContext('tenant-b', 'instance-1')),
		);
		expect(keyed.fingerprint(SECRET, CONTEXT)).not.toBe(
			keyed.fingerprint(SECRET, credentialContext('tenant-a', 'instance-2')),
		);
	});

	it('is stable for one credential under one key, at the declared length', () => {
		const keyed = vault(0x43);
		const first = keyed.fingerprint(SECRET, CONTEXT);
		expect(first).toBe(vault(0x43).fingerprint(SECRET, CONTEXT));
		expect(first).toHaveLength(CREDENTIAL_FINGERPRINT_LENGTH);
		expect(first).not.toBe(keyed.fingerprint(`${SECRET} `, CONTEXT));
	});

	it('leaks nothing of the credential into the value it shows', () => {
		expect(vault(0x43).fingerprint(SECRET, CONTEXT)).not.toContain(
			'bearer-token-0001',
		);
	});
});
