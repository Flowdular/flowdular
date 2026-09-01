import type {
	CreateExpensesClaimInput,
	ExpenseClaimDecision,
	ExpensesClaim,
} from '../domain/types.ts';
import type { ExpenseStatusFilter } from './expense-claims.ts';

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new Error(value.error?.message ?? 'The expenses operation failed.');
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
