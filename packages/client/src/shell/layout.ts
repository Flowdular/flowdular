/* Below these widths the shell stops honoring the stored sidebar and context
   rail preference: both start folded and open over the workspace instead of
   beside it, so the content keeps its width. The mobile layout starts at 760px
   (shell.css). */
export const SHELL_NARROW_QUERY = '(min-width: 761px) and (max-width: 1199px)';
export const SHELL_COMPACT_QUERY = '(min-width: 761px) and (max-width: 959px)';

export interface ShellFoldInput {
	/** The window matches `SHELL_NARROW_QUERY`. */
	readonly narrow: boolean;
	/** The window matches `SHELL_COMPACT_QUERY`. */
	readonly compact: boolean;
	/** The stored preferences, honored on a wide window. */
	readonly sidebarCollapsed: boolean;
	readonly contextRailCollapsed: boolean;
	/** Opened over the workspace for the moment; never stored. */
	readonly sidebarPeek: boolean;
	readonly contextPeek: boolean;
}

export interface ShellFold {
	/** The sidebar shows as the icon rail. */
	readonly railed: boolean;
	/** The full sidebar lies over the workspace, which keeps the rail's margin. */
	readonly sidebarOverlay: boolean;
	/** The context rail shows as its strip. */
	readonly contextFolded: boolean;
	/** The full context rail lies over the workspace, which keeps the strip's margin. */
	readonly contextOverlay: boolean;
}

export function shellFold(input: ShellFoldInput): ShellFold {
	const sidebarOverlay = input.narrow && input.sidebarPeek;
	const contextOverlay = input.compact && input.contextPeek;
	return {
		railed: input.narrow ? !input.sidebarPeek : input.sidebarCollapsed,
		sidebarOverlay,
		contextFolded: input.compact
			? !input.contextPeek
			: input.contextRailCollapsed,
		contextOverlay,
	};
}
