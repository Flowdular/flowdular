import { describe, expect, it } from 'vitest';
import { authScreenFromUrl } from '../src/client/state.ts';

describe('authentication routes', () => {
	it('selects sign-up only for the explicit sign-up route', () => {
		expect(authScreenFromUrl('/sign-up')).toBe('sign-up');
		expect(authScreenFromUrl('/')).toBe('sign-in');
		expect(authScreenFromUrl('/sign-in')).toBe('sign-in');
	});
});
