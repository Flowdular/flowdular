import { describe, expect, it } from 'vitest';
import { workspaceHitRoute } from '../src/shell/navigation.ts';
import {
	nextPaletteIndex,
	paletteOptionId,
} from '../src/shell/palette-keys.ts';

describe('command palette selection', () => {
	it('moves down and up through the options and wraps at both ends', () => {
		expect(nextPaletteIndex(0, 3, 'ArrowDown')).toBe(1);
		expect(nextPaletteIndex(2, 3, 'ArrowDown')).toBe(0);
		expect(nextPaletteIndex(0, 3, 'ArrowUp')).toBe(2);
		expect(nextPaletteIndex(1, 3, 'ArrowUp')).toBe(0);
	});

	it('jumps to the ends with Home and End', () => {
		expect(nextPaletteIndex(2, 4, 'Home')).toBe(0);
		expect(nextPaletteIndex(1, 4, 'End')).toBe(3);
	});

	/* Every other key is the member typing, and the list stays where it is. */
	it('leaves the selection alone for a key it does not handle', () => {
		expect(nextPaletteIndex(2, 4, 'a')).toBe(2);
		expect(nextPaletteIndex(2, 4, 'Enter')).toBe(2);
	});

	/* The list is rebuilt on every keystroke, so a selection held from a longer
	   list must land inside the shorter one rather than on nothing. */
	it('keeps the selection inside a list that shrank, or at zero when empty', () => {
		expect(nextPaletteIndex(9, 3, 'ArrowDown')).toBe(0);
		expect(nextPaletteIndex(9, 3, 'ArrowUp')).toBe(1);
		expect(nextPaletteIndex(-1, 3, 'ArrowDown')).toBe(1);
		expect(nextPaletteIndex(2, 0, 'ArrowDown')).toBe(0);
	});

	it('names an option by its position, so the input can point at it', () => {
		expect(paletteOptionId(0)).toBe('command-option-0');
		expect(paletteOptionId(12)).not.toBe(paletteOptionId(1));
	});
});

describe('hit routes the shell will push', () => {
	it('keeps a workspace-relative path', () => {
		expect(workspaceHitRoute('/users?member=a1')).toBe('/users?member=a1');
		expect(workspaceHitRoute('/documents/42#preview')).toBe(
			'/documents/42#preview',
		);
	});

	/* The route comes from a module and is handed to history.pushState. A
	   protocol-relative path leaves the application, and a backslash becomes a
	   slash in the URL parser, so "/\\evil.example" leaves it too. */
	it('refuses anything that could leave the application', () => {
		expect(workspaceHitRoute('//evil.example')).toBeNull();
		expect(workspaceHitRoute('/\\evil.example')).toBeNull();
		expect(workspaceHitRoute('\\\\evil.example')).toBeNull();
		expect(workspaceHitRoute('https://evil.example')).toBeNull();
		expect(workspaceHitRoute('users')).toBeNull();
		expect(workspaceHitRoute('')).toBeNull();
	});
});
