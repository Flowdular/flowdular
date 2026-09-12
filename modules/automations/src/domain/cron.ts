/**
 * Five field cron with no seconds: minute, hour, day of month, month, day of
 * week. Each field is `*`, a number, a range `a-b`, any of those with a step
 * `/n`, or a comma separated list of them. Three letter month and weekday
 * names are accepted and normalized to numbers. A next run is a wall clock
 * time in the workspace zone, resolved to one UTC instant through Intl.
 */
export const MAX_CRON_LENGTH = 100;
const MAX_FIELD_ITEMS = 32;
/* Four years covers 29 February, so an expression with no match inside the
   window has none at all and is refused where it is saved. */
const MAX_SEARCH_DAYS = 1_500;
const DAY_MS = 86_400_000;

export class InvalidCronError extends Error {
	constructor(detail: string) {
		super(`Cron expression is invalid: ${detail}`);
		this.name = 'InvalidCronError';
	}
}

export interface CronFields {
	readonly minutes: readonly number[];
	readonly hours: readonly number[];
	readonly daysOfMonth: readonly number[];
	readonly months: readonly number[];
	/** 0 is Sunday; 7 is accepted on input and stored as 0. */
	readonly daysOfWeek: readonly number[];
	/* Vixie rule: with both day fields restricted a slot matches either one, so
	   `0 0 13 * 5` is the 13th and every Friday, not only Friday the 13th. A
	   field that starts with a star is unrestricted, step or not, so a stepped
	   day of month keeps the intersection. */
	readonly dayUnion: boolean;
}

const MONTH_NAMES = [
	'jan',
	'feb',
	'mar',
	'apr',
	'may',
	'jun',
	'jul',
	'aug',
	'sep',
	'oct',
	'nov',
	'dec',
];

const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface FieldSpec {
	readonly name: string;
	readonly min: number;
	readonly max: number;
	readonly names?: readonly string[];
}

const SPECS: readonly FieldSpec[] = [
	{ name: 'minute', min: 0, max: 59 },
	{ name: 'hour', min: 0, max: 23 },
	{ name: 'day of month', min: 1, max: 31 },
	{ name: 'month', min: 1, max: 12, names: MONTH_NAMES },
	{ name: 'day of week', min: 0, max: 7, names: WEEKDAY_NAMES },
];

function fieldValue(raw: string, spec: FieldSpec): number {
	const named = spec.names?.indexOf(raw) ?? -1;
	if (named >= 0) return named + spec.min;
	if (!/^\d{1,2}$/.test(raw)) {
		throw new InvalidCronError(`${spec.name} has an unsupported value`);
	}
	const value = Number(raw);
	if (value < spec.min || value > spec.max) {
		throw new InvalidCronError(
			`${spec.name} must be between ${spec.min} and ${spec.max}`,
		);
	}
	return value;
}

function parseField(raw: string, spec: FieldSpec): readonly number[] {
	const items = raw.split(',');
	if (items.length > MAX_FIELD_ITEMS) {
		throw new InvalidCronError(`${spec.name} lists too many values`);
	}
	const values = new Set<number>();
	for (const item of items) {
		const parts = item.split('/');
		if (parts.length > 2 || parts[0] === '') {
			throw new InvalidCronError(`${spec.name} has an unsupported value`);
		}
		const stepped = parts.length === 2;
		const step = stepped ? Number(parts[1]) : 1;
		if (
			stepped &&
			(!/^\d{1,2}$/.test(parts[1]!) ||
				step < 1 ||
				step > spec.max - spec.min + 1)
		) {
			throw new InvalidCronError(`${spec.name} has an unsupported step`);
		}
		let from: number;
		let to: number;
		if (parts[0] === '*') {
			from = spec.min;
			to = spec.max;
		} else {
			const bounds = parts[0]!.split('-');
			if (bounds.length > 2) {
				throw new InvalidCronError(`${spec.name} has an unsupported range`);
			}
			from = fieldValue(bounds[0]!, spec);
			if (bounds.length === 1) {
				/* A single value with a step would silently mean `value to max`. */
				if (stepped) {
					throw new InvalidCronError(
						`${spec.name} needs a range or * before a step`,
					);
				}
				to = from;
			} else {
				to = fieldValue(bounds[1]!, spec);
				if (to < from) {
					throw new InvalidCronError(`${spec.name} range runs backwards`);
				}
			}
		}
		for (let value = from; value <= to; value += step) values.add(value);
	}
	return [...values].sort((left, right) => left - right);
}

export function parseCron(expression: string): CronFields {
	if (expression.length > MAX_CRON_LENGTH) {
		throw new InvalidCronError('it is too long');
	}
	const fields = expression.trim().toLowerCase().split(/\s+/);
	if (fields.length !== 5 || fields[0] === '') {
		throw new InvalidCronError('it needs five fields');
	}
	const parsed = fields.map((field, index) => parseField(field, SPECS[index]!));
	/* Sunday is both 0 and 7 on input; the matcher only ever sees 0. */
	const daysOfWeek = [
		...new Set(parsed[4]!.map((day) => (day === 7 ? 0 : day))),
	].sort((left, right) => left - right);
	return {
		minutes: parsed[0]!,
		hours: parsed[1]!,
		daysOfMonth: parsed[2]!,
		months: parsed[3]!,
		daysOfWeek,
		dayUnion: !fields[2]!.startsWith('*') && !fields[4]!.startsWith('*'),
	};
}

/** One canonical spelling: lower case, single spaces, no surrounding space. */
export function normalizeCron(expression: string): string {
	parseCron(expression);
	return expression.trim().toLowerCase().split(/\s+/).join(' ');
}

interface WallTime {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
	const cached = formatters.get(timeZone);
	if (cached) return cached;
	const created = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});
	/* Bounded: a deployment holds a handful of workspace zones, and the cap
	   keeps a long-lived process from carrying every zone it ever saw. */
	if (formatters.size >= 32) formatters.clear();
	formatters.set(timeZone, created);
	return created;
}

function partsOf(
	instant: number,
	timeZone: string,
): WallTime & { second: number } {
	const parts = formatterFor(timeZone).formatToParts(new Date(instant));
	const read = (type: string): number =>
		Number(parts.find((part) => part.type === type)?.value ?? '0');
	return {
		year: read('year'),
		month: read('month'),
		day: read('day'),
		hour: read('hour'),
		minute: read('minute'),
		second: read('second'),
	};
}

function asUtc(wall: WallTime, second = 0): number {
	return Date.UTC(
		wall.year,
		wall.month - 1,
		wall.day,
		wall.hour,
		wall.minute,
		second,
	);
}

function offsetAt(instant: number, timeZone: string): number {
	const parts = partsOf(instant, timeZone);
	return asUtc(parts, parts.second) - Math.floor(instant / 1_000) * 1_000;
}

/**
 * The UTC instant of a wall clock time, or null when the zone skips it because
 * clocks moved forward. A wall time that occurs twice resolves to the first of
 * the two, so a slot in a repeated hour fires once.
 */
export function instantOf(wall: WallTime, timeZone: string): number | null {
	const wallMs = asUtc(wall);
	/* The offsets a day either side bracket any transition near this wall time,
	   so both readings of an ambiguous hour are candidates and a wall time the
	   zone skipped produces none that verifies. */
	const before = wallMs - offsetAt(wallMs - DAY_MS, timeZone);
	const after = wallMs - offsetAt(wallMs + DAY_MS, timeZone);
	let resolved: number | null = null;
	for (const candidate of before === after ? [before] : [before, after]) {
		if (resolved !== null && candidate >= resolved) continue;
		const parts = partsOf(candidate, timeZone);
		if (
			parts.year === wall.year &&
			parts.month === wall.month &&
			parts.day === wall.day &&
			parts.hour === wall.hour &&
			parts.minute === wall.minute
		) {
			resolved = candidate;
		}
	}
	return resolved;
}

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekdayOf(wall: WallTime): number {
	return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
}

function dayMatches(fields: CronFields, wall: WallTime): boolean {
	const byDate = fields.daysOfMonth.includes(wall.day);
	const byWeekday = fields.daysOfWeek.includes(weekdayOf(wall));
	return fields.dayUnion ? byDate || byWeekday : byDate && byWeekday;
}

function nextMonth(wall: WallTime): void {
	wall.month += 1;
	if (wall.month > 12) {
		wall.month = 1;
		wall.year += 1;
	}
	wall.day = 1;
	wall.hour = 0;
	wall.minute = 0;
}

function nextDay(wall: WallTime): void {
	wall.day += 1;
	wall.hour = 0;
	wall.minute = 0;
	if (wall.day > daysInMonth(wall.year, wall.month)) {
		wall.day = 1;
		wall.month += 1;
		if (wall.month > 12) {
			wall.month = 1;
			wall.year += 1;
		}
	}
}

function nextHour(wall: WallTime): void {
	if (wall.hour >= 23) {
		nextDay(wall);
		return;
	}
	wall.hour += 1;
	wall.minute = 0;
}

function nextMinute(wall: WallTime): void {
	wall.minute += 1;
	if (wall.minute > 59) {
		wall.minute = 0;
		nextHour(wall);
	}
}

/**
 * The first slot strictly after `after`, as a UTC instant. The search walks the
 * workspace wall clock, so the daily hour stays the same across a daylight
 * saving change; Intl is consulted only to convert the match it found. Returns
 * null for an expression no real date matches, such as 30 February.
 */
export function nextCronSlot(
	fields: CronFields,
	after: number,
	timeZone: string,
): number | null {
	const start = partsOf(after, timeZone);
	const wall: WallTime = {
		year: start.year,
		month: start.month,
		day: start.day,
		hour: start.hour,
		minute: start.minute,
	};
	nextMinute(wall);
	let days = 0;
	while (days <= MAX_SEARCH_DAYS) {
		if (!fields.months.includes(wall.month)) {
			days += daysInMonth(wall.year, wall.month) - wall.day + 1;
			nextMonth(wall);
			continue;
		}
		if (!dayMatches(fields, wall)) {
			days += 1;
			nextDay(wall);
			continue;
		}
		if (!fields.hours.includes(wall.hour)) {
			const previousDay = wall.day;
			nextHour(wall);
			if (wall.day !== previousDay) days += 1;
			continue;
		}
		if (!fields.minutes.includes(wall.minute)) {
			const previousDay = wall.day;
			nextMinute(wall);
			if (wall.day !== previousDay) days += 1;
			continue;
		}
		const instant = instantOf(wall, timeZone);
		/* A wall time the zone skipped has no instant, and one inside a repeated
		   hour can resolve behind `after`; both move on to the next candidate so
		   a slot is never fired twice and never replayed. */
		if (instant !== null && instant > after) return instant;
		const previousDay = wall.day;
		nextMinute(wall);
		if (wall.day !== previousDay) days += 1;
	}
	return null;
}
