import { describe, expect, it } from 'vitest';
import { ScimRateLimiter } from '../src/services/rate-limiter.ts';

/** limit, windowMs, capacity, refusalLimit. */
function limiter(capacity = 8, limit = 2): ScimRateLimiter {
	return new ScimRateLimiter(limit, 60_000, capacity, 3);
}

describe('SCIM rate limiter', () => {
	it('spends one window per key inside the window and opens a new one after it', () => {
		const windows = limiter();
		expect(windows.allow('token:a', 0)).toBe(true);
		expect(windows.allow('token:a', 10)).toBe(true);
		expect(windows.allow('token:a', 20)).toBe(false);
		expect(windows.allow('token:a', 60_001)).toBe(true);
	});

	/* A window in use has to survive a flood of keys that are used once. The
	   pressure is applied between two requests of the same key, which is what
	   an invented-credential flood looks like from the map's side. */
	it('keeps the window of a key in use while other keys flood the map', () => {
		const windows = limiter(64);
		expect(windows.allow('token:real', 0)).toBe(true);
		for (let index = 0; index < 1_024; index += 1) {
			windows.allow('token:junk-' + index, 1);
			/* The real caller keeps working through the flood, so its window is
			   the most recently used one whenever an eviction runs. */
			expect(windows.allow('token:real', 1)).toBe(index === 0);
		}
	});

	/* The key opened first is not the window to drop first: it may be the one
	   that just started a new window, while the keys behind it hold windows
	   nobody can spend any more. */
	it('drops expired windows before windows that are still open', () => {
		const windows = limiter(80, 1);
		windows.allow('caller', 0);
		for (let index = 0; index < 70; index += 1) {
			windows.allow('stale-' + index, 0);
		}
		/* A minute later every window above is spent, and the caller opens a new
		   one of its own. */
		expect(windows.allow('caller', 61_000)).toBe(true);
		for (let index = 0; index < 16; index += 1) {
			windows.allow('opening-' + index, 61_000);
		}

		/* The expired windows were the eviction's whole batch, so the caller
		   still carries the request it just made and the expired keys start over. */
		expect(windows.allow('caller', 61_000)).toBe(false);
		expect(windows.allow('stale-0', 61_000)).toBe(true);
	});

	it('budgets the refusals of one caller and never spends one on a question', () => {
		const windows = limiter();
		for (let index = 0; index < 3; index += 1) {
			expect(windows.withinRefusalBudget('caller:a', 0)).toBe(true);
			windows.recordRefusal('caller:a', 0);
		}
		expect(windows.withinRefusalBudget('caller:a', 0)).toBe(false);
		/* Another caller is untouched, and the window is not a life sentence. */
		expect(windows.withinRefusalBudget('caller:b', 0)).toBe(true);
		expect(windows.withinRefusalBudget('caller:a', 60_001)).toBe(true);
	});
});
