/** One sorted column, named by the Flowdular `TableColumn.key`. */
export interface TableSort {
	readonly key: string;
	readonly desc: boolean;
}

export type TableSortChange = (sorts: readonly TableSort[]) => void;

/* One collator for every table: constructing an Intl.Collator costs far more
   than a comparison, and sorting n rows calls compare O(n log n) times. The
   locale is the host locale, so a value that must follow another collation is
   normalised by the column's own `value` function. */
const COLLATOR = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: 'base',
});

function isBlank(value: unknown): boolean {
	return value === null || value === undefined || value === '';
}

/**
 * Orders two cell values of one column. Numbers and booleans compare by
 * magnitude, everything else through the host collator, so 'Łucja' lands where
 * the reader expects it. Blank values sort last in ascending order.
 */
export function compareCellValues(left: unknown, right: unknown): number {
	if (isBlank(left) || isBlank(right)) {
		if (isBlank(left) && isBlank(right)) return 0;
		return isBlank(left) ? 1 : -1;
	}
	if (typeof left === 'number' && typeof right === 'number')
		return left < right ? -1 : left > right ? 1 : 0;
	if (typeof left === 'boolean' && typeof right === 'boolean')
		return left === right ? 0 : left ? 1 : -1;
	return COLLATOR.compare(String(left), String(right));
}

/**
 * Stable identity of a sorting state. A controlled `Table` rebuilds the array
 * it hands to the table engine only when this changes, so an unchanged sort
 * never writes the engine's state atom during render.
 */
export function sortingSignature(sorts: readonly TableSort[]): string {
	let signature = '';
	for (const sort of sorts)
		signature += `${sort.key}:${sort.desc ? 'desc' : 'asc'},`;
	return signature;
}
