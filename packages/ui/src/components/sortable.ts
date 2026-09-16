export function clampIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return Math.min(Math.max(index, 0), length - 1);
}

/** A copy of `list` with the entry at `from` moved to `to`, clamped into the list. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
	const next = [...list];
	if (from < 0 || from >= next.length) return next;
	const [entry] = next.splice(from, 1);
	next.splice(clampIndex(to, list.length), 0, entry as T);
	return next;
}

/**
 * Where a pointer at `y` would insert among items whose vertical midpoints
 * are `midpoints`, in list order: 0 before the first item, `midpoints.length`
 * after the last.
 */
export function insertionIndex(
	midpoints: readonly number[],
	y: number,
): number {
	let index = 0;
	while (index < midpoints.length && y > (midpoints[index] as number)) {
		index += 1;
	}
	return index;
}

/** The index the dragged item ends at when it is inserted at `insertion`. */
export function droppedIndex(from: number, insertion: number): number {
	return insertion > from ? insertion - 1 : insertion;
}

export function sameOrder(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}
