import type { DashboardRow, WorkUsage } from '../server/dashboard.ts';

export function filterWork(
	rows: readonly DashboardRow[],
	query: string,
	status: string,
	archived: boolean,
	locale: string,
): readonly DashboardRow[] {
	const term = query.trim().toLocaleLowerCase(locale);
	return rows.filter(
		(row) =>
			(!status || row.status === status) &&
			(archived || status === 'archived' || row.status !== 'archived') &&
			(!term ||
				[
					row.session.title,
					row.session.brief,
					...row.session.modules.map((module) => module.id),
				].some((value) => value.toLocaleLowerCase(locale).includes(term))),
	);
}

export function formatTokens(usage: WorkUsage, locale: string): string {
	if (!usage.reportedTurns && usage.missingUsage) return '?';
	return (
		new Intl.NumberFormat(locale).format(usage.totalTokens) +
		(usage.missingUsage ? ' +' : '')
	);
}

export function formatCost(usage: WorkUsage, locale: string): string {
	if (
		!usage.pricedTurns &&
		(usage.unpricedTurns || usage.reportedTurns || usage.missingUsage)
	)
		return '?';
	return (
		new Intl.NumberFormat(locale, {
			style: 'currency',
			currency: 'USD',
			minimumFractionDigits: 2,
			maximumFractionDigits: 4,
		}).format(usage.knownCostUsd) + (usage.unpricedTurns ? ' +' : '')
	);
}
