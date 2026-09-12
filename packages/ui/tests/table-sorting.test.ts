import { describe, expect, it } from 'vitest';
import {
	compareCellValues,
	sortingSignature,
} from '../src/components/table-sorting.ts';

describe('table cell ordering', () => {
	it('orders numbers by magnitude, not as text', () => {
		expect(compareCellValues(9, 10)).toBeLessThan(0);
		expect(compareCellValues(10, 9)).toBeGreaterThan(0);
		expect(compareCellValues(7, 7)).toBe(0);
	});

	it('collates text the way the reader reads it', () => {
		expect(compareCellValues('alice', 'Bob')).toBeLessThan(0);
		expect(compareCellValues('Łucja', 'Zofia')).toBeLessThan(0);
		expect(compareCellValues('item 9', 'item 10')).toBeLessThan(0);
	});

	it('sends blank values to the end of an ascending column', () => {
		expect(compareCellValues('', 'a')).toBeGreaterThan(0);
		expect(compareCellValues(null, 'a')).toBeGreaterThan(0);
		expect(compareCellValues('a', null)).toBeLessThan(0);
		expect(compareCellValues(null, '')).toBe(0);
	});

	it('orders booleans false before true', () => {
		expect(compareCellValues(false, true)).toBeLessThan(0);
		expect(compareCellValues(true, true)).toBe(0);
	});

	it('gives one signature per sorting state', () => {
		expect(sortingSignature([{ key: 'name', desc: false }])).toBe(
			sortingSignature([{ key: 'name', desc: false }]),
		);
		expect(sortingSignature([{ key: 'name', desc: true }])).not.toBe(
			sortingSignature([{ key: 'name', desc: false }]),
		);
		expect(
			sortingSignature([
				{ key: 'name', desc: false },
				{ key: 'email', desc: false },
			]),
		).not.toBe(
			sortingSignature([
				{ key: 'email', desc: false },
				{ key: 'name', desc: false },
			]),
		);
		expect(sortingSignature([])).toBe('');
	});
});
