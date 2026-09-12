type CommandPaletteListener = (query: string) => void;

/* One workspace shell subscribes at a time; the set exists so a widget in a
   module can reach the palette without the shell exporting its state. */
const listeners = new Set<CommandPaletteListener>();

/**
 * Opens the workspace command palette, optionally seeded with a query. Safe to
 * call before the shell is mounted: with no listener it does nothing.
 */
export function openCommandPalette(query = ''): void {
	for (const listener of [...listeners]) {
		try {
			listener(query);
		} catch {
			/* A listener is the shell's own; a throw must not reach the widget
			   that asked, which has nothing to do about it. */
		}
	}
}

/** Subscribes the shell. The returned function detaches it. */
export function onOpenCommandPalette(
	listener: CommandPaletteListener,
): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
