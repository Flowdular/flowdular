import { describe, expect, it } from 'vitest';
import { parseArguments } from '../src/arguments.ts';

describe('parseArguments', () => {
	it('separates commands and safety flags', () => {
		const parsed = parseArguments([
			'module',
			'new',
			'sales.orders',
			'--spec',
			'specs/orders.yaml',
			'--apply',
		]);
		expect(parsed.positionals).toEqual(['module', 'new', 'sales.orders']);
		expect(parsed.flags.get('spec')).toBe('specs/orders.yaml');
		expect(parsed.flags.get('apply')).toBe(true);
	});
});
