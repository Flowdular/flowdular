import { describe, expect, it } from 'vitest';
import { integer } from '../src/index.ts';

describe('integer', () => {
	it('reads the number the embedded build returns', () => {
		expect(integer(42, 'count')).toBe(42);
	});

	it('reads the int8 text the server driver returns', () => {
		expect(integer('1700000000000', 'timestamp')).toBe(1_700_000_000_000);
	});

	it('reads a bigint', () => {
		expect(integer(7n, 'sequence')).toBe(7);
	});

	it('refuses an integer past the safe range', () => {
		expect(() =>
			integer(String(Number.MAX_SAFE_INTEGER + 2), 'sequence'),
		).toThrow('The database returned an invalid sequence.');
		expect(() => integer(2n ** 60n, 'sequence')).toThrow(
			'The database returned an invalid sequence.',
		);
	});

	it('refuses a fraction, text that is not a number and a non-primitive', () => {
		expect(() => integer(1.5, 'count')).toThrow('invalid count');
		expect(() => integer('twelve', 'count')).toThrow('invalid count');
		expect(() => integer(null, 'count')).toThrow('invalid count');
		expect(() => integer(true, 'count')).toThrow('invalid count');
	});

	it('refuses a value below min and names the field', () => {
		expect(() => integer(-1, 'version', { min: 0 })).toThrow(
			'The database returned an invalid version.',
		);
		expect(integer(0, 'version', { min: 0 })).toBe(0);
		expect(integer(-1, 'delta')).toBe(-1);
	});
});
