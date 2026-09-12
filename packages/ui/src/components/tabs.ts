export interface TabItem {
	readonly id: string;
	readonly label: string;
	readonly disabled?: boolean | undefined;
}

const STEPS: Readonly<Record<string, number>> = {
	ArrowRight: 1,
	ArrowLeft: -1,
};

function firstEnabled(
	items: readonly TabItem[],
	from: number,
	step: number,
): string {
	for (let index = from; index >= 0 && index < items.length; index += step) {
		const item = items[index];
		if (item && item.disabled !== true) return item.id;
	}
	return '';
}

/**
 * The tab that carries selection and the tab order. A screen whose `active`
 * names a tab that is disabled or no longer in `items` still leaves exactly one
 * tab reachable, because the list falls back to the first enabled tab rather
 * than dropping out of the tab order.
 */
export function activeTabId(items: readonly TabItem[], active: string): string {
	const current = items.find((item) => item.id === active);
	if (current && current.disabled !== true) return current.id;
	return firstEnabled(items, 0, 1);
}

/**
 * The tab a tablist key moves focus to: arrows step over disabled tabs and
 * wrap at both ends, Home and End jump to the outer enabled tab. Returns ''
 * when the key belongs to the page rather than the tablist, so the caller
 * leaves the event alone.
 */
export function nextTabId(
	items: readonly TabItem[],
	active: string,
	key: string,
): string {
	if (items.length === 0) return '';
	if (key === 'Home') return firstEnabled(items, 0, 1);
	if (key === 'End') return firstEnabled(items, items.length - 1, -1);
	const step = STEPS[key];
	if (step === undefined) return '';
	const current = items.findIndex((item) => item.id === active);
	const start = current === -1 ? 0 : current;
	for (let offset = 1; offset <= items.length; offset += 1) {
		const index =
			(((start + step * offset) % items.length) + items.length) % items.length;
		const item = items[index];
		if (item && item.disabled !== true) return item.id;
	}
	return '';
}
