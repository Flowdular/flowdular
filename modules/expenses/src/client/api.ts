import type {
	CreateExpensesClaimInput,
	ExpenseClaimDecision,
	ExpensesClaim,
} from '../domain/types.ts';
import { t } from '@coreloom/client/i18n';
import type { HistoryPage } from '@coreloom/kernel';
import type { ExpenseStatusFilter } from './expense-claims.ts';

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new Error(value.error?.message ?? t('expenses.error.request'));
	}
	return value;
}

export async function loadExpensesClaims(
	status: ExpenseStatusFilter,
): Promise<readonly ExpensesClaim[]> {
	const query = status === 'all' ? '' : `?status=${encodeURIComponent(status)}`;
	const response = await fetch(`/api/expenses/claims${query}`, {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return (
		await payload<{ readonly claims: readonly ExpensesClaim[] }>(response)
	).claims;
}

export async function loadAwaitingApprovalCount(): Promise<number> {
	const response = await fetch('/api/expenses/claims/awaiting-approval-count', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return (await payload<{ readonly count: number }>(response)).count;
}

export async function loadExpenseClaimHistory(
	recordId: string,
): Promise<HistoryPage> {
	const response = await fetch(
		`/api/expenses/claims/history?recordId=${encodeURIComponent(recordId)}&limit=100`,
		{
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
		},
	);
	return payload<HistoryPage>(response);
}

async function mutateClaim(
	path: string,
	body: unknown,
	csrfToken: string,
): Promise<ExpensesClaim> {
	const response = await fetch(path, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify(body),
	});
	return (await payload<{ readonly claim: ExpensesClaim }>(response)).claim;
}

export function createExpensesClaim(
	input: CreateExpensesClaimInput,
	csrfToken: string,
): Promise<ExpensesClaim> {
	return mutateClaim('/api/expenses/claims', input, csrfToken);
}

export function submitExpensesClaim(
	claimId: string,
	csrfToken: string,
): Promise<ExpensesClaim> {
	return mutateClaim('/api/expenses/claims/submit', { claimId }, csrfToken);
}

export async function deleteExpensesClaim(
	claimId: string,
	csrfToken: string,
): Promise<void> {
	const response = await fetch('/api/expenses/claims/delete', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify({ claimId }),
	});
	await payload<{ readonly deleted: true }>(response);
}

export function decideExpensesClaim(
	claimId: string,
	decision: ExpenseClaimDecision,
	comment: string,
	csrfToken: string,
): Promise<ExpensesClaim> {
	return mutateClaim(
		`/api/expenses/claims/${decision === 'approved' ? 'approve' : 'reject'}`,
		{ claimId, comment },
		csrfToken,
	);
}
