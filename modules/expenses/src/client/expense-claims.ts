import type {
	ExpenseClaimCategory,
	ExpenseClaimStatus,
} from '../domain/types.ts';
import { activeLocale, t } from '@coreloom/client/i18n';

export type ExpenseStatusFilter = 'all' | ExpenseClaimStatus;
export type ExpenseStatusTone = 'neutral' | 'success' | 'warning' | 'danger';

export function amountToMinorUnits(value: string): number | null {
	const normalized = value.trim();
	if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
	const [whole, fraction = ''] = normalized.split('.');
	const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
	return Number.isSafeInteger(amount) ? amount : null;
}

export function formatExpenseAmount(
	amountMinor: number,
	currency: string,
): string {
	try {
		return new Intl.NumberFormat(activeLocale(), {
			style: 'currency',
			currency,
		}).format(amountMinor / 100);
	} catch {
		return (
			new Intl.NumberFormat(activeLocale(), {
				minimumFractionDigits: 2,
				maximumFractionDigits: 2,
			}).format(amountMinor / 100) +
			' ' +
			currency
		);
	}
}

export function expenseStatusLabel(status: ExpenseClaimStatus): string {
	return t('expenses.status.' + status);
}

export function expenseStatusTone(
	status: ExpenseClaimStatus,
): ExpenseStatusTone {
	switch (status) {
		case 'submitted':
			return 'warning';
		case 'approved':
			return 'success';
		case 'rejected':
			return 'danger';
		default:
			return 'neutral';
	}
}

export function expenseCategoryLabel(category: ExpenseClaimCategory): string {
	return t('expenses.category.' + category);
}

/* The action column follows capability, not the records in the current
   filter, so changing status filters cannot resize the table. */
export function showsExpenseActionColumn(
	canManage: boolean,
	canApprove: boolean,
): boolean {
	return canManage || canApprove;
}
