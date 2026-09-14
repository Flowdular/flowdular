import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
	KEYRING_KEY_BYTES,
	KEYRING_MAX_PREVIOUS_KEYS,
	keyFingerprint,
	parsePreviousKeys,
	type KeyringOptions,
} from './keyring.ts';

export const APPROVAL_GRANT_KEY_VARIABLE = 'FD_APPROVAL_GRANT_KEY';
export const APPROVAL_GRANT_PREVIOUS_KEY_VARIABLE =
	'FD_APPROVAL_GRANT_KEY_PREVIOUS';
export const APPROVAL_GRANT_MAX_TOKEN_LENGTH = 2_048;
export const APPROVAL_GRANT_INPUT_DIGEST_LENGTH = 64;

const TOKEN_PREFIX = 'ag1';
const MAX_CLAIM_LENGTH = 128;

export type ApprovalGrantReason =
	| 'APPROVAL_GRANT_INVALID'
	| 'APPROVAL_GRANT_EXPIRED'
	| 'APPROVAL_GRANT_MISMATCH';

/**
 * What one approved request lets one caller do with one input. The harness
 * admits one tool call per grant within a run; the CLI runner has no platform
 * connection to record use on, so a grant passed to it is bounded by
 * `expiresAt` alone and the same token runs the same invocation again until
 * then. The window is the approving module's to keep short.
 */
export interface ApprovalGrantClaims {
	readonly v: 1;
	readonly tenantId: string;
	readonly capabilityId: string;
	/** `approvalInputDigest` of the invocation input the approval was asked for. */
	readonly inputDigest: string;
	readonly requestId: string;
	readonly issuedAt: number;
	readonly expiresAt: number;
	readonly nonce: string;
}

export type ApprovalGrantInput = Omit<ApprovalGrantClaims, 'v'>;

export interface IssuedApprovalGrant {
	readonly token: string;
	readonly claims: ApprovalGrantClaims;
	readonly keyId: string;
}

/** What a verifier holds the grant against; an absent digest is not checked. */
export interface ApprovalGrantExpectation {
	readonly tenantId: string;
	readonly capabilityId: string;
	readonly inputDigest?: string | undefined;
}

export type ApprovalGrantVerification =
	| { readonly ok: true; readonly claims: ApprovalGrantClaims }
	| {
			readonly ok: false;
			readonly reason: ApprovalGrantReason;
			readonly message: string;
	  };

/**
 * The HMAC key set behind approval grants: the current key signs, and every
 * key kept from before a rotation still verifies, looked up by the fingerprint
 * the token names.
 */
export interface ApprovalGrantKeyring {
	readonly keyId: string;
	readonly previousKeyIds: readonly string[];
	key(keyId: string): Buffer | undefined;
}

export function createApprovalGrantKeyring(
	options: KeyringOptions,
): ApprovalGrantKeyring {
	const previous = options.previous ?? [];
	if (previous.length > KEYRING_MAX_PREVIOUS_KEYS) {
		throw new Error(
			`An approval grant keyring accepts at most ${KEYRING_MAX_PREVIOUS_KEYS} previous keys; ${previous.length} were given.`,
		);
	}
	const keys = new Map<string, Buffer>();
	const order: string[] = [];
	for (const key of [options.current, ...previous]) {
		if (key.byteLength !== KEYRING_KEY_BYTES) {
			throw new Error(
				`An approval grant key must be exactly ${KEYRING_KEY_BYTES} bytes.`,
			);
		}
		const id = keyFingerprint(key);
		if (keys.has(id)) continue;
		keys.set(id, Buffer.from(key));
		order.push(id);
	}
	return {
		keyId: order[0]!,
		previousKeyIds: order.slice(1),
		key: (keyId) => keys.get(keyId),
	};
}

function decodeKey(value: string, variable: string): Buffer {
	const key = Buffer.from(value.trim(), 'base64');
	if (key.byteLength !== KEYRING_KEY_BYTES) {
		key.fill(0);
		throw new Error(
			`${variable} must be a base64-encoded ${KEYRING_KEY_BYTES}-byte key.`,
		);
	}
	return key;
}

/** Absent when no key is configured: nothing can then be issued or verified. */
export function approvalGrantKeyringFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): ApprovalGrantKeyring | undefined {
	const current = environment[APPROVAL_GRANT_KEY_VARIABLE];
	if (!current) return undefined;
	return createApprovalGrantKeyring({
		current: decodeKey(current, APPROVAL_GRANT_KEY_VARIABLE),
		previous: parsePreviousKeys(
			environment[APPROVAL_GRANT_PREVIOUS_KEY_VARIABLE],
			(entry) => decodeKey(entry, APPROVAL_GRANT_PREVIOUS_KEY_VARIABLE),
		),
	});
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value === undefined ? null : value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonical(entry)).join(',')}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, entry]) => entry !== undefined)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return `{${entries
		.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
		.join(',')}}`;
}

/**
 * The digest a grant binds to: the SHA-256 of the input serialised with
 * object keys sorted, so the requester and the verifier agree on it
 * whatever order either built the object in.
 */
export function approvalInputDigest(input: unknown): string {
	return createHash('sha256').update(canonical(input), 'utf8').digest('hex');
}

function claimString(
	value: unknown,
	maximum = MAX_CLAIM_LENGTH,
): string | undefined {
	return typeof value === 'string' &&
		value.length >= 1 &&
		value.length <= maximum &&
		!/[\s\u0000]/.test(value)
		? value
		: undefined;
}

function claimInteger(value: unknown): number | undefined {
	return Number.isSafeInteger(value) && (value as number) >= 0
		? (value as number)
		: undefined;
}

function readClaims(value: unknown): ApprovalGrantClaims | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const tenantId = claimString(raw.tenantId);
	const capabilityId = claimString(raw.capabilityId);
	const inputDigest = claimString(
		raw.inputDigest,
		APPROVAL_GRANT_INPUT_DIGEST_LENGTH,
	);
	const requestId = claimString(raw.requestId);
	const nonce = claimString(raw.nonce);
	const issuedAt = claimInteger(raw.issuedAt);
	const expiresAt = claimInteger(raw.expiresAt);
	if (
		raw.v !== 1 ||
		tenantId === undefined ||
		capabilityId === undefined ||
		inputDigest === undefined ||
		requestId === undefined ||
		nonce === undefined ||
		issuedAt === undefined ||
		expiresAt === undefined ||
		expiresAt <= issuedAt
	) {
		return undefined;
	}
	return {
		v: 1,
		tenantId,
		capabilityId,
		inputDigest,
		requestId,
		issuedAt,
		expiresAt,
		nonce,
	};
}

function signature(key: Buffer, signed: string): Buffer {
	return createHmac('sha256', key).update(signed, 'utf8').digest();
}

export function issueApprovalGrant(
	keyring: ApprovalGrantKeyring,
	input: ApprovalGrantInput,
): IssuedApprovalGrant {
	const claims = readClaims({ v: 1, ...input });
	if (!claims) {
		throw new Error('Approval grant claims are out of bounds.');
	}
	const payload = Buffer.from(canonical(claims), 'utf8').toString('base64url');
	const signed = `${TOKEN_PREFIX}.${keyring.keyId}.${payload}`;
	const token = `${signed}.${signature(keyring.key(keyring.keyId)!, signed).toString('base64url')}`;
	if (token.length > APPROVAL_GRANT_MAX_TOKEN_LENGTH) {
		throw new Error('Approval grant token exceeds the token bound.');
	}
	return { token, claims, keyId: keyring.keyId };
}

function invalid(message: string): ApprovalGrantVerification {
	return { ok: false, reason: 'APPROVAL_GRANT_INVALID', message };
}

/**
 * Signature first, then lifetime, then binding: a token that does not verify
 * says nothing about who it was for, and one that has run out is refused
 * before its claims are compared.
 */
export function verifyApprovalGrant(
	keyring: ApprovalGrantKeyring,
	token: string,
	expected: ApprovalGrantExpectation,
	now: number = Date.now(),
): ApprovalGrantVerification {
	if (
		typeof token !== 'string' ||
		token.length < 32 ||
		token.length > APPROVAL_GRANT_MAX_TOKEN_LENGTH
	) {
		return invalid('The approval grant is not a token this platform issued.');
	}
	const [prefix, keyId, payload, supplied, extra] = token.split('.');
	if (
		prefix !== TOKEN_PREFIX ||
		!keyId ||
		!payload ||
		!supplied ||
		extra !== undefined
	) {
		return invalid('The approval grant is not a token this platform issued.');
	}
	const key = keyring.key(keyId);
	if (!key) {
		return invalid(
			'The approval grant names a key this platform does not hold.',
		);
	}
	const expectedSignature = signature(key, `${prefix}.${keyId}.${payload}`);
	const suppliedSignature = Buffer.from(supplied, 'base64url');
	if (
		suppliedSignature.byteLength !== expectedSignature.byteLength ||
		!timingSafeEqual(suppliedSignature, expectedSignature)
	) {
		return invalid('The approval grant signature does not verify.');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
	} catch {
		return invalid('The approval grant payload is unreadable.');
	}
	const claims = readClaims(parsed);
	if (!claims) return invalid('The approval grant payload is out of bounds.');
	if (claims.expiresAt <= now) {
		return {
			ok: false,
			reason: 'APPROVAL_GRANT_EXPIRED',
			message: 'The approval grant has expired.',
		};
	}
	if (
		claims.tenantId !== expected.tenantId ||
		claims.capabilityId !== expected.capabilityId ||
		(expected.inputDigest !== undefined &&
			claims.inputDigest !== expected.inputDigest)
	) {
		return {
			ok: false,
			reason: 'APPROVAL_GRANT_MISMATCH',
			message:
				'The approval grant was issued for another workspace, capability or input.',
		};
	}
	return { ok: true, claims };
}
