import { ADAPTER_LIMITS } from '../domain/types.ts';
import type { ConnectorCallAnswer } from './capabilities.ts';

/*
 * The retry policy of research.core's adapter chain
 * (modules/research/src/services/adapter-chain.ts and
 * modules/research/src/adapters/connector-failure.ts), copied rather than
 * shared: moving it would need a platform package of its own.
 */

export interface PageFailure {
	readonly retryable: boolean;
	readonly code: string;
	readonly retryAfterMs: number | null;
}

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const RETRYABLE_CLASSES = new Set([
	'timeout',
	'dns',
	'network',
	'response-5xx',
]);

/** One connector answer that did not succeed, as a page failure. */
export function callFailure(answer: ConnectorCallAnswer): PageFailure {
	const retryAfterMs = answer.retryAfterMs ?? null;
	if (answer.outcome === 'refused') {
		return {
			retryable: false,
			code:
				answer.errorClass === 'consent-missing'
					? 'ADAPTER_CONSENT_MISSING'
					: 'ADAPTER_CALL_REFUSED',
			retryAfterMs: null,
		};
	}
	if (answer.errorClass === 'timeout') {
		return { retryable: true, code: 'ADAPTER_CALL_TIMEOUT', retryAfterMs };
	}
	if (answer.status === 429) {
		return { retryable: true, code: 'ADAPTER_CALL_RATE_LIMITED', retryAfterMs };
	}
	if (answer.status === 401 || answer.status === 403) {
		return {
			retryable: false,
			code: 'ADAPTER_CALL_UNAUTHORIZED',
			retryAfterMs: null,
		};
	}
	return {
		retryable:
			RETRYABLE_CLASSES.has(answer.errorClass ?? '') || answer.status === 408,
		code: 'ADAPTER_CALL_FAILED',
		retryAfterMs,
	};
}

/** A call that threw instead of answering. */
export function thrownFailure(error: unknown): PageFailure {
	const code = (error as { code?: unknown } | null)?.code;
	if (code === 'CALL_IN_FLIGHT') {
		return { retryable: true, code, retryAfterMs: null };
	}
	if (typeof code === 'string' && CODE.test(code)) {
		return { retryable: false, code, retryAfterMs: null };
	}
	return { retryable: true, code: 'ADAPTER_CALL_FAILED', retryAfterMs: null };
}

/**
 * Full jitter: a random share of the doubled base, capped. A service's
 * Retry-After replaces the jitter and is capped the same way.
 */
export function retryDelay(
	retry: number,
	retryAfterMs: number | null,
	random: () => number,
): number {
	const cap = ADAPTER_LIMITS.retryCapMs;
	if (retryAfterMs !== null) return Math.min(cap, Math.max(0, retryAfterMs));
	const ceiling = Math.min(cap, ADAPTER_LIMITS.retryBaseMs * 2 ** (retry - 1));
	return Math.floor(random() * ceiling);
}
