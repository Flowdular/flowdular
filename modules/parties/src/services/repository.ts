import type { Party } from '../domain/types.ts';

export interface PartyRepository {
	list(tenantId: string): readonly Party[];
	create(party: Party): Party;
}
