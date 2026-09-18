/* One fixed window per credential, in this process. A deployment behind
   several processes therefore admits up to the limit in each of them; the
   ceiling is a guard against one integration running away, not an accounting
   record, and the counters on /api/metrics are what an operator watches. */
export const API_TOKEN_RATE_WINDOW_MS = 60_000;
/* Windows are dropped once the map is full, so a flood of distinct tokens
   cannot grow it without bound. */
const CAPACITY = 4_096;

export interface RateLimitDecision {
	readonly allowed: boolean;
	/** Requests admitted per minute; 0 when this credential has no limit. */
	readonly limit: number;
	readonly remaining: number;
	/** Whole seconds until the window resets, at least 1. */
	readonly resetSeconds: number;
}

export interface ApiTokenRateLimiter {
	/** Counts one request against `key` and answers whether it is admitted. */
	consume(key: string, limit: number, now: number): RateLimitDecision;
}

const UNLIMITED: RateLimitDecision = Object.freeze({
	allowed: true,
	limit: 0,
	remaining: 0,
	resetSeconds: 0,
});

export function createApiTokenRateLimiter(
	windowMs: number = API_TOKEN_RATE_WINDOW_MS,
): ApiTokenRateLimiter {
	const windows = new Map<string, { count: number; startedAt: number }>();
	const evict = (now: number) => {
		for (const [key, window] of windows) {
			if (now - window.startedAt >= windowMs) windows.delete(key);
		}
		while (windows.size >= CAPACITY) {
			const oldest = windows.keys().next();
			if (oldest.done) return;
			windows.delete(oldest.value);
		}
	};
	return {
		consume(key, limit, now) {
			if (!Number.isFinite(limit) || limit <= 0) return UNLIMITED;
			let window = windows.get(key);
			if (!window || now - window.startedAt >= windowMs) {
				if (!window && windows.size >= CAPACITY) evict(now);
				window = { count: 0, startedAt: now };
				windows.set(key, window);
			}
			window.count += 1;
			const resetSeconds = Math.max(
				1,
				Math.ceil((window.startedAt + windowMs - now) / 1000),
			);
			return {
				allowed: window.count <= limit,
				limit,
				remaining: Math.max(0, limit - window.count),
				resetSeconds,
			};
		},
	};
}
