import type { ExpenseClaimStatus, ExpensesClaim } from '../domain/types.ts';

export interface ExpenseClaimListQuery {
	readonly tenantId: string;
	readonly claimantId: string;
	readonly status: ExpenseClaimStatus | null;
	readonly includeApprovalQueue: boolean;
}

export interface ExpensesRepository {
	list(query: ExpenseClaimListQuery): readonly ExpensesClaim[];
	find(tenantId: string, id: string): ExpensesClaim | null;
	create(record: ExpensesClaim): ExpensesClaim;
	update(record: ExpensesClaim): ExpensesClaim;
	countAwaitingApproval(tenantId: string): number;
}
