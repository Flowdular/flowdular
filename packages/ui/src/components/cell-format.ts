export type CellTimeKind = 'datetime' | 'date';

export interface CellTimeReading {
	/** The compact reading on screen. */
	readonly text: string;
	/** The full reading with seconds, for the title. */
	readonly full: string;
	/** The machine value for `<time datetime>`. */
	readonly datetime: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/* A formatter costs far more to build than to use, and a table formats every
   row. The key space is the locales a reader switches between times a handful
   of option sets, so the cache stays small. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(
	locale: string | undefined,
	options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
	const key = (locale ?? '') + '|' + JSON.stringify(options);
	let cached = FORMATTERS.get(key);
	if (cached === undefined) {
		cached = new Intl.DateTimeFormat(locale, options);
		FORMATTERS.set(key, cached);
	}
	return cached;
}

/**
 * The compact and the full reading of a timestamp. The year is left out while it
 * is the current one, and the hour cycle follows the locale. A plain
 * `YYYY-MM-DD` is a calendar day, read in UTC so no time zone moves it to the
 * day before; any other value reads in `timeZone` when given, else the host's.
 * Answers null for a value no Date can hold.
 */
export function cellTime(
	value: string | number | Date,
	kind: CellTimeKind,
	locale: string | undefined,
	now: Date = new Date(),
	timeZone?: string | undefined,
): CellTimeReading | null {
	const day = typeof value === 'string' && DATE_ONLY.test(value);
	const date =
		value instanceof Date
			? value
			: new Date(day ? value + 'T00:00:00Z' : value);
	if (Number.isNaN(date.getTime())) return null;
	const zoneName = day ? 'UTC' : timeZone;
	const zone = zoneName === undefined ? {} : { timeZone: zoneName };
	const year = formatter('en', { ...zone, year: 'numeric' });
	const sameYear = year.format(date) === year.format(now);
	if (kind === 'date' || day) {
		return {
			text: formatter(locale, {
				...zone,
				day: 'numeric',
				month: 'short',
				...(sameYear ? {} : { year: 'numeric' }),
			}).format(date),
			full: formatter(locale, { ...zone, dateStyle: 'long' }).format(date),
			datetime: day ? String(value) : date.toISOString().slice(0, 10),
		};
	}
	return {
		text: formatter(locale, {
			...zone,
			day: 'numeric',
			month: 'short',
			...(sameYear ? {} : { year: 'numeric' }),
			hour: 'numeric',
			minute: '2-digit',
		}).format(date),
		full: formatter(locale, {
			...zone,
			dateStyle: 'medium',
			timeStyle: timeZone === undefined ? 'medium' : 'long',
		}).format(date),
		datetime: date.toISOString(),
	};
}

/** An identifier longer than `max` keeps its head and its tail: `4783b5b2…40d8`. */
export function shortCode(value: string, max: number): string {
	if (value.length <= max) return value;
	const head = Math.max(2, Math.ceil(max / 2));
	const tail = Math.max(2, Math.floor(max / 4));
	return value.slice(0, head) + '…' + value.slice(-tail);
}

const NUMBER_FORMATTERS = new Map<string, Intl.NumberFormat>();

export function cellNumber(
	value: number | bigint,
	locale: string | undefined,
	options: Intl.NumberFormatOptions | undefined,
): string {
	const key = (locale ?? '') + '|' + JSON.stringify(options ?? {});
	let cached = NUMBER_FORMATTERS.get(key);
	if (cached === undefined) {
		cached = new Intl.NumberFormat(locale, options);
		NUMBER_FORMATTERS.set(key, cached);
	}
	return cached.format(value);
}
