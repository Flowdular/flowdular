/* Fixed-window counter per key, bounded by evicting the least recently touched
   key once the table is full. A flood of new keys can therefore only shorten
   other attackers' windows, never lock legitimate first-time callers out. */
export class AttemptLimiter {
	readonly #attempts = new Map<string, { count: number; resetAt: number }>();
	readonly #limit: number;
	readonly #windowMs: number;
	readonly #maxEntries: number;

	constructor(limit = 5, windowMs = 5 * 60 * 1000, maxEntries = 10_000) {
		this.#limit = limit;
		this.#windowMs = windowMs;
		this.#maxEntries = maxEntries;
	}

	consume(key: string, now = Date.now()): boolean {
		const current = this.#attempts.get(key);
		if (current && current.resetAt > now) {
			if (current.count >= this.#limit) return false;
			current.count += 1;
			this.#attempts.delete(key);
			this.#attempts.set(key, current);
			return true;
		}
		if (current) {
			this.#attempts.delete(key);
		} else if (this.#attempts.size >= this.#maxEntries) {
			const oldest = this.#attempts.keys().next().value;
			if (oldest !== undefined) this.#attempts.delete(oldest);
		}
		this.#attempts.set(key, { count: 1, resetAt: now + this.#windowMs });
		return true;
	}

	clear(key: string): void {
		this.#attempts.delete(key);
	}

	get size(): number {
		return this.#attempts.size;
	}
}
