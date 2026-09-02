export type PartyKind = 'customer' | 'supplier' | 'both';

export interface Party {
	readonly id: string;
	readonly tenantId: string;
	readonly name: string;
	readonly kind: PartyKind;
	readonly email: string | null;
	readonly phone: string | null;
	readonly vatId: string | null;
	readonly status: 'active' | 'archived';
	readonly createdAt: number;
}

export interface CreatePartyInput {
	readonly name: string;
	readonly kind: PartyKind;
	readonly email?: string | null;
	readonly phone?: string | null;
	readonly vatId?: string | null;
}

export interface UpdatePartyInput extends CreatePartyInput {
	readonly id: string;
}
