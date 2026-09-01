import { describe, expect, it } from 'vitest';
import { AttemptLimiter } from '../src/api/attempt-limiter.ts';

describe('AttemptLimiter', () => {
	it('limits a key inside its window and releases it afterwards', () => {
		const limiter = new AttemptLimiter(2, 100, 10);
		expect(limiter.consume('one', 0)).toBe(true);
		expect(limiter.consume('one', 1)).toBe(true);
		expect(limiter.consume('one', 2)).toBe(false);
		expect(limiter.consume('one', 101)).toBe(true);
	});

	it('evicts the least recently touched key instead of rejecting new ones', () => {
		const limiter = new AttemptLimiter(2, 100, 2);
		expect(limiter.consume('one', 0)).toBe(true);
		expect(limiter.consume('two', 0)).toBe(true);
		expect(limiter.consume('one', 1)).toBe(true);
		expect(limiter.consume('three', 2)).toBe(true);
		expect(limiter.size).toBe(2);
		// "one" kept its count; "two" was evicted, so its window starts over.
		expect(limiter.consume('one', 3)).toBe(false);
		expect(limiter.consume('two', 4)).toBe(true);
		expect(limiter.size).toBe(2);
	});
});
