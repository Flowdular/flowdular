/* One selector for every modal surface. `tabindex` is read from the property
   rather than the attribute, so a control that opted out with -1 is skipped
   without a second query. */
const FOCUSABLE =
	'a[href], area[href], button, input, select, textarea, summary, [tabindex]';

function focusable(element: HTMLElement): boolean {
	if (element.hasAttribute('hidden') || element.tabIndex < 0) return false;
	const disabled = (element as { disabled?: boolean }).disabled;
	return disabled !== true;
}

/**
 * Everything inside `root` that Tab can reach, in document order. Visibility is
 * not consulted: a modal panel renders only what it shows, and a layout read
 * per keystroke would cost a reflow for an answer the markup already gives.
 */
export function focusableElements(root: HTMLElement): readonly HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(focusable);
}

/**
 * Holds Tab inside `root` until the returned release is called, which also
 * returns focus to whatever held it when the trap opened. Focus moves into
 * `root` only when nothing inside it is focused already, so a control that
 * carries `autoFocus` keeps it.
 *
 * `root` needs `tabindex="-1"` so the panel itself can hold focus while it has
 * no focusable child.
 */
export function trapFocus(root: HTMLElement): () => void {
	const opener = document.activeElement as HTMLElement | null;
	if (!root.contains(document.activeElement))
		(focusableElements(root)[0] ?? root).focus();
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key !== 'Tab' || event.defaultPrevented) return;
		const stops = focusableElements(root);
		const active = document.activeElement as HTMLElement | null;
		const first = stops[0];
		const last = stops[stops.length - 1];
		if (first === undefined || last === undefined) {
			event.preventDefault();
			root.focus();
			return;
		}
		/* Focus left the panel (a click on the page behind it, a browser chrome
	   stop): the next Tab walks back in rather than through the workspace. */
		if (active === null || !root.contains(active)) {
			event.preventDefault();
			(event.shiftKey ? last : first).focus();
			return;
		}
		if (event.shiftKey ? active !== first : active !== last) return;
		event.preventDefault();
		(event.shiftKey ? last : first).focus();
	};
	document.addEventListener('keydown', onKeyDown, true);
	return () => {
		document.removeEventListener('keydown', onKeyDown, true);
		if (opener !== null && opener.isConnected) opener.focus();
	};
}
