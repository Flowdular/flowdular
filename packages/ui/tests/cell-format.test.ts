import { describe, expect, it } from 'vitest';
import {
	cellNumber,
	cellTime,
	shortCode,
} from '../src/components/cell-format.ts';

const NOW = new Date(2026, 8, 16, 12, 0, 0);

describe('cellTime', () => {
	it('drops the year of the current year and keeps it for another', () => {
		const current = cellTime(
			new Date(2026, 8, 16, 19, 39, 5),
			'datetime',
			'en-GB',
			NOW,
		);
		expect(current?.text).toBe('16 Sept, 19:39');
		const older = cellTime(
			new Date(2025, 0, 2, 7, 5, 0),
			'datetime',
			'en-GB',
			NOW,
		);
		expect(older?.text).toContain('2025');
	});

	it('follows the hour cycle of the locale and titles the full timestamp with seconds', () => {
		const value = new Date(2026, 8, 16, 19, 39, 5);
		expect(cellTime(value, 'datetime', 'en-US', NOW)?.text).toContain('PM');
		expect(cellTime(value, 'datetime', 'pl', NOW)?.text).toContain('19:39');
		expect(cellTime(value, 'datetime', 'pl', NOW)?.full).toContain('19:39:05');
		expect(cellTime(value, 'datetime', 'pl', NOW)?.datetime).toBe(
			value.toISOString(),
		);
	});

	it('reads epoch milliseconds and ISO strings alike', () => {
		const value = new Date(2026, 3, 1, 8, 30);
		expect(cellTime(value.getTime(), 'datetime', 'pl', NOW)?.text).toBe(
			cellTime(value.toISOString(), 'datetime', 'pl', NOW)?.text,
		);
	});

	it('keeps a calendar day on its day in any time zone', () => {
		const day = cellTime('2026-03-01', 'datetime', 'en-GB', NOW);
		expect(day?.text).toBe('1 Mar');
		expect(day?.datetime).toBe('2026-03-01');
		expect(
			cellTime(new Date(2026, 2, 1, 23, 0), 'date', 'en-GB', NOW)?.text,
		).not.toContain(':');
	});

	it('reads a timestamp in the zone it was given and names the zone', () => {
		const value = Date.UTC(2026, 8, 16, 22, 30, 0);
		const tokyo = cellTime(value, 'datetime', 'en-GB', NOW, 'Asia/Tokyo');
		expect(tokyo?.text).toBe('17 Sept, 7:30');
		expect(tokyo?.full).toContain('GMT+9');
		expect(tokyo?.datetime).toBe(new Date(value).toISOString());
	});

	it('answers null for a value no date can hold', () => {
		expect(cellTime('not a date', 'datetime', 'en', NOW)).toBeNull();
	});
});

describe('shortCode', () => {
	it('keeps a short identifier whole', () => {
		expect(shortCode('tok_1234', 16)).toBe('tok_1234');
		expect(shortCode('1234567890abcdef', 16)).toBe('1234567890abcdef');
	});

	it('keeps the head and the tail of a long identifier', () => {
		expect(shortCode('4783b5b2-1c5e-4bd8-9a55-7f0d2c3a40d8', 16)).toBe(
			'4783b5b2…40d8',
		);
	});
});

describe('cellNumber', () => {
	it('groups digits in the reader locale', () => {
		expect(cellNumber(12345, 'en', undefined)).toBe('12,345');
		expect(cellNumber(12345, 'pl', undefined)).toBe('12\u00a0345');
	});
});
