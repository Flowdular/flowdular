/* First-run failures reach the operator screen, the terminal scrollback, and
   whatever support channel the operator pastes them into. Nothing derived from
   a driver message is ever returned: the classification below writes the whole
   sentence, and the secret pass is a second barrier for values that reached a
   string some other way. */

export type SetupFailureCode =
	| 'AUTHENTICATION_REJECTED'
	| 'DATABASE_MISSING'
	| 'HOST_UNREACHABLE'
	| 'PERMISSION_DENIED'
	| 'PROBE_FAILED'
	| 'ROLE_TOO_PRIVILEGED'
	| 'TIMED_OUT'
	| 'TLS_REJECTED';

export interface SetupFailure {
	readonly code: SetupFailureCode;
	readonly message: string;
}

const MESSAGES: Readonly<Record<SetupFailureCode, string>> = Object.freeze({
	AUTHENTICATION_REJECTED:
		'The server rejected the credentials for one of the roles. Check the user names and passwords you entered.',
	DATABASE_MISSING:
		'The server answered but does not have a database with that name. Create it, then try again.',
	HOST_UNREACHABLE:
		'Nothing answered at that host and port. Check the address, the port, and whether the server accepts connections from this machine.',
	PERMISSION_DENIED:
		'The server accepted the connection and then refused the operation. Grant the role the rights the deployment needs.',
	PROBE_FAILED:
		'The connection attempt failed. Check the values you entered and the server log for the matching entry.',
	ROLE_TOO_PRIVILEGED:
		'The runtime role holds SUPERUSER or BYPASSRLS. Tenant isolation depends on that role being unable to bypass row-level security, so this connection is refused.',
	TIMED_OUT:
		'The server did not answer within the connection timeout. Check the network path and whether the server is accepting connections.',
	TLS_REJECTED:
		'The TLS certificate was not accepted. Supply the certificate authority, or pick a TLS mode that matches how the server is configured.',
});

/* Mirrors redactSecrets in packages/ai-provider/src/errors.ts: every value the
   operator typed as a secret is replaced wherever it appears. Short values are
   skipped because a two-character password would redact ordinary prose. */
export function redactSetupSecrets(
	value: string,
	secrets: Iterable<string>,
): string {
	let redacted = value;
	for (const secret of secrets) {
		if (secret.length < 4) continue;
		redacted = redacted.split(secret).join('[redacted]');
	}
	return redacted;
}

function errorCode(error: unknown): string {
	return typeof error === 'object' && error !== null && 'code' in error
		? String((error as { code: unknown }).code)
		: '';
}

const SQLSTATE: Readonly<Record<string, SetupFailureCode>> = Object.freeze({
	'28000': 'AUTHENTICATION_REJECTED',
	'28P01': 'AUTHENTICATION_REJECTED',
	'3D000': 'DATABASE_MISSING',
	'42501': 'PERMISSION_DENIED',
	'53300': 'HOST_UNREACHABLE',
	'57P03': 'HOST_UNREACHABLE',
});

const ERRNO: Readonly<Record<string, SetupFailureCode>> = Object.freeze({
	EAI_AGAIN: 'HOST_UNREACHABLE',
	ECONNREFUSED: 'HOST_UNREACHABLE',
	ECONNRESET: 'HOST_UNREACHABLE',
	EHOSTUNREACH: 'HOST_UNREACHABLE',
	ENETUNREACH: 'HOST_UNREACHABLE',
	ENOTFOUND: 'HOST_UNREACHABLE',
	ETIMEDOUT: 'TIMED_OUT',
	CERT_HAS_EXPIRED: 'TLS_REJECTED',
	DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS_REJECTED',
	ERR_TLS_CERT_ALTNAME_INVALID: 'TLS_REJECTED',
	SELF_SIGNED_CERT_IN_CHAIN: 'TLS_REJECTED',
	UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS_REJECTED',
});

export class SetupProbeError extends Error {
	constructor(readonly failureCode: SetupFailureCode) {
		super(MESSAGES[failureCode]);
		this.name = 'SetupProbeError';
	}
}

/**
 * Turns any failure into one of a fixed set of operator-actionable sentences.
 * The driver message is read to classify and then discarded, so a DSN, a host,
 * or a password inside it cannot reach the caller.
 */
export function classifySetupFailure(
	error: unknown,
	secrets: Iterable<string> = [],
): SetupFailure {
	const code =
		error instanceof SetupProbeError
			? error.failureCode
			: (SQLSTATE[errorCode(error)] ??
				ERRNO[errorCode(error)] ??
				(error instanceof Error && error.name === 'AbortError'
					? 'TIMED_OUT'
					: 'PROBE_FAILED'));
	return { code, message: redactSetupSecrets(MESSAGES[code], secrets) };
}
