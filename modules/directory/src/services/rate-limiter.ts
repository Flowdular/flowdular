/** How many of the oldest windows one eviction drops. */
const EVICTION_BATCH = 64;

interface Window {
	count: number;
	startedAt: number;
}

/**
 * Fixed windows over two dimensions of one SCIM surface.
 *
 * `allow` budgets the credential itself, keyed by the fingerprint the caller's
 * own token derives to, so the map never holds a secret. That window alone
 * gives every invented credential a budget of its own, so `recordRefusal`
 * budgets the caller behind them, keyed by the workspace and the remote
 * address: a flood of invented tokens spends one window instead of one each.
 * The caller window is charged and read only where a credential did not
 * resolve, so a provider presenting a real token is never held back by someone
 * else's flood, whatever the two have in common.
 *
 * Bounded: the map evicts once it reaches capacity, dropping expired windows
 * first and the least recently used ones after them, so a flood of invented
 * credentials cannot grow it without limit or push out a window in use. The
 * limits are per process, so a deployment running several instances gives one
 * token that budget on each of them.
 */
export class ScimRateLimiter {
	readonly #windows = new Map<string, Window>();

	constructor(
		private readonly limit = 600,
		private readonly windowMs = 60_000,
		private readonly capacity = 1_000,
		/** Credentials one caller may present unresolved before it is cut off. */
		private readonly refusalLimit = 60,
	) {}

	allow(key: string, now: number): boolean {
		const current = this.#live(key, now);
		if (!current) {
			this.#start(key, now);
			return true;
		}
		current.count += 1;
		return current.count <= this.limit;
	}

	/** Whether the caller has refusals left; asking never spends one. */
	withinRefusalBudget(key: string, now: number): boolean {
		return (this.#live(key, now)?.count ?? 0) < this.refusalLimit;
	}

	recordRefusal(key: string, now: number): void {
		const current = this.#live(key, now);
		if (current) current.count += 1;
		else this.#start(key, now);
	}

	/**
	 * The window of `key` while it is still open, or null. Insertion order is
	 * the recency order eviction reads, so a live window is re-inserted on every
	 * touch and an expired one is dropped where it is found.
	 */
	#live(key: string, now: number): Window | null {
		const current = this.#windows.get(key);
		if (!current) return null;
		this.#windows.delete(key);
		if (now - current.startedAt >= this.windowMs) return null;
		this.#windows.set(key, current);
		return current;
	}

	#start(key: string, now: number): void {
		if (this.#windows.size >= this.capacity) this.#evict(now);
		this.#windows.set(key, { count: 1, startedAt: now });
	}

	/* One pass at most, and only once per batch of new windows after the map is
	   full, so the amortized cost of an insertion stays a small constant.
	   Expired windows fill the batch first because they hold no budget anyone
	   can spend; the least recently used open windows fill whatever is left. */
	#evict(now: number): void {
		let dropped = 0;
		const idle: string[] = [];
		for (const [key, window] of this.#windows) {
			if (now - window.startedAt >= this.windowMs) {
				this.#windows.delete(key);
				dropped += 1;
				if (dropped >= EVICTION_BATCH) return;
			} else if (idle.length < EVICTION_BATCH) {
				idle.push(key);
			}
		}
		/* `idle` is in least-recently-used order and the map never empties, so
		   the window of whoever is using the surface right now is the last one
		   an eviction would ever reach. */
		for (const key of idle) {
			if (dropped >= EVICTION_BATCH || this.#windows.size <= 1) return;
			this.#windows.delete(key);
			dropped += 1;
		}
	}
}
