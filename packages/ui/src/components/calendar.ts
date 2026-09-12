/** The four windows every list screen offers, named once so they agree. */
export type DatePresetId =
	| 'today'
	| 'last-7-days'
	| 'last-30-days'
	| 'this-month';

export const DATE_PRESET_IDS: readonly DatePresetId[] = [
	'today',
	'last-7-days',
	'last-30-days',
	'this-month',
];

/** One day of a rendered month. */
export interface CalendarDay {
	/** 'YYYY-MM-DD'. */
	readonly iso: string;
	readonly dayOfMonth: number;
	/** False for the leading and trailing days of the neighbouring months. */
	readonly inMonth: boolean;
	/** Outside `min` or `max`: rendered, never selectable. */
	readonly disabled: boolean;
}

export interface CalendarWeek {
	readonly key: string;
	readonly days: readonly CalendarDay[];
}

export interface CalendarBounds {
	readonly min?: string | undefined;
	readonly max?: string | undefined;
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;
const DAY_MS = 86_400_000;

function pad(value: number): string {
	return value < 10 ? '0' + value : String(value);
}

/**
 * The calendar day inside a date or datetime value, or '' when there is none.
 * A datetime keeps its time elsewhere: the grid only ever answers about days.
 */
export function isoDay(value: string): string {
	const parts = DAY_PATTERN.exec(value);
	if (!parts) return '';
	return `${parts[1]}-${parts[2]}-${parts[3]}`;
}

/* Days are counted at UTC midnight so arithmetic never crosses a daylight
   saving boundary: a calendar day is not an instant, and `new Date(iso)` would
   make it one. */
function toDayNumber(iso: string): number | null {
	const parts = DAY_PATTERN.exec(iso);
	if (!parts) return null;
	const year = Number(parts[1]);
	const month = Number(parts[2]);
	const day = Number(parts[3]);
	const stamp = Date.UTC(year, month - 1, day);
	const date = new Date(stamp);
	if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
		return null;
	return stamp;
}

function fromDayNumber(stamp: number): string {
	const date = new Date(stamp);
	return (
		`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-` +
		pad(date.getUTCDate())
	);
}

/** The reader's own today, which is a calendar day and not an instant. */
export function todayIso(now: number = Date.now()): string {
	const date = new Date(now);
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-` + pad(date.getDate())
	);
}

/** `iso` moved by whole days, or '' when `iso` is not a calendar day. */
export function addDays(iso: string, days: number): string {
	const stamp = toDayNumber(iso);
	if (stamp === null) return '';
	return fromDayNumber(stamp + days * DAY_MS);
}

/**
 * `iso` moved by whole months, keeping the day of the month where it exists:
 * 31 January back one month is 28 or 29 February, never 2 or 3 March.
 */
export function addMonths(iso: string, months: number): string {
	const stamp = toDayNumber(iso);
	if (stamp === null) return '';
	const date = new Date(stamp);
	const target = date.getUTCMonth() + months;
	const year = date.getUTCFullYear() + Math.floor(target / 12);
	const month = ((target % 12) + 12) % 12;
	const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	return `${year}-${pad(month + 1)}-${pad(Math.min(date.getUTCDate(), lastDay))}`;
}

export function startOfMonth(iso: string): string {
	const day = isoDay(iso);
	return day === '' ? '' : day.slice(0, 8) + '01';
}

/** `iso` held inside the bounds. Either bound may be absent or unparseable. */
export function clampIsoDay(iso: string, bounds: CalendarBounds = {}): string {
	const day = isoDay(iso);
	if (day === '') return '';
	const min = isoDay(bounds.min ?? '');
	const max = isoDay(bounds.max ?? '');
	if (min !== '' && day < min) return min;
	if (max !== '' && day > max) return max;
	return day;
}

export function isOutsideBounds(iso: string, bounds: CalendarBounds): boolean {
	const min = isoDay(bounds.min ?? '');
	const max = isoDay(bounds.max ?? '');
	return (min !== '' && iso < min) || (max !== '' && iso > max);
}

/**
 * The first weekday of the reader's week, 0 for Sunday. Engines without
 * `weekInfo` answer Monday, which is the platform's default reading order.
 */
export function firstWeekday(locale?: string | undefined): number {
	try {
		const info = new Intl.Locale(
			locale ?? new Intl.DateTimeFormat().resolvedOptions().locale,
		) as Intl.Locale & {
			getWeekInfo?: () => { firstDay: number };
			weekInfo?: { firstDay: number };
		};
		const first = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay;
		if (typeof first === 'number') return first % 7;
	} catch {
		/* An unparseable tag is the caller's, not the grid's, problem: the week
	   still has to start somewhere. */
	}
	return 1;
}

/** Position of `iso` inside its week, 0 for the first column rendered. */
export function weekdayIndex(iso: string, weekStart: number): number {
	const stamp = toDayNumber(iso);
	if (stamp === null) return 0;
	return (new Date(stamp).getUTCDay() - weekStart + 7) % 7;
}

/**
 * Six weeks of `month`, always, so the popover keeps one height and changing
 * months never moves the controls under the reader's pointer. 42 cells is the
 * whole cost of a month change.
 */
export function monthWeeks(
	month: string,
	weekStart: number,
	bounds: CalendarBounds = {},
): readonly CalendarWeek[] {
	const first = toDayNumber(startOfMonth(month));
	if (first === null) return [];
	const monthKey = fromDayNumber(first).slice(0, 7);
	const lead = (new Date(first).getUTCDay() - weekStart + 7) % 7;
	const weeks: CalendarWeek[] = [];
	for (let week = 0; week < 6; week += 1) {
		const days: CalendarDay[] = [];
		for (let index = 0; index < 7; index += 1) {
			const iso = fromDayNumber(first + (week * 7 + index - lead) * DAY_MS);
			days.push({
				iso,
				dayOfMonth: Number(iso.slice(8)),
				inMonth: iso.slice(0, 7) === monthKey,
				disabled: isOutsideBounds(iso, bounds),
			});
		}
		weeks.push({ key: days[0]?.iso ?? String(week), days });
	}
	return weeks;
}

/** The month heading, e.g. 'September 2026'. */
export function monthLabel(month: string, locale?: string | undefined): string {
	const stamp = toDayNumber(startOfMonth(month));
	if (stamp === null) return '';
	return new Intl.DateTimeFormat(locale, {
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC',
	}).format(stamp);
}

/** Column headings from the same week the grid renders, shortest form. */
export function weekdayLabels(
	weekStart: number,
	locale?: string | undefined,
): readonly string[] {
	const format = new Intl.DateTimeFormat(locale, {
		weekday: 'short',
		timeZone: 'UTC',
	});
	/* 4 January 1970 was a Sunday, so the offset is the weekday itself. */
	const sunday = Date.UTC(1970, 0, 4);
	return Array.from({ length: 7 }, (_unused, index) =>
		format.format(sunday + ((weekStart + index) % 7) * DAY_MS),
	);
}

/** The day a full reading names, e.g. 'Monday, 14 September 2026'. */
export function dayLabel(iso: string, locale?: string | undefined): string {
	const stamp = toDayNumber(iso);
	if (stamp === null) return '';
	return new Intl.DateTimeFormat(locale, {
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC',
	}).format(stamp);
}

/**
 * The window a preset selects, both ends inclusive. 'this-month' is the month
 * so far: a range that ends in the future selects records that do not exist,
 * which reads as an empty list rather than as a filter.
 */
export function datePresetRange(
	id: DatePresetId,
	today: string = todayIso(),
): { readonly from: string; readonly to: string } {
	const day = isoDay(today);
	if (day === '') return { from: '', to: '' };
	if (id === 'today') return { from: day, to: day };
	if (id === 'last-7-days') return { from: addDays(day, -6), to: day };
	if (id === 'last-30-days') return { from: addDays(day, -29), to: day };
	return { from: startOfMonth(day), to: day };
}
