import { CSV_BOM } from './csv.ts';
import {
	ListExportError,
	LIST_EXPORT_PAGE_LIMIT,
	type DefinedListExport,
	type ListExportPrincipal,
} from './definition.ts';

/**
 * Rows and bytes one export may produce. Both are the caller's policy, read
 * from its own settings; the driver only enforces them.
 */
export interface ListExportBounds {
	readonly maxRows: number;
	readonly maxBytes: number;
	/** Rows per page; clamped to 1 up to the platform list ceiling. */
	readonly pageLimit?: number | undefined;
}

export interface ListExportRunOptions {
	readonly definition: DefinedListExport;
	/** The requester, as the list's own endpoint would have seen them. */
	readonly principal: ListExportPrincipal;
	readonly bounds: ListExportBounds;
	/** Aborted when the job's claim changes hands; the walk stops unsettled. */
	readonly signal?: AbortSignal | undefined;
}

export interface ListExportResult {
	readonly rows: number;
	readonly bytes: number;
	readonly body: Uint8Array;
	/** Pages the walk read, for a trace that wants the shape of the work. */
	readonly pages: number;
}

function bound(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`A list export ${label} must be a positive whole number.`);
	}
	return value;
}

/**
 * Walks a list through its own `page` and writes the CSV, bounded by rows and
 * by bytes. Neither bound truncates: an export that would cross one is refused
 * with a stable code, because half a file that looks whole is worse than none.
 *
 * The whole file is held before it is handed on, so peak memory is a small
 * multiple of `maxBytes`. That is the storage port's shape too: it
 * authenticates a whole object before writing it, so a streaming writer here
 * would only move the buffer, not remove it.
 */
export async function runListExport(
	options: ListExportRunOptions,
): Promise<ListExportResult> {
	const maxRows = bound(options.bounds.maxRows, 'maxRows');
	const maxBytes = bound(options.bounds.maxBytes, 'maxBytes');
	const requested = options.bounds.pageLimit ?? LIST_EXPORT_PAGE_LIMIT;
	const limit = Math.min(
		LIST_EXPORT_PAGE_LIMIT,
		Math.max(1, Math.trunc(requested)),
	);
	const definition = options.definition;

	const chunks: Buffer[] = [];
	let bytes = 0;
	let rows = 0;
	let pages = 0;
	let cursor: string | null = null;

	const head = Buffer.from(CSV_BOM + definition.header, 'utf8');
	bytes = head.byteLength;
	if (bytes > maxBytes) throw exceededBytes(definition.id, maxBytes);
	chunks.push(head);

	for (;;) {
		options.signal?.throwIfAborted();
		/* One row past what is left, so a list that fills the bound exactly still
		   completes and the first row over it is seen without reading a page the
		   export could never have used. */
		const page = await definition.page(
			options.principal,
			cursor,
			Math.min(limit, maxRows - rows + 1),
		);
		pages += 1;
		if (rows + page.rows > maxRows) {
			throw new ListExportError(
				'EXPORT_ROWS_EXCEEDED',
				`The export of ${definition.id} is longer than ${maxRows} rows; narrow the list first.`,
			);
		}
		let pending = '';
		for (const record of page.records) {
			/* Counted before it is joined, so the string this page builds is bounded
			   by what is left of the byte budget rather than by the list. */
			bytes += Buffer.byteLength(record, 'utf8');
			if (bytes > maxBytes) throw exceededBytes(definition.id, maxBytes);
			pending += record;
		}
		if (pending !== '') chunks.push(Buffer.from(pending, 'utf8'));
		rows += page.rows;
		cursor = page.nextCursor;
		if (cursor === null) break;
	}

	return { rows, bytes, pages, body: Buffer.concat(chunks, bytes) };
}

function exceededBytes(id: string, maxBytes: number): ListExportError {
	return new ListExportError(
		'EXPORT_BYTES_EXCEEDED',
		`The export of ${id} is larger than ${maxBytes} bytes; narrow the list first.`,
	);
}
