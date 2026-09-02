import type { Actor, HistoryPage, HistoryQuery } from '@coreloom/kernel';
import type { Party, UpdatePartyInput } from '../domain/types.ts';
import type { TargetIdempotencyRequest } from './target-idempotency.ts';

export interface PartyRepository {
	list(tenantId: string): readonly Party[];
	create(party: Party, actor: Actor): Party;
	createIdempotent(
		party: Party,
		actor: Actor,
		idempotency: TargetIdempotencyRequest,
	): Party;
	update(tenantId: string, input: UpdatePartyInput, actor: Actor): Party | null;
	setStatus(
		tenantId: string,
		id: string,
		status: Party['status'],
		actor: Actor,
	): Party | null;
	delete(tenantId: string, id: string, actor: Actor): boolean;
	history(query: HistoryQuery): HistoryPage;
}
