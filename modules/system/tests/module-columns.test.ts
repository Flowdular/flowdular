import { describe, expect, it } from 'vitest';
import { dependentsSummary } from '../src/client/module-dependents.ts';

const t = (key: string, params?: Record<string, string>) =>
	key === 'system.table.dependentsMore'
		? `${params?.first} and ${params?.count} more`
		: key;

describe('module dependents cell', () => {
	it('shows one id alone, and the first id with a count otherwise', () => {
		expect(dependentsSummary([], t, 'en')).toBe('');
		expect(dependentsSummary(['import.core'], t, 'en')).toBe('import.core');
		expect(
			dependentsSummary(['access.core', 'agents.core', 'audit.core'], t, 'en'),
		).toBe('access.core and 2 more');
	});
});
