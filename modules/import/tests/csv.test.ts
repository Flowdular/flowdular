import { describe, expect, it } from 'vitest';
import {
	CsvError,
	decodeCsv,
	parseCsv,
	readCsv,
	readCsvBody,
} from '../src/domain/csv.ts';

const LIMITS = { maxBytes: 1_048_576, maxRows: 1_000 } as const;

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			/* Two chunks, so a reader that only looks at the first is caught. */
			controller.enqueue(bytes.slice(0, Math.ceil(bytes.length / 2)));
			controller.enqueue(bytes.slice(Math.ceil(bytes.length / 2)));
			controller.close();
		},
	});
}

/**
 * A file the way a workspace sends one: ASCII, four columns, cells long enough
 * that a reader appending character by character leaves a cons string tree per
 * cell instead of a short flattened string.
 */
function syntheticCsv(bytes: number): string {
	const lines = ['email,displayName,role,note'];
	let total = lines[0]!.length + 1;
	let index = 0;
	while (total < bytes) {
		const line =
			`person-${index}-with-a-long-local-part@example-company.test,` +
			`Person Number ${index} Of The Long Display Name Series,` +
			`member-role-${index % 7},` +
			`a note column that carries some prose for row ${index} of the file`;
		lines.push(line);
		total += line.length + 1;
		index += 1;
	}
	return lines.join('\n');
}

function code(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return error instanceof CsvError ? error.code : 'NOT_A_CSV_ERROR';
	}
	return 'NO_ERROR';
}

describe('the CSV reader', () => {
	it('reads a header and its data rows', () => {
		const document = parseCsv('a,b\n1,2\n3,4', LIMITS);
		expect(document.header).toEqual(['a', 'b']);
		expect(document.rows).toEqual([
			{ row: 1, cells: ['1', '2'] },
			{ row: 2, cells: ['3', '4'] },
		]);
	});

	it('keeps a comma inside a quoted field', () => {
		expect(parseCsv('a,b\n"Lovelace, Ada",x', LIMITS).rows[0]?.cells).toEqual([
			'Lovelace, Ada',
			'x',
		]);
	});

	it('reads a doubled quote as one literal quote', () => {
		expect(parseCsv('a\n"she said ""go"""', LIMITS).rows[0]?.cells).toEqual([
			'she said "go"',
		]);
	});

	it('keeps a newline inside a quoted field', () => {
		const document = parseCsv('a,b\n"one\ntwo",x', LIMITS);
		expect(document.rows).toEqual([{ row: 1, cells: ['one\ntwo', 'x'] }]);
	});

	it('reads CRLF records without leaving a carriage return behind', () => {
		expect(parseCsv('a,b\r\n1,2\r\n', LIMITS).rows).toEqual([
			{ row: 1, cells: ['1', '2'] },
		]);
	});

	it('strips a byte order mark from the first header', () => {
		expect(decodeCsv(new TextEncoder().encode('﻿email,name\na,b'))).toBe(
			'email,name\na,b',
		);
	});

	it('produces no phantom row for a trailing newline', () => {
		expect(parseCsv('a\n1\n', LIMITS).rows).toHaveLength(1);
		expect(parseCsv('a\n1', LIMITS).rows).toHaveLength(1);
	});

	it('reports a ragged row as read rather than padding or truncating it', () => {
		const document = parseCsv('a,b,c\n1,2\n1,2,3,4', LIMITS);
		expect(document.rows.map((row) => row.cells.length)).toEqual([2, 4]);
	});

	it('keeps an empty trailing field', () => {
		expect(parseCsv('a,b\n1,', LIMITS).rows[0]?.cells).toEqual(['1', '']);
	});

	it('trims header names but never data cells', () => {
		const document = parseCsv(' a , b \n 1 , 2 ', LIMITS);
		expect(document.header).toEqual(['a', 'b']);
		expect(document.rows[0]?.cells).toEqual([' 1 ', ' 2 ']);
	});

	it('refuses a file this reader cannot interpret', () => {
		expect(code(() => parseCsv('', LIMITS))).toBe('CSV_EMPTY');
		expect(code(() => parseCsv('a,,b\n1,2,3', LIMITS))).toBe(
			'CSV_HEADER_BLANK',
		);
		expect(code(() => parseCsv('a,a\n1,2', LIMITS))).toBe(
			'CSV_HEADER_DUPLICATE',
		);
		expect(code(() => parseCsv('a\n"never closed', LIMITS))).toBe(
			'CSV_QUOTE_UNTERMINATED',
		);
		expect(code(() => parseCsv('a\n"closed"then', LIMITS))).toBe(
			'CSV_QUOTE_UNEXPECTED',
		);
		expect(code(() => parseCsv('a\nopen"quote"', LIMITS))).toBe(
			'CSV_QUOTE_UNEXPECTED',
		);
	});

	it('refuses more data rows than the bound allows', () => {
		const text = ['a', '1', '2', '3'].join('\n');
		expect(code(() => parseCsv(text, { maxBytes: 1_000, maxRows: 2 }))).toBe(
			'CSV_TOO_MANY_ROWS',
		);
		expect(parseCsv(text, { maxBytes: 1_000, maxRows: 3 }).rows).toHaveLength(
			3,
		);
	});

	it('refuses bytes that are not UTF-8', () => {
		expect(code(() => decodeCsv(new Uint8Array([0xff, 0xfe, 0x00])))).toBe(
			'CSV_NOT_UTF8',
		);
	});

	it('stops reading a body the moment it passes the byte bound', async () => {
		const bytes = new TextEncoder().encode('a\n' + 'x'.repeat(4_000));
		await expect(readCsvBody(stream(bytes), 100)).rejects.toMatchObject({
			code: 'CSV_TOO_LARGE',
		});
	});

	/* The bound this guards is memory, not speed: a 25 MB job may not cost the
	   process hundreds of megabytes. What is measured is what a parse retains, so
	   one parse runs and is dropped first: the decoder's buffers, the compiled
	   code and the heap the runner grew to hold them belong to the process rather
	   than to the file, and only the second parse is inside the window.
	   `globalThis.gc` is used when the runner exposes it; without it the figure
	   still holds, because what an appending reader costs is retained by the cells
	   it answers with rather than dropped as garbage. */
	it('holds a large file near its own size rather than a multiple of it', () => {
		const text = syntheticCsv(5 * 1024 * 1024);
		/* ASCII, so one character is one byte of the file this stands for. */
		const inputBytes = text.length;
		const limits = { maxBytes: 32 * 1024 * 1024, maxRows: 200_000 };
		let warm: ReturnType<typeof parseCsv> | null = parseCsv(text, limits);
		expect(warm.rows.length).toBeGreaterThan(20_000);
		warm = null;
		globalThis.gc?.();
		const before = process.memoryUsage().heapUsed;

		const document = parseCsv(text, limits);

		globalThis.gc?.();
		const growth = process.memoryUsage().heapUsed - before;
		expect(document.header).toEqual(['email', 'displayName', 'role', 'note']);
		expect(document.rows.length).toBeGreaterThan(20_000);
		expect(document.rows[0]?.cells[1]).toBe(
			'Person Number 0 Of The Long Display Name Series',
		);
		expect(document.rows.at(-1)?.cells).toHaveLength(4);
		expect(growth).toBeLessThan(4 * inputBytes);
	});

	it('reads a whole document from a chunked body', async () => {
		const bytes = new TextEncoder().encode('﻿a,b\r\n"x,1",2\r\n');
		const document = await readCsv(stream(bytes), LIMITS);
		expect(document.header).toEqual(['a', 'b']);
		expect(document.rows[0]?.cells).toEqual(['x,1', '2']);
	});
});
