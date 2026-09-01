import type {
	ExpenseClaimCategory,
	ExpenseClaimStatus,
} from '../domain/types.ts';

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
		return new Intl.NumberFormat('en', {
			style: 'currency',
			currency,
		}).format(amountMinor / 100);
	} catch {
		return `${(amountMinor / 100).toFixed(2)} ${currency}`;
	}
}

export function expenseStatusLabel(status: ExpenseClaimStatus): string {
	return status.charAt(0).toUpperCase() + status.slice(1);
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
	return category.charAt(0).toUpperCase() + category.slice(1);
}
