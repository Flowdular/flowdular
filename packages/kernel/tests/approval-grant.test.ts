import { describe, expect, it } from 'vitest';
import {
	APPROVAL_GRANT_MAX_TOKEN_LENGTH,
	approvalGrantKeyringFromEnvironment,
	approvalInputDigest,
	createApprovalGrantKeyring,
	issueApprovalGrant,
	verifyApprovalGrant,
} from '../src/approval-grant.ts';
import { keyFingerprint } from '../src/keyring.ts';

const KEY_A = Buffer.alloc(32, 0x41);
const KEY_B = Buffer.alloc(32, 0x42);
const NOW = 1_700_000_000_000;
const DIGEST = approvalInputDigest({ arguments: ['acme'], flags: {} });

const ring = createApprovalGrantKeyring({ current: KEY_A });

function claims(
	overrides: Partial<Parameters<typeof issueApprovalGrant>[1]> = {},
) {
	return {
		tenantId: 'tenant-a',
		capabilityId: 'billing.export',
		inputDigest: DIGEST,
		requestId: 'request-1',
		issuedAt: NOW,
		expiresAt: NOW + 60_000,
		nonce: 'request-1',
		...overrides,
	};
}

const expectation = {
	tenantId: 'tenant-a',
	capabilityId: 'billing.export',
	inputDigest: DIGEST,
};

describe('approval input digest', () => {
	it('does not depend on object key order', () => {
		expect(approvalInputDigest({ a: 1, b: [{ c: 2, d: 3 }] })).toBe(
			approvalInputDigest({ b: [{ d: 3, c: 2 }], a: 1 }),
		);
		expect(approvalInputDigest({ a: 1 })).not.toBe(
			approvalInputDigest({ a: 2 }),
		);
		expect(approvalInputDigest({ a: 1 })).toHaveLength(64);
	});
});

describe('approval grants', () => {
	it('signs a grant the same ring verifies', () => {
		const issued = issueApprovalGrant(ring, claims());
		expect(issued.keyId).toBe(keyFingerprint(KEY_A));
		expect(issued.token.length).toBeLessThanOrEqual(
			APPROVAL_GRANT_MAX_TOKEN_LENGTH,
		);
		const verified = verifyApprovalGrant(ring, issued.token, expectation, NOW);
		expect(verified).toEqual({ ok: true, claims: issued.claims });
	});

	it('is deterministic for the same claims under the same key', () => {
		expect(issueApprovalGrant(ring, claims()).token).toBe(
			issueApprovalGrant(ring, claims()).token,
		);
	});

	it('refuses a token signed under a key the ring does not hold', () => {
		const foreign = createApprovalGrantKeyring({ current: KEY_B });
		const { token } = issueApprovalGrant(foreign, claims());
		expect(verifyApprovalGrant(ring, token, expectation, NOW)).toMatchObject({
			ok: false,
			reason: 'APPROVAL_GRANT_INVALID',
		});
	});

	it('refuses a token whose payload was altered', () => {
		const { token } = issueApprovalGrant(ring, claims());
		const [prefix, keyId, , signature] = token.split('.');
		const forged = Buffer.from(
			JSON.stringify({ ...claims(), v: 1, tenantId: 'tenant-b' }),
		).toString('base64url');
		expect(
			verifyApprovalGrant(
				ring,
				`${prefix}.${keyId}.${forged}.${signature}`,
				expectation,
				NOW,
			),
		).toMatchObject({ ok: false, reason: 'APPROVAL_GRANT_INVALID' });
		expect(
			verifyApprovalGrant(ring, 'nonsense', expectation, NOW),
		).toMatchObject({ ok: false, reason: 'APPROVAL_GRANT_INVALID' });
		expect(
			verifyApprovalGrant(
				ring,
				`${token}${'x'.repeat(APPROVAL_GRANT_MAX_TOKEN_LENGTH)}`,
				expectation,
				NOW,
			),
		).toMatchObject({ ok: false, reason: 'APPROVAL_GRANT_INVALID' });
	});

	it('refuses a grant past its expiry', () => {
		const { token } = issueApprovalGrant(ring, claims());
		expect(
			verifyApprovalGrant(ring, token, expectation, NOW + 60_000),
		).toMatchObject({ ok: false, reason: 'APPROVAL_GRANT_EXPIRED' });
	});

	it('refuses a grant for another tenant, capability or input', () => {
		const { token } = issueApprovalGrant(ring, claims());
		for (const expected of [
			{ ...expectation, tenantId: 'tenant-b' },
			{ ...expectation, capabilityId: 'billing.delete' },
			{ ...expectation, inputDigest: approvalInputDigest({ other: true }) },
		]) {
			expect(verifyApprovalGrant(ring, token, expected, NOW)).toMatchObject({
				ok: false,
				reason: 'APPROVAL_GRANT_MISMATCH',
			});
		}
	});

	it('leaves the input digest unchecked when the verifier names none', () => {
		const { token } = issueApprovalGrant(ring, claims());
		expect(
			verifyApprovalGrant(
				ring,
				token,
				{ tenantId: 'tenant-a', capabilityId: 'billing.export' },
				NOW,
			).ok,
		).toBe(true);
	});

	it('still verifies a grant issued under the previous key after a rotation', () => {
		const before = createApprovalGrantKeyring({ current: KEY_A });
		const { token } = issueApprovalGrant(before, claims());
		const after = createApprovalGrantKeyring({
			current: KEY_B,
			previous: [KEY_A],
		});
		expect(after.keyId).toBe(keyFingerprint(KEY_B));
		expect(after.previousKeyIds).toEqual([keyFingerprint(KEY_A)]);
		expect(verifyApprovalGrant(after, token, expectation, NOW).ok).toBe(true);
		expect(issueApprovalGrant(after, claims()).token.split('.')[1]).toBe(
			keyFingerprint(KEY_B),
		);
	});

	it('refuses claims out of bounds at issue', () => {
		expect(() => issueApprovalGrant(ring, claims({ expiresAt: NOW }))).toThrow(
			/out of bounds/,
		);
		expect(() =>
			issueApprovalGrant(ring, claims({ tenantId: 'tenant a' })),
		).toThrow(/out of bounds/);
	});

	it('reads the key and its previous keys from the environment', () => {
		expect(approvalGrantKeyringFromEnvironment({})).toBeUndefined();
		const environment = {
			FD_APPROVAL_GRANT_KEY: KEY_B.toString('base64'),
			FD_APPROVAL_GRANT_KEY_PREVIOUS: `${KEY_A.toString('base64')},`,
		};
		const fromEnvironment = approvalGrantKeyringFromEnvironment(environment);
		expect(fromEnvironment?.keyId).toBe(keyFingerprint(KEY_B));
		expect(fromEnvironment?.previousKeyIds).toEqual([keyFingerprint(KEY_A)]);
		expect(() =>
			approvalGrantKeyringFromEnvironment({ FD_APPROVAL_GRANT_KEY: 'short' }),
		).toThrow(/FD_APPROVAL_GRANT_KEY/);
	});
});
