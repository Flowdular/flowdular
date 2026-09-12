import { describe, expect, it } from 'vitest';
import {
	addDays,
	addMonths,
	clampIsoDay,
	datePresetRange,
	isOutsideBounds,
	isoDay,
	monthWeeks,
	startOfMonth,
	todayIso,
	weekdayIndex,
} from '../src/components/calendar.ts';

describe('calendar days', () => {
	it('reads the day out of a date and a datetime', () => {
		expect(isoDay('2026-09-14')).toBe('2026-09-14');
		expect(isoDay('2026-09-14T23:30')).toBe('2026-09-14');
		expect(isoDay('')).toBe('');
		expect(isoDay('not a day')).toBe('');
	});

	it('moves by whole days across a month and a year boundary', () => {
		expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
		expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
		expect(addDays('2026-09-14', 7)).toBe('2026-09-21');
	});

	/* A daylight saving change is exactly where a Date-based implementation
	   lands on the wrong day, so the arithmetic is checked across one. */
	it('crosses a daylight saving change without losing a day', () => {
		expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
		expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
		expect(addDays('2026-03-29', -1)).toBe('2026-03-28');
	});

	it('keeps the day of the month where the target month has one', () => {
		expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
		expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
		expect(addMonths('2026-03-15', -3)).toBe('2025-12-15');
		expect(addMonths('2026-01-15', 12)).toBe('2027-01-15');
	});

	it('holds a day inside its bounds', () => {
		const bounds = { min: '2026-09-10', max: '2026-09-20' };
		expect(clampIsoDay('2026-09-01', bounds)).toBe('2026-09-10');
		expect(clampIsoDay('2026-09-30', bounds)).toBe('2026-09-20');
		expect(clampIsoDay('2026-09-14', bounds)).toBe('2026-09-14');
		expect(clampIsoDay('2026-09-14', {})).toBe('2026-09-14');
		expect(isOutsideBounds('2026-09-21', bounds)).toBe(true);
		expect(isOutsideBounds('2026-09-20', bounds)).toBe(false);
	});

	it('compares a datetime bound by its day', () => {
		const bounds = { min: '2026-09-14T16:00', max: '2026-09-15T09:00' };
		expect(isOutsideBounds('2026-09-14', bounds)).toBe(false);
		expect(isOutsideBounds('2026-09-13', bounds)).toBe(true);
	});

	it('names the reader own today, not a UTC one', () => {
		const midnight = new Date(2026, 8, 14, 0, 30).getTime();
		expect(todayIso(midnight)).toBe('2026-09-14');
	});
});

describe('month grid', () => {
	const bounds = { min: '2026-09-10', max: '2026-09-20' };

	it('always renders six weeks so the popover keeps one height', () => {
		for (const month of ['2026-02-01', '2026-09-01', '2026-11-01']) {
			const weeks = monthWeeks(month, 1);
			expect(weeks).toHaveLength(6);
			for (const week of weeks) expect(week.days).toHaveLength(7);
		}
	});

	it('starts the week where the reader starts it', () => {
		const monday = monthWeeks('2026-09-01', 1)[0]?.days[0];
		const sunday = monthWeeks('2026-09-01', 0)[0]?.days[0];
		expect(monday?.iso).toBe('2026-08-31');
		expect(sunday?.iso).toBe('2026-08-30');
		expect(monday?.inMonth).toBe(false);
		expect(weekdayIndex('2026-08-31', 1)).toBe(0);
		expect(weekdayIndex('2026-09-06', 1)).toBe(6);
	});

	it('marks the days of the month and the days around it', () => {
		const days = monthWeeks('2026-09-01', 1).flatMap((week) => week.days);
		expect(days.filter((day) => day.inMonth)).toHaveLength(30);
		expect(days.find((day) => day.iso === '2026-09-01')?.inMonth).toBe(true);
		expect(days.find((day) => day.iso === '2026-10-01')?.inMonth).toBe(false);
	});

	it('disables every day outside the bounds', () => {
		const days = monthWeeks('2026-09-01', 1, bounds).flatMap(
			(week) => week.days,
		);
		const enabled = days.filter((day) => !day.disabled).map((day) => day.iso);
		expect(enabled[0]).toBe('2026-09-10');
		expect(enabled[enabled.length - 1]).toBe('2026-09-20');
		expect(enabled).toHaveLength(11);
	});

	it('answers nothing for a month it cannot read', () => {
		expect(monthWeeks('', 1)).toEqual([]);
		expect(startOfMonth('2026-09-14')).toBe('2026-09-01');
	});
});

describe('date presets', () => {
	const today = '2026-09-14';

	it('names the four standard windows, both ends inclusive', () => {
		expect(datePresetRange('today', today)).toEqual({
			from: '2026-09-14',
			to: '2026-09-14',
		});
		expect(datePresetRange('last-7-days', today)).toEqual({
			from: '2026-09-08',
			to: '2026-09-14',
		});
		expect(datePresetRange('last-30-days', today)).toEqual({
			from: '2026-08-16',
			to: '2026-09-14',
		});
		expect(datePresetRange('this-month', today)).toEqual({
			from: '2026-09-01',
			to: '2026-09-14',
		});
	});
});
