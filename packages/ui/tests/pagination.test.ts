import { describe, expect, it } from 'vitest';
import { pageRange } from '../src/components/pagination.ts';

describe('page arithmetic', () => {
	it('describes the rows on the requested page', () => {
		expect(pageRange(120, 25, 1)).toEqual({
			pageIndex: 1,
			pageCount: 5,
			from: 26,
			to: 50,
			totalRows: 120,
		});
	});

	it('stops the last page at the last row', () => {
		expect(pageRange(103, 25, 4)).toEqual({
			pageIndex: 4,
			pageCount: 5,
			from: 101,
			to: 103,
			totalRows: 103,
		});
	});

	it('keeps one page for an empty set and numbers nothing', () => {
		expect(pageRange(0, 25, 0)).toEqual({
			pageIndex: 0,
			pageCount: 1,
			from: 0,
			to: 0,
			totalRows: 0,
		});
	});

	it('clamps a page index the row set no longer reaches', () => {
		expect(pageRange(30, 25, 7).pageIndex).toBe(1);
		expect(pageRange(30, 25, 7).from).toBe(26);
		expect(pageRange(0, 25, 3).pageIndex).toBe(0);
	});

	it('survives values a caller should never pass', () => {
		expect(pageRange(-5, 0, -3)).toEqual({
			pageIndex: 0,
			pageCount: 1,
			from: 0,
			to: 0,
			totalRows: 0,
		});
		expect(pageRange(10, Number.NaN, 0).pageCount).toBe(10);
		expect(pageRange(Number.NaN, 25, Number.NaN).pageCount).toBe(1);
	});
});
