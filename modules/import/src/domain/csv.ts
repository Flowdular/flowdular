/**
 * An RFC 4180 reader for the one shape this module accepts: UTF-8, a header
 * row, comma separated, `"` quoting with `""` for a literal quote, CRLF or LF
 * record separators. Anything else is a refusal with a stable code rather than
 * a guess, because a file parsed the wrong way writes the wrong records.
 */

export type CsvErrorCode =
	| 'CSV_EMPTY'
	| 'CSV_HEADER_BLANK'
	| 'CSV_HEADER_DUPLICATE'
	| 'CSV_NOT_UTF8'
	| 'CSV_QUOTE_UNTERMINATED'
	| 'CSV_QUOTE_UNEXPECTED'
	| 'CSV_TOO_LARGE'
	| 'CSV_TOO_MANY_ROWS';

export class CsvError extends Error {
	constructor(
		readonly code: CsvErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'CsvError';
	}
}

export interface CsvRow {
	/** 1-based data row number, header excluded. */
	readonly row: number;
	readonly cells: readonly string[];
}

export interface CsvDocument {
	readonly header: readonly string[];
	readonly rows: readonly CsvRow[];
}

export interface CsvLimits {
	/** Bytes of encoded CSV; the stream is abandoned the moment it passes this. */
	readonly maxBytes: number;
	/** Data rows, header excluded. */
	readonly maxRows: number;
}

const BOM = '﻿';

/**
 * Reads at most `maxBytes` and refuses anything longer, so a hostile body costs
 * the cap rather than the file. The whole CSV is held in memory on purpose: the
 * cap is 25 MB, one job's rows are held anyway, and a streaming parser would
 * buy nothing against a bound this small.
 */
export async function readCsvBody(
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<Uint8Array> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				throw new CsvError(
					'CSV_TOO_LARGE',
					`The file is larger than ${maxBytes} bytes.`,
				);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
		/* The body is abandoned on a refusal as well, so a producer blocked on
		   backpressure is released rather than left holding the connection. */
		await body.cancel().catch(() => undefined);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export function decodeCsv(bytes: Uint8Array): string {
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw new CsvError('CSV_NOT_UTF8', 'The file is not valid UTF-8 text.');
	}
	return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/* One pass, no regular expressions and no per-character array: O(n) in the
   characters of the file and O(1) beyond the cells it produces.

   A cell is cut out of the source text rather than appended character by
   character: appending leaves every cell a tree of cons strings whose retained
   size is an order of magnitude past the file (measured 124 MB of heap for a
   5 MB CSV against 8.7 MB for these slices). `pending` carries only the pieces
   a doubled quote forces this reader to join. */
function parseRecords(text: string, maxRows: number): string[][] {
	const records: string[][] = [];
	let cells: string[] = [];
	let start = 0;
	let pending = '';
	let quoted = false;
	let started = false;
	let index = 0;

	/** Whether the cell being read has taken no character yet. */
	const empty = () => pending === '' && start === index;
	const endField = () => {
		cells.push(
			pending === ''
				? text.slice(start, index)
				: pending + text.slice(start, index),
		);
		pending = '';
		started = true;
	};
	const endRecord = () => {
		endField();
		records.push(cells);
		cells = [];
		started = false;
		/* The header is the first record, so the data bound is one past it. */
		if (records.length > maxRows + 1) {
			throw new CsvError(
				'CSV_TOO_MANY_ROWS',
				`The file holds more than ${maxRows} rows.`,
			);
		}
	};

	while (index < text.length) {
		const character = text[index]!;
		if (quoted) {
			if (character !== '"') {
				index += 1;
				continue;
			}
			if (text[index + 1] === '"') {
				/* The pair's first quote closes the piece and is the one literal
				   character the cell keeps. */
				pending += text.slice(start, index + 1);
				index += 2;
				start = index;
				continue;
			}
			pending =
				pending === ''
					? text.slice(start, index)
					: pending + text.slice(start, index);
			quoted = false;
			index += 1;
			start = index;
			/* Only a separator may follow a closing quote. `a"b"c` is a file whose
			   author meant something this reader cannot know. */
			const next = text[index];
			if (
				next !== undefined &&
				next !== ',' &&
				next !== '\n' &&
				next !== '\r'
			) {
				throw new CsvError(
					'CSV_QUOTE_UNEXPECTED',
					`Unexpected text after a closing quote at offset ${index}.`,
				);
			}
			continue;
		}
		if (character === '"') {
			if (!empty()) {
				throw new CsvError(
					'CSV_QUOTE_UNEXPECTED',
					`A quote may only open a field, at offset ${index}.`,
				);
			}
			quoted = true;
			started = true;
			index += 1;
			start = index;
			continue;
		}
		if (character === ',') {
			endField();
			index += 1;
			start = index;
			continue;
		}
		if (character === '\r' || character === '\n') {
			endRecord();
			index += character === '\r' && text[index + 1] === '\n' ? 2 : 1;
			start = index;
			continue;
		}
		started = true;
		index += 1;
	}

	if (quoted) {
		throw new CsvError(
			'CSV_QUOTE_UNTERMINATED',
			'A quoted field is never closed.',
		);
	}
	/* A file ending in a newline has no trailing empty record; one ending in
	   text does have a last record. */
	if (started || !empty() || cells.length > 0) endRecord();
	return records;
}

/**
 * Header cells are trimmed because whitespace around a column name is never
 * what the author meant, and a mapping keyed on `" email"` would silently miss.
 * Data cells keep every character they carried.
 */
export function parseCsv(text: string, limits: CsvLimits): CsvDocument {
	const records = parseRecords(text, limits.maxRows);
	const headerRecord = records[0];
	if (!headerRecord || (headerRecord.length === 1 && headerRecord[0] === '')) {
		throw new CsvError('CSV_EMPTY', 'The file carries no header row.');
	}
	const header = headerRecord.map((cell) => cell.trim());
	const seen = new Set<string>();
	for (const name of header) {
		if (name === '') {
			throw new CsvError('CSV_HEADER_BLANK', 'A column header is blank.');
		}
		if (seen.has(name)) {
			throw new CsvError(
				'CSV_HEADER_DUPLICATE',
				`The column ${name} appears more than once.`,
			);
		}
		seen.add(name);
	}
	const rows: CsvRow[] = [];
	for (let index = 1; index < records.length; index += 1) {
		rows.push({ row: index, cells: records[index]! });
	}
	return { header, rows };
}

export async function readCsv(
	body: ReadableStream<Uint8Array>,
	limits: CsvLimits,
): Promise<CsvDocument> {
	return parseCsv(decodeCsv(await readCsvBody(body, limits.maxBytes)), limits);
}
