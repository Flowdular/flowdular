// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
	compareVersions,
	isValidRange,
	nextVersion,
	parseVersion,
	rangeSatisfies,
} from '../src/version-range.ts';

describe('version parsing', () => {
	it('accepts a stable release and refuses anything else', () => {
		expect(parseVersion('0.8.2')).toEqual([0, 8, 2]);
		expect(parseVersion(' 1.0.0 ')).toEqual([1, 0, 0]);
		for (const value of [
			'1.0',
			'1.0.0.0',
			'v1.0.0',
			'01.0.0',
			'1.0.0-rc.1',
			'',
		])
			expect(parseVersion(value), value).toBeNull();
	});

	it('orders by major, then minor, then patch', () => {
		expect(compareVersions([0, 9, 0], [0, 10, 0])).toBeLessThan(0);
		expect(compareVersions([1, 0, 0], [0, 99, 99])).toBeGreaterThan(0);
		expect(compareVersions([2, 3, 4], [2, 3, 4])).toBe(0);
	});

	it('bumps one part and zeroes the parts under it', () => {
		expect(nextVersion('0.8.2', 'patch')).toBe('0.8.3');
		expect(nextVersion('0.8.2', 'minor')).toBe('0.9.0');
		expect(nextVersion('0.8.2', 'major')).toBe('1.0.0');
		expect(nextVersion('nope', 'patch')).toBeNull();
	});
});

describe('ranges', () => {
	it('keeps the leftmost non-zero part for a caret', () => {
		expect(rangeSatisfies('0.8.0', '^0.8.0')).toBe(true);
		expect(rangeSatisfies('0.8.7', '^0.8.0')).toBe(true);
		expect(rangeSatisfies('0.9.0', '^0.8.0')).toBe(false);
		expect(rangeSatisfies('0.7.9', '^0.8.0')).toBe(false);
		expect(rangeSatisfies('1.4.0', '^1.2.3')).toBe(true);
		expect(rangeSatisfies('2.0.0', '^1.2.3')).toBe(false);
		expect(rangeSatisfies('0.0.4', '^0.0.3')).toBe(false);
	});

	it('stops a tilde at the next minor', () => {
		expect(rangeSatisfies('1.2.9', '~1.2.3')).toBe(true);
		expect(rangeSatisfies('1.3.0', '~1.2.3')).toBe(false);
	});

	it('reads an exact pin, a comparator, a conjunction and alternatives', () => {
		expect(rangeSatisfies('0.5.0', '0.5.0')).toBe(true);
		expect(rangeSatisfies('0.5.1', '0.5.0')).toBe(false);
		expect(rangeSatisfies('1.2.0', '>=1.0.0')).toBe(true);
		expect(rangeSatisfies('1.2.0', '>=1.0.0 <1.2.0')).toBe(false);
		expect(rangeSatisfies('1.1.0', '>=1.0.0 <1.2.0')).toBe(true);
		expect(rangeSatisfies('2.0.0', '^1.0.0 || ^2.0.0')).toBe(true);
		expect(rangeSatisfies('0.8.2', '*')).toBe(true);
	});

	it('refuses a range it cannot read, and a version that is not a release', () => {
		expect(isValidRange('^0.8.0')).toBe(true);
		expect(isValidRange('>=1.0.0 <2.0.0')).toBe(true);
		expect(isValidRange('latest')).toBe(false);
		expect(isValidRange('^0.8')).toBe(false);
		expect(rangeSatisfies('1.0.0-rc.1', '^1.0.0')).toBe(false);
		expect(rangeSatisfies('1.0.0', 'latest')).toBe(false);
	});
});
