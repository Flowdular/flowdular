/**
 * The palette lists navigation entries and record hits as one sequence, and
 * the member moves through it with the arrow keys while focus stays in the
 * input. The active option is named by id rather than focused, so typing is
 * never interrupted by focus moving to a button.
 */
export function paletteOptionId(index: number): string {
	return 'command-option-' + String(index);
}

/**
 * The option an arrow, Home or End key selects. Selection wraps at both ends,
 * and a key this list does not handle leaves it where it was.
 */
export function nextPaletteIndex(
	current: number,
	count: number,
	key: string,
): number {
	if (count <= 0) return 0;
	const index = Math.min(Math.max(current, 0), count - 1);
	if (key === 'ArrowDown') return (index + 1) % count;
	if (key === 'ArrowUp') return (index - 1 + count) % count;
	if (key === 'Home') return 0;
	if (key === 'End') return count - 1;
	return index;
}
