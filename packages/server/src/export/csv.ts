/**
 * RFC 4180 with a UTF-8 BOM. Nothing here knows what a list is: it turns cells
 * into fields and fields into records, and the driver decides how many.
 */

/**
 * Excel reads a CSV as the current code page unless the file opens with this,
 * so a workspace whose members carry accented names sees them intact. Every
 * other reader treats it as a zero-width no-break space and skips it.
 */
export const CSV_BOM = '\uFEFF';

/** RFC 4180: a record ends in CRLF, including the last one. */
export const CSV_RECORD_SEPARATOR = '\r\n';

/* The three characters RFC 4180 gives a meaning to, plus the lone CR a reader
   would otherwise take as the end of a record. */
const NEEDS_QUOTING = /["\r\n,]/;

/** One field, quoted only when it carries a character RFC 4180 reserves. */
export function csvField(value: string): string {
	if (!NEEDS_QUOTING.test(value)) return value;
	return `"${value.replaceAll('"', '""')}"`;
}

/** One record, terminated. Fields are joined in the order they are given. */
export function csvRecord(values: readonly string[]): string {
	let record = '';
	for (let index = 0; index < values.length; index += 1) {
		if (index > 0) record += ',';
		record += csvField(values[index] ?? '');
	}
	return record + CSV_RECORD_SEPARATOR;
}
