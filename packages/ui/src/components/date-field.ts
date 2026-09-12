/** 'date' renders a native date input, 'datetime' a datetime-local one. */
export type DateFieldKind = 'date' | 'datetime';

const ISO_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/;

export function dateInputType(
	kind: DateFieldKind | undefined,
): 'date' | 'datetime-local' {
	return kind === 'datetime' ? 'datetime-local' : 'date';
}

/* A native date input carries a calendar date, not an instant. Parsing it with
   `new Date(value)` would read it as UTC and shift the day west of Greenwich,
   so the parts are read out and placed in the reader's own day. */
function parseIsoValue(value: string): Date | null {
	const parts = ISO_PATTERN.exec(value);
	if (!parts) return null;
	const year = Number(parts[1]);
	const month = Number(parts[2]);
	const day = Number(parts[3]);
	const date = new Date(
		year,
		month - 1,
		day,
		Number(parts[4] ?? 0),
		Number(parts[5] ?? 0),
		Number(parts[6] ?? 0),
	);
	date.setFullYear(year);
	if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
	return date;
}

/**
 * The value of a date field as the reader writes it. Returns '' for an empty
 * or unparseable value, so a screen renders the reading unconditionally.
 */
export function formatDateValue(
	value: string,
	kind: DateFieldKind | undefined,
	locale?: string | undefined,
): string {
	const date = parseIsoValue(value);
	if (!date) return '';
	return new Intl.DateTimeFormat(
		locale,
		kind === 'datetime'
			? { dateStyle: 'medium', timeStyle: 'short' }
			: { dateStyle: 'medium' },
	).format(date);
}

/**
 * Whether the end of a range precedes its start. ISO values of one kind order
 * chronologically as text, so the check costs no Date allocation. An
 * incomplete range is never reversed: the reader is still filling it in.
 */
export function dateRangeReversed(from: string, to: string): boolean {
	if (from === '' || to === '') return false;
	return to < from;
}
