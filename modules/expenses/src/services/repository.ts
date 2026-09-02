import type { Actor, HistoryPage, HistoryQuery } from '@coreloom/kernel';
import type {
	ExpenseClaimHistoryAction,
	ExpenseClaimStatus,
	ExpensesClaim,
} from '../domain/types.ts';

export interface ExpenseClaimListQuery {
	readonly tenantId: string;
	readonly claimantId: string;
	readonly status: ExpenseClaimStatus | null;
	readonly includeApprovalQueue: boolean;
}

export interface ExpensesRepository {
	list(query: ExpenseClaimListQuery): readonly ExpensesClaim[];
	find(tenantId: string, id: string): ExpensesClaim | null;
	create(record: ExpensesClaim, actor: Actor): ExpensesClaim;
	update(
		record: ExpensesClaim,
		action: ExpenseClaimHistoryAction,
		actor: Actor,
	): ExpensesClaim;
	delete(tenantId: string, id: string, actor: Actor): boolean;
	countAwaitingApproval(tenantId: string): number;
	history(query: HistoryQuery): HistoryPage;
}
