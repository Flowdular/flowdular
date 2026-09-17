import { describe, expect, it } from 'vitest';
import { shellFold, type ShellFoldInput } from '../src/shell/layout.ts';

const WIDE: ShellFoldInput = {
	narrow: false,
	compact: false,
	sidebarCollapsed: false,
	contextRailCollapsed: false,
	sidebarPeek: false,
	contextPeek: false,
};

describe('shell fold', () => {
	it('honors the stored preferences on a wide window', () => {
		expect(shellFold(WIDE)).toEqual({
			railed: false,
			sidebarOverlay: false,
			contextFolded: false,
			contextOverlay: false,
		});
		expect(
			shellFold({
				...WIDE,
				sidebarCollapsed: true,
				contextRailCollapsed: true,
			}),
		).toEqual({
			railed: true,
			sidebarOverlay: false,
			contextFolded: true,
			contextOverlay: false,
		});
	});

	it('ignores a peek left over from a narrow window', () => {
		expect(
			shellFold({ ...WIDE, sidebarPeek: true, contextPeek: true }),
		).toEqual(shellFold(WIDE));
	});

	it('folds the sidebar on a narrow window and opens it over the workspace', () => {
		const narrow = { ...WIDE, narrow: true };
		expect(shellFold(narrow)).toMatchObject({
			railed: true,
			sidebarOverlay: false,
			contextFolded: false,
		});
		expect(shellFold({ ...narrow, sidebarPeek: true })).toMatchObject({
			railed: false,
			sidebarOverlay: true,
		});
		/* A stored full sidebar does not push the content aside there. */
		expect(shellFold({ ...narrow, sidebarCollapsed: false }).railed).toBe(true);
	});

	it('folds the context rail to its strip on a compact window', () => {
		const compact = { ...WIDE, narrow: true, compact: true };
		expect(shellFold(compact)).toMatchObject({
			railed: true,
			contextFolded: true,
			contextOverlay: false,
		});
		expect(shellFold({ ...compact, contextPeek: true })).toMatchObject({
			contextFolded: false,
			contextOverlay: true,
		});
	});
});
