/** The page a `Table` renders and a `Pagination` describes. */
export interface PageRange {
	/** Zero-based page index, clamped into the pages that exist. */
	readonly pageIndex: number;
	/** Number of pages; at least 1, so an empty set still reads "1 of 1". */
	readonly pageCount: number;
	/** One-based position of the first row on the page, 0 when there are none. */
	readonly from: number;
	/** One-based position of the last row on the page, 0 when there are none. */
	readonly to: number;
	readonly totalRows: number;
}

/** The page a keyset pager describes, over a set nobody counted. */
export interface KeysetPage {
	/** Zero-based index of the page on screen. */
	readonly pageIndex: number;
	readonly pageSize: number;
	/** One-based position of the first row on the page. */
	readonly from: number;
	/** Whether a page follows this one. */
	readonly hasMore: boolean;
}

function whole(value: number, minimum: number): number {
	return Number.isFinite(value)
		? Math.max(minimum, Math.trunc(value))
		: minimum;
}

/**
 * Page arithmetic shared by `Table` (which slices the rows) and `Pagination`
 * (which labels them), so the two can never disagree about which page is on
 * screen. Out-of-range input is clamped rather than refused: a page index
 * survives a row set that shrinks under it.
 */
export function pageRange(
	totalRows: number,
	pageSize: number,
	pageIndex: number,
): PageRange {
	const rows = whole(totalRows, 0);
	const size = whole(pageSize, 1);
	const pageCount = Math.max(1, Math.ceil(rows / size));
	const index = Math.min(whole(pageIndex, 0), pageCount - 1);
	return {
		pageIndex: index,
		pageCount,
		from: rows === 0 ? 0 : index * size + 1,
		to: Math.min(rows, (index + 1) * size),
		totalRows: rows,
	};
}

/**
 * The same arithmetic over a page nobody counted. There is no page count to
 * clamp against, so the index the screen holds stands and `hasMore` is all that
 * is known about what follows it.
 */
export function keysetPage(
	pageIndex: number,
	pageSize: number,
	hasMore: boolean,
): KeysetPage {
	const index = whole(pageIndex, 0);
	const size = whole(pageSize, 1);
	return { pageIndex: index, pageSize: size, from: index * size + 1, hasMore };
}
