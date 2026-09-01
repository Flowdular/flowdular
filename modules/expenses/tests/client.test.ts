import { describe, expect, it } from 'vitest';
import {
	amountToMinorUnits,
	expenseCategoryLabel,
	expenseStatusLabel,
	expenseStatusTone,
	formatExpenseAmount,
} from '../src/client/expense-claims.ts';

describe('expense claim client helpers', () => {
	it.each([
		['0', 0],
		['1', 100],
		['12.5', 1_250],
		['12.50', 1_250],
		[' 19.99 ', 1_999],
	])('converts %s to minor units', (value, expected) => {
		expect(amountToMinorUnits(value)).toBe(expected);
	});

	it.each(['', '-1', '1.001', 'value', '1,50'])(
		'rejects invalid amount %s',
		(value) => {
			expect(amountToMinorUnits(value)).toBeNull();
		},
	);

	it('formats amount, category, and status display values', () => {
		expect(formatExpenseAmount(1_250, 'EUR')).toMatch(/12[.,]50/);
		expect(expenseCategoryLabel('equipment')).toBe('Equipment');
		expect(expenseStatusLabel('submitted')).toBe('Submitted');
		expect(expenseStatusTone('submitted')).toBe('warning');
		expect(expenseStatusTone('approved')).toBe('success');
		expect(expenseStatusTone('rejected')).toBe('danger');
		expect(expenseStatusTone('draft')).toBe('neutral');
	});
});
