import type { VariableDefinition, VariableSource } from '@coreloom/contracts';

/* These values are entered in the same claim form. They have no external
   source and therefore no permission mask. The service resolves them only
   from the validated draft it is about to persist. */
export const EXPENSE_NOTE_VARIABLE_SOURCE: VariableSource = {
	id: 'expenses.claim-form',
	variables: [
		{
			key: 'expense.title',
			label: 'Expense title',
			kind: 'text',
			sample: 'Client dinner',
		},
		{ key: 'expense.amount', label: 'Amount', kind: 'money', sample: '42.50' },
		{
			key: 'expense.currency',
			label: 'Currency',
			kind: 'identifier',
			sample: 'EUR',
		},
		{
			key: 'expense.category',
			label: 'Category',
			kind: 'text',
			sample: 'meals',
		},
		{
			key: 'expense.date',
			label: 'Expense date',
			kind: 'date',
			sample: '2026-09-02',
		},
	],
};

export const EXPENSE_NOTE_VARIABLES: readonly VariableDefinition[] =
	EXPENSE_NOTE_VARIABLE_SOURCE.variables;
