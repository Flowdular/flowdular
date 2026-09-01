import { cell, createStore } from 'segment-state';
import type { ExpenseClaimDecision, ExpensesClaim } from '../domain/types.ts';
import type { ExpenseStatusFilter } from './expense-claims.ts';

export function createExpensesClientState() {
	const store = createStore({
		claims: cell<readonly ExpensesClaim[]>([]),
		statusFilter: cell<ExpenseStatusFilter>('all'),
		formOpen: false,
		formSession: 0,
		formError: '',
		decisionOpen: false,
		decisionSession: 0,
		decisionClaim: cell<ExpensesClaim | null>(null),
		decision: cell<ExpenseClaimDecision>('approved'),
		decisionError: '',
		status: cell<'idle' | 'loading' | 'submitting' | 'deciding'>('idle'),
		error: '',
	});
	return { store, state: store.state };
}

export function createExpensesDashboardState() {
	const store = createStore({
		count: 0,
		status: cell<'idle' | 'loading'>('idle'),
		error: '',
	});
	return { store, state: store.state };
}
