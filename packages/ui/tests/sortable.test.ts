import { describe, expect, it } from 'vitest';
import {
	clampIndex,
	droppedIndex,
	insertionIndex,
	moveItem,
	sameOrder,
} from '../src/components/sortable.ts';

describe('sortable helpers', () => {
	it('moves one entry and clamps the target into the list', () => {
		const list = ['a', 'b', 'c', 'd'];
		expect(moveItem(list, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
		expect(moveItem(list, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
		expect(moveItem(list, 1, 9)).toEqual(['a', 'c', 'd', 'b']);
		expect(moveItem(list, 2, -1)).toEqual(['c', 'a', 'b', 'd']);
		expect(moveItem(list, 7, 0)).toEqual(list);
		expect(list).toEqual(['a', 'b', 'c', 'd']);
	});

	it('clamps an index to the list bounds', () => {
		expect(clampIndex(-1, 3)).toBe(0);
		expect(clampIndex(1, 3)).toBe(1);
		expect(clampIndex(5, 3)).toBe(2);
		expect(clampIndex(2, 0)).toBe(0);
	});

	it('reads the insertion index from the item midpoints', () => {
		const midpoints = [10, 30, 50];
		expect(insertionIndex(midpoints, 0)).toBe(0);
		expect(insertionIndex(midpoints, 10)).toBe(0);
		expect(insertionIndex(midpoints, 11)).toBe(1);
		expect(insertionIndex(midpoints, 45)).toBe(2);
		expect(insertionIndex(midpoints, 90)).toBe(3);
		expect(insertionIndex([], 90)).toBe(0);
	});

	it('turns an insertion index into the index the dragged item ends at', () => {
		expect(droppedIndex(0, 3)).toBe(2);
		expect(droppedIndex(0, 1)).toBe(0);
		expect(droppedIndex(2, 0)).toBe(0);
		expect(droppedIndex(1, 4)).toBe(3);
	});

	it('compares two orders', () => {
		expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true);
		expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false);
		expect(sameOrder(['a'], ['a', 'b'])).toBe(false);
	});
});
