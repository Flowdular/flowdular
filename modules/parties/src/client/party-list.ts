import type { Party } from '../domain/types.ts';
import { activeLocale } from '@coreloom/client/i18n';

export function filterParties(
	parties: readonly Party[],
	query: string,
	vatIdOnly: boolean,
	kind?: 'customer' | 'supplier',
	includeArchived = false,
): readonly Party[] {
	const locale = activeLocale();
	const term = query.trim().toLocaleLowerCase(locale);
	return parties.filter(
		(party) =>
			(!vatIdOnly || party.vatId !== null) &&
			(includeArchived || party.status === 'active') &&
			(kind === undefined || party.kind === kind || party.kind === 'both') &&
			(term === '' ||
				party.name.toLocaleLowerCase(locale).includes(term) ||
				(party.email ?? '').toLocaleLowerCase(locale).includes(term) ||
				(party.vatId ?? '').toLocaleLowerCase(locale).includes(term)),
	);
}
