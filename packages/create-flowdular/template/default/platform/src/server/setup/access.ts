import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/* The first-run screen runs before any account exists, so there is nothing to
   authenticate against. Access is bound to a token minted at boot, printed to
   stdout and written to the state directory, the way Grafana and Jupyter hand
   an operator their first credential. */

export const SETUP_TOKEN_BYTES = 32;
export const SETUP_SESSION_COOKIE = 'coreloom_setup';
export const SETUP_CSRF_FIELD = 'setupCsrf';

const MAX_TOKEN_FAILURES = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;

export type SetupAccessVerdict = 'granted' | 'denied' | 'locked';

export interface SetupSession {
	readonly id: string;
	readonly csrfToken: string;
	expiresAt: number;
	/* The configuration under review, held only in this process. Secrets never
	   reach a cookie, a log, or the disk before the operator confirms. */
	pending: unknown;
}

export interface SetupAccess {
	/** Constant-time token check with a shared lockout after repeated failures. */
	open(presented: string | null): {
		readonly verdict: SetupAccessVerdict;
		readonly session: SetupSession | null;
		readonly retryAfterMs: number;
	};
	/** The live session for a cookie value, or null once it expired or rotated. */
	resume(sessionId: string | null): SetupSession | null;
	/** True only for the CSRF token minted with this session. */
	verifyCsrf(session: SetupSession, presented: string | null): boolean;
	close(): void;
}

/* timingSafeEqual needs equal lengths, and the length of the presented value is
   attacker chosen. Comparing digests keeps the comparison constant time without
   leaking how long the real token is. */
function constantTimeEquals(left: string, right: string): boolean {
	return timingSafeEqual(
		createHash('sha256').update(left, 'utf8').digest(),
		createHash('sha256').update(right, 'utf8').digest(),
	);
}

export function generateSetupToken(): string {
	return randomBytes(SETUP_TOKEN_BYTES).toString('base64url');
}

export function createSetupAccess(
	expectedToken: string,
	now: () => number = Date.now,
): SetupAccess {
	let failures = 0;
	let lockedUntil = 0;
	/* One operator installs one deployment. Holding a single session makes the
	   state O(1) and means a second successful token presentation supersedes the
	   first rather than accumulating sessions. */
	let session: SetupSession | null = null;

	const expire = (): void => {
		if (session && session.expiresAt <= now()) session = null;
	};

	return {
		open(presented) {
			const at = now();
			if (at < lockedUntil) {
				return {
					verdict: 'locked',
					session: null,
					retryAfterMs: lockedUntil - at,
				};
			}
			if (
				presented === null ||
				presented.length === 0 ||
				!constantTimeEquals(presented, expectedToken)
			) {
				failures += 1;
				if (failures >= MAX_TOKEN_FAILURES) {
					failures = 0;
					lockedUntil = at + LOCKOUT_MS;
					return { verdict: 'locked', session: null, retryAfterMs: LOCKOUT_MS };
				}
				return { verdict: 'denied', session: null, retryAfterMs: 0 };
			}
			failures = 0;
			session = {
				id: randomBytes(32).toString('base64url'),
				csrfToken: randomBytes(32).toString('base64url'),
				expiresAt: at + SESSION_TTL_MS,
				pending: null,
			};
			return { verdict: 'granted', session, retryAfterMs: 0 };
		},
		resume(sessionId) {
			expire();
			if (!session || sessionId === null || sessionId.length === 0) return null;
			if (!constantTimeEquals(sessionId, session.id)) return null;
			session.expiresAt = now() + SESSION_TTL_MS;
			return session;
		},
		verifyCsrf(current, presented) {
			return (
				presented !== null &&
				presented.length > 0 &&
				constantTimeEquals(presented, current.csrfToken)
			);
		},
		close() {
			session = null;
		},
	};
}

export function setupSessionCookie(sessionId: string, secure: boolean): string {
	return [
		`${SETUP_SESSION_COOKIE}=${sessionId}`,
		'Path=/',
		'HttpOnly',
		'SameSite=Strict',
		`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
		...(secure ? ['Secure'] : []),
	].join('; ');
}

export function readSetupSessionCookie(header: string | null): string | null {
	if (!header) return null;
	for (const part of header.split(';')) {
		const separator = part.indexOf('=');
		if (separator < 0) continue;
		if (part.slice(0, separator).trim() !== SETUP_SESSION_COOKIE) continue;
		return part.slice(separator + 1).trim() || null;
	}
	return null;
}
