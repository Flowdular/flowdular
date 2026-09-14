import { APPROVAL_GRANT_INPUT_DIGEST_LENGTH } from '@flowdular/kernel';
import { APPROVAL_LIMITS } from './capability.ts';

/**
 * How long after the approving decision the grant an approved request yields
 * still verifies. The token is derived from the row and the key on every read,
 * so the window is measured from `resolvedAt`, not from the read.
 */
export const APPROVAL_GRANT_TTL_MS = 60 * 60 * 1_000;

const SUBJECT_PREFIX = 'capability:';
const CAPABILITY_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const INPUT_DIGEST = new RegExp(
	`^[a-f0-9]{${APPROVAL_GRANT_INPUT_DIGEST_LENGTH}}$`,
);
/* Prefix, id, one separator and the digest have to fit the subjectRef bound. */
export const APPROVAL_GRANT_CAPABILITY_ID_LENGTH =
	APPROVAL_LIMITS.subjectRef -
	SUBJECT_PREFIX.length -
	1 -
	APPROVAL_GRANT_INPUT_DIGEST_LENGTH;

/** The capability and the exact input an approval is asked for. */
export interface CapabilitySubject {
	readonly capabilityId: string;
	/** `approvalInputDigest` of the invocation input, as the runner computes it. */
	readonly inputDigest: string;
}

/**
 * A `subjectRef` of the form `capability:<capabilityId>:<inputDigest>`. A
 * request opened with it yields, once approved, a signed grant for exactly
 * that capability and that input.
 */
export function encodeCapabilitySubjectRef(subject: CapabilitySubject): string {
	if (
		!CAPABILITY_ID.test(subject.capabilityId) ||
		subject.capabilityId.length > APPROVAL_GRANT_CAPABILITY_ID_LENGTH
	) {
		throw new RangeError(
			`capabilityId must be a lowercase dot-separated identifier of at most ${APPROVAL_GRANT_CAPABILITY_ID_LENGTH} characters.`,
		);
	}
	if (!INPUT_DIGEST.test(subject.inputDigest)) {
		throw new RangeError(
			`inputDigest must be ${APPROVAL_GRANT_INPUT_DIGEST_LENGTH} lowercase hex characters.`,
		);
	}
	return `${SUBJECT_PREFIX}${subject.capabilityId}:${subject.inputDigest}`;
}

/** Null for a subject reference that names a record rather than a capability. */
export function decodeCapabilitySubjectRef(
	subjectRef: string,
): CapabilitySubject | null {
	if (!subjectRef.startsWith(SUBJECT_PREFIX)) return null;
	const separator = subjectRef.lastIndexOf(':');
	const capabilityId = subjectRef.slice(SUBJECT_PREFIX.length, separator);
	const inputDigest = subjectRef.slice(separator + 1);
	if (
		separator <= SUBJECT_PREFIX.length ||
		!CAPABILITY_ID.test(capabilityId) ||
		capabilityId.length > APPROVAL_GRANT_CAPABILITY_ID_LENGTH ||
		!INPUT_DIGEST.test(inputDigest)
	) {
		return null;
	}
	return { capabilityId, inputDigest };
}
