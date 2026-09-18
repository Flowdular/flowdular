import { describe, expect, it } from 'vitest';
import { ICON_PATHS } from '../src/icons/Icon.tsrx';

/* A name the set does not carry renders the modules glyph, so a typo or a
   removed path shows up as the wrong picture rather than as an error. */
describe('icon set', () => {
	it('draws every name the shell asks for', () => {
		for (const name of ['sparkle', 'lock', 'message', 'x', 'check']) {
			expect(typeof ICON_PATHS[name], name).toBe('string');
			if (name !== 'modules') {
				expect(ICON_PATHS[name], name).not.toBe(ICON_PATHS.modules);
			}
		}
	});
});
