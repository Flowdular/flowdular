import { describe, expect, it } from 'vitest';
import {
	dateInputType,
	dateRangeReversed,
	formatDateValue,
} from '../src/components/date-field.ts';

function localReading(date: Date, kind: 'date' | 'datetime'): string {
	return new Intl.DateTimeFormat(
		'en-GB',
		kind === 'datetime'
			? { dateStyle: 'medium', timeStyle: 'short' }
			: { dateStyle: 'medium' },
	).format(date);
}

describe('date field values', () => {
	it('picks the native input type from the kind', () => {
		expect(dateInputType(undefined)).toBe('date');
		expect(dateInputType('date')).toBe('date');
		expect(dateInputType('datetime')).toBe('datetime-local');
	});

	it("reads a calendar date as the reader's own day", () => {
		expect(formatDateValue('2026-09-11', 'date', 'en-GB')).toBe(
			localReading(new Date(2026, 8, 11), 'date'),
		);
	});

	it('keeps the wall clock of a datetime value', () => {
		expect(formatDateValue('2026-09-11T14:30', 'datetime', 'en-GB')).toBe(
			localReading(new Date(2026, 8, 11, 14, 30), 'datetime'),
		);
	});

	it('reads nothing from an empty, malformed or impossible value', () => {
		expect(formatDateValue('', 'date', 'en-GB')).toBe('');
		expect(formatDateValue('11/09/2026', 'date', 'en-GB')).toBe('');
		expect(formatDateValue('2026-02-31', 'date', 'en-GB')).toBe('');
		expect(formatDateValue('2026-13-01', 'date', 'en-GB')).toBe('');
	});
});

describe('date range order', () => {
	it('reports an end that precedes its start', () => {
		expect(dateRangeReversed('2026-01-10', '2026-01-02')).toBe(true);
		expect(dateRangeReversed('2026-01-02T14:00', '2026-01-02T09:00')).toBe(
			true,
		);
	});

	it('accepts an ordered or equal range', () => {
		expect(dateRangeReversed('2026-01-02', '2026-01-10')).toBe(false);
		expect(dateRangeReversed('2026-01-02', '2026-01-02')).toBe(false);
	});

	it('leaves a half-filled range alone', () => {
		expect(dateRangeReversed('', '2026-01-02')).toBe(false);
		expect(dateRangeReversed('2026-01-10', '')).toBe(false);
		expect(dateRangeReversed('', '')).toBe(false);
	});
});
