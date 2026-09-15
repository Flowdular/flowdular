/* One id and a count keep the row one line; the full list is the title. */
export function dependentsSummary(
	dependents: readonly string[],
	t: (key: string, params?: Record<string, string>) => string,
	locale: string,
): string {
	const [first] = dependents;
	if (first === undefined) return '';
	return dependents.length === 1
		? first
		: t('system.table.dependentsMore', {
				first,
				count: new Intl.NumberFormat(locale).format(dependents.length - 1),
			});
}
